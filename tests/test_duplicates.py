import hashlib
import os
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class DuplicateMediaTest(AppCase):
    def test_finished_files_backfill_and_compare_complete_bytes(self):
        first = self.finished_file('first001', 'first.mp4', b'same bytes')
        self.finished_file('second01', 'second.mp4', b'same bytes')
        self.finished_file('third001', 'third.mp4', b'different')
        self.assertEqual(
            self.client.get('/api/duplicates').get_json()['pending_count'], 3
        )

        vdl._hash_backfill_once()
        result = self.client.get('/api/duplicates').get_json()
        self.assertEqual(result['pending_count'], 0)
        self.assertEqual(result['unavailable_count'], 0)
        self.assertEqual(len(result['groups']), 1)
        group = result['groups'][0]
        self.assertEqual(group['byte_size'], len(b'same bytes'))
        self.assertEqual(group['item_count'], 2)
        self.assertEqual(
            {item['id'] for item in group['items']},
            {'first001', 'second01'},
        )
        self.assertTrue(all(not item['filename'].startswith(self.download_dir)
                            for item in group['items']))
        with vdl.db() as conn:
            row = conn.execute(
                "SELECT digest, byte_size, state FROM media_hashes "
                "WHERE download_id = 'first001'"
            ).fetchone()
        self.assertEqual(row['digest'], hashlib.sha256(b'same bytes').hexdigest())
        self.assertEqual(row['byte_size'], os.path.getsize(first))
        self.assertEqual(row['state'], 'ready')

    def test_digest_collision_still_requires_equal_bytes(self):
        self.finished_file('first001', 'a.mp4', b'alpha')
        self.finished_file('second01', 'b.mp4', b'bravo')
        vdl._hash_backfill_once()
        with vdl._db_lock, vdl.db() as conn:
            conn.execute(
                "UPDATE media_hashes SET digest = "
                "(SELECT digest FROM media_hashes WHERE download_id='first001') "
                "WHERE download_id='second01'"
            )
        self.assertEqual(self.client.get('/api/duplicates').get_json()['groups'], [])

    def test_changed_or_missing_file_leaves_confirmed_group(self):
        first = self.finished_file('first001', 'a.mp4', b'same')
        second = self.finished_file('second01', 'b.mp4', b'same')
        vdl._hash_backfill_once()
        with open(first, 'wb') as output:
            output.write(b'edited')
        result = self.client.get('/api/duplicates').get_json()
        self.assertEqual(result['groups'], [])
        self.assertEqual(result['pending_count'], 1)
        vdl._hash_backfill_once()
        os.remove(second)
        result = self.client.get('/api/duplicates').get_json()
        self.assertEqual(result['groups'], [])
        self.assertEqual(result['unavailable_count'], 1)
        self.assertEqual(vdl.db_get_download('second01')['status'], 'finished')

    def test_unreadable_or_disallowed_file_remains_unindexed(self):
        path = self.finished_file('first001')
        with mock.patch.object(vdl, '_hash_final_file', side_effect=OSError('read')):
            vdl._hash_backfill_once()
        self.assertEqual(vdl.db_get_download('first001')['status'], 'finished')
        self.assertEqual(
            self.client.get('/api/duplicates').get_json()['unavailable_count'], 1
        )
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("UPDATE media_hashes SET state='pending' WHERE download_id='first001'")
        with mock.patch.object(vdl, '_is_allowed_download_path', return_value=False):
            vdl._hash_backfill_once()
        self.assertTrue(os.path.exists(path))
        self.assertEqual(
            self.client.get('/api/duplicates').get_json()['unavailable_count'], 1
        )

    def test_unavailable_hash_retries_once_when_worker_restarts(self):
        self.finished_file('first001', 'a.mp4', b'data')
        with mock.patch.object(vdl, '_hash_final_file', side_effect=OSError('busy')) as hash_file:
            vdl._hash_backfill_once()
            vdl._hash_backfill_once()
        hash_file.assert_called_once()
        self.assertEqual(
            self.client.get('/api/duplicates').get_json()['unavailable_count'], 1
        )
        vdl._requeue_unavailable_hashes()
        vdl._hash_backfill_once()
        with vdl.db() as conn:
            state = conn.execute(
                "SELECT state FROM media_hashes WHERE download_id='first001'"
            ).fetchone()[0]
        self.assertEqual(state, 'ready')

    def test_group_is_omitted_if_member_changes_during_confirmation(self):
        self.finished_file('first001', 'a.mp4', b'same')
        self.finished_file('second01', 'b.mp4', b'same')
        representative = self.finished_file('third001', 'c.mp4', b'same')
        vdl._hash_backfill_once()
        compare = vdl._files_match
        calls = 0

        def change_after_first_match(left, right, size):
            nonlocal calls
            calls += 1
            same = compare(left, right, size)
            if calls == 1:
                with open(representative, 'wb') as output:
                    output.write(b'edited')
            return same

        with mock.patch.object(vdl, '_files_match', side_effect=change_after_first_match):
            result = self.client.get('/api/duplicates').get_json()
        self.assertEqual(result['groups'], [])
        self.assertGreaterEqual(result['pending_count'], 1)

    def test_visibility_applies_before_grouping_or_counts(self):
        alice = vdl.db_create_user('alice', 'alice-password', 'normal')
        bob = vdl.db_create_user('bob', 'bob-password', 'normal')
        clients = (
            self.authenticated_client('alice', 'alice-password'),
            self.authenticated_client('bob', 'bob-password'),
        )
        for download_id, owner in (('first001', alice), ('second01', bob)):
            vdl.db_insert_download(
                download_id, 'https://fixture.invalid/video',
                owner['id'], owner['username'],
            )
            self.finished_file(download_id, download_id + '.mp4', b'same')
        vdl.db_set_download_visibility('second01', 'private')
        vdl._hash_backfill_once()
        self.assertEqual(len(clients[0].get('/api/duplicates').get_json()['groups']), 0)
        self.assertEqual(len(clients[1].get('/api/duplicates').get_json()['groups']), 1)
        self.assertEqual(len(self.client.get('/api/duplicates').get_json()['groups']), 1)

    def test_mounted_import_has_unique_internal_name_and_atomic_hash(self):
        inbox = os.path.join(self.temp_dir.name, 'inbox')
        os.mkdir(inbox)
        source = os.path.join(inbox, 'film.mp4')
        with open(source, 'wb') as output:
            output.write(b'final video')
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value='720p'):
            download_id = vdl._ingest_watched_file(
                source, vdl._source_signature(source)
            )
        row = vdl.db_get_download(download_id)
        self.assertRegex(os.path.basename(row['filename']),
                         r'^film--[0-9a-f]{12}\.mp4$')
        self.assertEqual(row['display_filename'], 'film.mp4')
        self.assertEqual(row['requested_filename'], 'film.mp4')
        with vdl.db() as conn:
            hash_row = conn.execute(
                'SELECT state, digest FROM media_hashes WHERE download_id=?',
                (download_id,),
            ).fetchone()
        self.assertEqual(hash_row['state'], 'ready')
        self.assertEqual(hash_row['digest'], hashlib.sha256(b'final video').hexdigest())
        history = self.client.get('/api/library').get_json()[0]
        self.assertEqual(history['filename'], 'film.mp4')
        self.assertTrue(history['mounted_import'])
        self.assertNotIn(self.download_dir, str(history))
        attachment = self.client.get(f'/api/file/{download_id}?download=1')
        self.assertIn('film.mp4', attachment.headers['Content-Disposition'])
        attachment.close()

        renamed = self.client.post(
            f'/api/rename/{download_id}', json={'filename': 'renamed.webm'}
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(vdl.db_get_download(download_id)['filename'], row['filename'])
        self.assertEqual(vdl.db_get_download(download_id)['display_filename'],
                         'renamed.mp4')
        renamed_attachment = self.client.get(
            f'/api/file/{download_id}?download=1'
        )
        self.assertEqual(
            renamed_attachment.headers['Content-Disposition'].split('filename=')[1],
            'renamed.mp4',
        )
        renamed_attachment.close()

    def test_atomic_mounted_registration_rolls_back_on_invalid_tag(self):
        filename = self.finished_file('source01', 'source.mp4', b'data')
        source = os.path.join(self.temp_dir.name, 'inbox.mp4')
        signature = (1, 2, 4, 5)
        with self.assertRaises(ValueError):
            vdl.db_insert_ingested_video(
                'import01', source, signature, 'inbox.mp4', 'inbox', 4,
                self.download_dir, filename, None,
                content_hash=(hashlib.sha256(b'data').hexdigest(),
                              vdl._current_file_identity(filename)),
                folder_tags=('valid', 'bad,tag'),
            )
        self.assertIsNone(vdl.db_get_download('import01'))
        with vdl.db() as conn:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM ingest_receipts WHERE download_id='import01'"
            ).fetchone()[0], 0)
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM media_hashes WHERE download_id='import01'"
            ).fetchone()[0], 0)
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM tags WHERE name='valid'"
            ).fetchone()[0], 0)

    def test_refresh_marks_finished_rows_pending_without_scanning_inbox(self):
        self.finished_file('first001', 'a.mp4', b'data')
        vdl._hash_backfill_once()
        with (mock.patch.object(vdl, 'start_duplicate_backfill') as start,
              mock.patch.object(vdl.os, 'scandir') as scan):
            response = self.client.post('/api/duplicates/refresh')
        self.assertEqual(response.status_code, 202)
        start.assert_called_once()
        scan.assert_not_called()
        self.assertEqual(
            self.client.get('/api/duplicates').get_json()['pending_count'], 1
        )
        vdl._hash_backfill_once()
        self.assertEqual(
            self.client.get('/api/duplicates').get_json()['pending_count'], 0
        )

    def test_uuid_candidate_collision_retries_without_overwrite(self):
        one = mock.Mock(hex='a' * 32)
        two = mock.Mock(hex='b' * 32)
        occupied = os.path.join(self.download_dir, 'clip--' + 'a' * 12 + '.mp4')
        with open(occupied, 'wb') as output:
            output.write(b'original')
        with mock.patch.object(vdl.uuid, 'uuid4', side_effect=[one, two]):
            path = vdl._reserve_mounted_path(self.download_dir, 'clip.mp4')
        self.assertEqual(os.path.basename(path), 'clip--' + 'b' * 12 + '.mp4')
        with open(occupied, 'rb') as source:
            self.assertEqual(source.read(), b'original')
        self.assertTrue(os.path.isfile(path))

    def test_long_mounted_basename_keeps_extension(self):
        long_name = 'é' * 110 + '.mp4'
        path = vdl._reserve_mounted_path(self.download_dir, long_name)
        basename = os.path.basename(path)
        self.assertLessEqual(len(os.fsencode(basename)),
                             os.pathconf(self.download_dir, 'PC_NAME_MAX'))
        self.assertTrue(basename.endswith('.mp4'))
        self.assertRegex(basename, r'--[0-9a-f]{12}\.mp4$')

    def test_long_source_basename_is_preserved_for_display_and_export(self):
        source_name = 'é' * 120 + '.mp4'
        self.assertGreater(len(os.fsencode(source_name)), 240)
        with self.assertRaisesRegex(ValueError, 'too long'):
            vdl._validated_upload_filename(source_name)
        inbox = os.path.join(self.temp_dir.name, 'inbox')
        os.mkdir(inbox)
        source = os.path.join(inbox, source_name)
        with open(source, 'wb') as output:
            output.write(b'video')
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value=None):
            download_id = vdl._ingest_watched_file(
                source, vdl._source_signature(source)
            )
        row = vdl.db_get_download(download_id)
        self.assertEqual(row['display_filename'], source_name)
        self.assertLessEqual(len(os.fsencode(os.path.basename(row['filename']))),
                             os.pathconf(self.download_dir, 'PC_NAME_MAX'))
        self.assertEqual(
            self.client.get('/api/library').get_json()[0]['filename'], source_name
        )
        attachment = self.client.get(f'/api/file/{download_id}?download=1')
        self.assertIn('filename*=', attachment.headers['Content-Disposition'])
        attachment.close()

    def test_display_filename_is_searchable_in_playback_selection(self):
        self.finished_file('first001', 'internal.mp4', b'data')
        vdl.db_update_download('first001', title='Unrelated title',
                               display_filename='special-name.mp4')
        selection = vdl.resolve_library_selection(None, True, 'special-name', 'newest')
        self.assertEqual([entry['id'] for entry in selection], ['first001'])
        self.assertEqual(
            vdl.resolve_library_selection(None, True, 'not-present', 'newest'), []
        )

    def test_deleting_one_member_removes_its_hash_only(self):
        self.finished_file('first001', 'a.mp4', b'same')
        self.finished_file('second01', 'b.mp4', b'same')
        vdl._hash_backfill_once()
        self.assertEqual(
            self.client.post('/api/remove/first001').status_code, 200
        )
        self.assertEqual(self.client.get('/api/duplicates').get_json()['groups'], [])
        with vdl.db() as conn:
            rows = [row[0] for row in conn.execute(
                'SELECT download_id FROM media_hashes'
            )]
        self.assertEqual(rows, ['second01'])


if __name__ == '__main__':
    unittest.main()
