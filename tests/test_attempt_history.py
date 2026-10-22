import os
import time
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class AttemptHistoryTest(AppCase):
    def attempts(self, query=''):
        response = self.client.get('/api/history' + query)
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def test_separate_library_current_and_paginated_attempt_reads(self):
        self.finished_file('finished', name='finished.mp4')
        for status in ('error', 'cancelled', 'interrupted', 'downloading', 'paused', 'starting'):
            self.insert(status)
            vdl.db_update_download(status, status=status, title=f'{status} title', progress='Failure' if status == 'error' else '10%')
        self.assertEqual([row['id'] for row in self.client.get('/api/library').get_json()], ['finished'])
        self.assertEqual({row['status'] for row in self.client.get('/api/current-downloads').get_json()},
                         {'starting', 'downloading', 'paused', 'cancelled', 'interrupted'})
        history = self.attempts()
        self.assertEqual(history['total'], 7)
        self.assertEqual(len(history['items']), 7)
        for row in history['items']:
            self.assertEqual(bool(row['library_id']), row['status'] == 'finished')
            self.assertNotIn(self.download_dir, str(row))
            self.assertNotIn('owner_user_id', row)
            self.assertNotIn('work_id', row)

    def test_resume_preserves_terminal_snapshot_and_pause_reuses_attempt(self):
        self.insert('resume')
        vdl.db_update_download('resume', status='cancelled', progress='Stopped', downloaded_bytes=5)
        old = self.attempts()['items'][0]
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.client.post('/api/resume/resume').status_code, 200)
            self.assertEqual(self.client.post('/api/resume/resume').status_code, 409)
            enqueue.assert_called_once()
        vdl.db_update_download('resume', status='paused', progress='Paused')
        vdl.db_update_download('resume', status='downloading', progress='50%')
        rows = self.attempts()['items']
        self.assertEqual(len(rows), 2)
        previous = next(row for row in rows if row['id'] == old['id'])
        self.assertEqual(previous['status'], 'cancelled')
        self.assertEqual(previous['progress'], 'Stopped')
        self.assertEqual(previous['downloaded_bytes'], 5)
        self.assertEqual(previous['ended_at'], old['ended_at'])
        self.assertFalse(previous['can_resume'])
        self.assertFalse(previous['can_retry'])
        self.finished_file('resume')
        self.assertEqual(self.attempts()['total'], 2)

    def test_retry_keeps_download_id_tags_and_prior_error(self):
        self.insert('retry')
        vdl.db_add_download_tag('retry', 'Keep')
        vdl.db_update_download('retry', status='error', progress='Original failure')
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            response = self.client.post('/api/retry/retry')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()['id'], 'retry')
            enqueue.assert_called_once()
            self.assertEqual(self.client.post('/api/retry/retry').status_code, 409)
        self.assertEqual(vdl.db_get_download('retry')['tags'], ['Keep'])
        self.finished_file('retry')
        rows = self.attempts()['items']
        self.assertEqual({row['status'] for row in rows}, {'error', 'finished'})
        self.assertIn('Original failure', str(rows))
        self.assertEqual(len(self.client.get('/api/library').get_json()), 1)

    def test_retry_rejects_live_worker_upload_companion_and_unknown_work(self):
        self.insert('busy')
        vdl.db_update_download('busy', status='cancelled')
        vdl._live_worker_ids.add('busy')
        self.assertEqual(self.client.post('/api/retry/busy').status_code, 409)
        vdl._live_worker_ids.clear()
        vdl.db_insert_upload('upload', 'video.mp4', 'Video', 5, self.download_dir)
        self.assertEqual(self.client.post('/api/retry/upload').status_code, 409)
        with vdl.db() as conn:
            conn.execute('UPDATE downloads SET browser_authenticated = 1 WHERE id = ?', ('busy',))
        self.assertEqual(self.client.post('/api/retry/busy').status_code, 409)
        self.assertEqual(self.client.post('/api/retry/missing').status_code, 404)
        self.assertEqual(self.attempts()['total'], 2)

    def test_retry_cleanup_failure_preserves_work_and_attempt(self):
        self.insert('cleanup')
        vdl.db_update_download('cleanup', status='error', progress='Original failure')
        with mock.patch.object(vdl, 'delete_download_artifacts', side_effect=OSError('disk unavailable')):
            response = self.client.post('/api/retry/cleanup')
        self.assertEqual(response.status_code, 500)
        self.assertIn('Cleanup failed', response.get_json()['error'])
        self.assertEqual(vdl.db_get_download('cleanup')['status'], 'error')
        self.assertEqual(self.attempts()['total'], 1)

    def test_personal_history_never_inherits_public_library_visibility(self):
        alice = vdl.db_create_user('alice', 'alice-password', 'normal')
        bob = vdl.db_create_user('bob', 'bob-password', 'normal')
        for user in (alice, bob):
            vdl.db_insert_download(user['username'], f'https://example.com/{user["username"]}', user['id'], user['username'])
            self.finished_file(user['username'], name=user['username'] + '.mp4')
        client = self.authenticated_client('alice', 'alice-password')
        self.assertEqual(len(client.get('/api/library').get_json()), 2)
        rows = client.get('/api/history').get_json()['items']
        self.assertEqual([row['download_id'] for row in rows], ['alice'])
        self.assertEqual(client.get('/api/history?filter=bob').get_json()['total'], 0)
        # Administrators see their own attempts plus system imports, not other users' private logs.
        self.assertEqual(self.attempts()['total'], 0)
        vdl.db_delete_user(alice['id'])
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM download_attempts WHERE work_id = ?', ('alice',)).fetchone()[0], 0)

    def test_deleting_an_account_during_work_does_not_recreate_its_log(self):
        user = vdl.db_create_user('removed', 'removed-password', 'normal')
        vdl.db_insert_download('removed-active', 'https://example.com/private', user['id'], user['username'])
        vdl.db_delete_user(user['id'])
        vdl.db_update_download('removed-active', status='downloading', progress='50%')
        vdl.db_update_download('removed-active', status='error', progress='Private error')
        self.assertEqual(self.attempts()['total'], 0)

    def test_removed_missing_and_unsafe_media_keep_finished_outcomes(self):
        path = self.finished_file('removed')
        before = self.attempts()['items'][0]
        os.remove(path)
        self.assertEqual(self.client.get('/api/library').get_json(), [])
        missing = self.attempts()['items'][0]
        self.assertEqual(missing['status'], 'finished')
        self.assertEqual(missing['media_state'], 'unavailable')
        self.assertIsNone(missing['library_id'])
        self.assertEqual(self.client.post('/api/remove/removed').status_code, 200)
        removed = self.attempts()['items'][0]
        self.assertEqual(removed['media_state'], 'removed')
        self.assertEqual(removed['filename'], before['filename'])
        self.assertIsNone(removed['download_id'])
        self.insert('unsafe')
        vdl.db_update_download('unsafe', status='finished', filename='/etc/passwd')
        self.assertEqual(self.client.get('/api/library').get_json(), [])
        self.assertTrue(all(row['library_id'] is None for row in self.attempts()['items']))

    def test_history_clear_deletes_only_terminal_attempts_and_does_not_backfill_again(self):
        self.finished_file('keep')
        self.insert('active')
        self.insert('cancelled')
        vdl.db_update_download('cancelled', status='cancelled')
        self.assertEqual(self.client.get('/api/clear/preview').get_json(), {'entries': 2, 'with_files': 0})
        self.assertEqual(self.client.post('/api/clear').get_json(), {'removed': 2, 'files_deleted': 0})
        self.assertEqual(self.attempts()['total'], 1)
        self.assertTrue(os.path.isfile(vdl.db_get_download('keep')['filename']))
        self.assertIsNotNone(vdl.db_get_download('cancelled'))
        vdl.init_db()
        self.assertEqual(self.attempts()['total'], 1)
        self.assertEqual(self.attempts()['items'][0]['status'], 'interrupted')
        # Even a metadata update must not recreate an explicitly cleared outcome.
        vdl.db_update_download('keep', title='Renamed')
        self.assertEqual(self.attempts()['total'], 1)

    def test_bulk_media_delete_keeps_attempt_snapshots(self):
        path = self.finished_file('bulk')
        result = self.client.post('/api/library/clear').get_json()
        self.assertEqual(result['files_deleted'], 1)
        self.assertFalse(os.path.exists(path))
        self.assertEqual(self.attempts()['items'][0]['status'], 'finished')
        self.assertEqual(self.attempts()['items'][0]['media_state'], 'removed')

    def test_filter_terms_are_quote_aware_conjunctive_and_before_pagination(self):
        for index in range(7):
            self.insert(f'filter{index}')
            vdl.db_update_download(f'filter{index}', status='error', title=f'Blue bird {index}', progress='Remote refusal')
        self.insert('other')
        vdl.db_update_download('other', status='error', title='Blue fish', progress='Different failure')
        query = '?filter="blue bird" refusal status:error&page_size=3&page=2'
        result = self.attempts(query)
        self.assertEqual(result['total'], 7)
        self.assertEqual(len(result['items']), 3)
        self.assertEqual(result['page'], 2)
        clamped = self.attempts('?filter="blue bird"&page_size=3&page=999')
        self.assertEqual(clamped['page'], 3)
        self.assertEqual(len(clamped['items']), 1)
        self.assertEqual(self.attempts('?filter="blue bird" missing')['total'], 0)
        for query in ('?page=0', '?page=no', '?page_size=101', '?page_size=0', '?filter=' + 'x' * 257):
            self.assertEqual(self.client.get('/api/history' + query).status_code, 400)

    def test_legacy_backfill_is_once_and_crash_recovery_interrupts_attempts(self):
        self.finished_file('legacy')
        self.insert('orphan')
        with vdl.db() as conn:
            conn.execute('DELETE FROM download_attempts')
            conn.execute("DELETE FROM app_config WHERE key = 'attempts_migrated'")
        original = vdl.db_get_download('legacy')
        vdl.init_db()
        result = self.attempts()
        self.assertEqual(result['total'], 2)
        self.assertTrue(all(row['legacy'] for row in result['items']))
        finished = next(row for row in result['items'] if row['download_id'] == 'legacy')
        self.assertEqual(finished['started_at'], original['created_at'])
        self.assertEqual(finished['ended_at'], original['finished_at'])
        self.assertEqual(vdl.db_get_download('orphan')['status'], 'interrupted')
        orphan = next(row for row in result['items'] if row['download_id'] == 'orphan')
        self.assertEqual(orphan['status'], 'interrupted')
        self.assertIsNotNone(orphan['ended_at'])
        vdl.init_db()
        self.assertEqual(self.attempts()['total'], 2)

    def test_upload_validation_failure_and_rejected_work(self):
        self.assertEqual(self.client.post('/api/upload', json={'filename': 'bad.mp4', 'filesize': 0}).status_code, 400)
        self.assertEqual(self.attempts()['total'], 0)
        response = self.client.post('/api/upload', json={'filename': 'bad.mp4', 'filesize': 3})
        upload_id = response.get_json()['id']
        with mock.patch.object(vdl, 'inspect_uploaded_video', side_effect=ValueError('No video stream')):
            self.client.put('/api/upload/' + upload_id, data=b'bad')
        row = self.attempts()['items'][0]
        self.assertEqual(row['source_type'], 'upload')
        self.assertEqual(row['status'], 'error')
        self.assertIn('No video stream', row['error_summary'])
        self.assertEqual(row['filename'], 'bad.mp4')
        self.assertFalse(row['can_resume'])

    def test_companion_idempotency_and_resume_create_exactly_one_execution_each(self):
        user = vdl.db_get_user_by_username('admin')
        with mock.patch.object(vdl.time, 'time', return_value=time.time()):
            first, action, _ = vdl._resolve_companion_download(user, 'request-one', 'https://example.com/video')
        self.assertEqual(action, 'started')
        vdl._resolve_companion_download(user, 'request-one', 'https://example.com/video')
        vdl._resolve_companion_download(user, 'request-two', 'https://example.com/video')
        self.assertEqual(self.attempts()['total'], 1)
        vdl.db_update_download(first['id'], status='cancelled')
        _, action, _ = vdl._resolve_companion_download(user, 'request-three', 'https://example.com/video')
        self.assertEqual(action, 'resumed')
        self.assertEqual(self.attempts()['total'], 2)
        self.assertTrue(all(row['source_type'] == 'companion' for row in self.attempts()['items']))

    def test_mounted_failure_records_a_system_attempt_and_success_links_once(self):
        inbox = os.path.join(self.temp_dir.name, 'inbox')
        os.mkdir(inbox)
        path = os.path.join(inbox, 'mounted.mp4')
        with open(path, 'wb') as output:
            output.write(b'video')
        signature = vdl._source_signature(path)
        with mock.patch.object(vdl, 'inspect_uploaded_video', side_effect=ValueError('Invalid video')):
            with self.assertRaises(ValueError):
                vdl._ingest_watched_file(path, signature)
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value='720p'):
            download_id = vdl._ingest_watched_file(path, signature)
        rows = self.attempts()['items']
        self.assertEqual(len(rows), 2)
        self.assertEqual({row['status'] for row in rows}, {'error', 'finished'})
        self.assertTrue(all(row['source_type'] == 'mounted_import' for row in rows))
        self.assertEqual(next(row for row in rows if row['status'] == 'finished')['library_id'], download_id)
        user = vdl.db_create_user('viewer', 'viewer-password', 'normal')
        client = self.authenticated_client(user['username'], 'viewer-password')
        self.assertEqual(client.get('/api/history').get_json()['total'], 0)
        self.assertEqual(len(client.get('/api/library').get_json()), 1)

    def test_attempts_never_retain_url_credentials_cookies_or_query_secrets(self):
        self.insert('safe', url='https://user:password@example.com/video?token=secret#fragment')
        vdl.db_update_download('safe', status='error', progress='Failed https://user:password@example.com/video?token=secret\nCookie: sensitive-cookie\nAuthorization: sensitive-header')
        with vdl.db() as conn:
            stored = str(dict(conn.execute('SELECT * FROM download_attempts').fetchone()))
        for secret in ('password', 'token=secret', 'sensitive-cookie', 'sensitive-header'):
            self.assertNotIn(secret, stored)
        self.assertIn('example.com', stored)

    def test_sse_observers_read_committed_attempt_outcomes(self):
        self.insert('sse')
        subscriber = vdl.event_bus.subscribe()
        vdl.db_update_download('sse', status='error', progress='Failure')
        self.assertEqual(subscriber.get_nowait()[0], 'change')
        self.assertEqual(self.attempts()['items'][0]['status'], 'error')
        vdl.event_bus.unsubscribe(subscriber)


if __name__ == '__main__':
    unittest.main()
