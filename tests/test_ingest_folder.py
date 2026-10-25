import os
import threading
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class IngestFolderTest(AppCase):
    def setUp(self):
        super().setUp()
        self.ingest_dir = os.path.join(self.temp_dir.name, 'ingest')
        os.mkdir(self.ingest_dir)

    def source(self, name='movie.mp4', data=b'video bytes'):
        path = os.path.join(self.ingest_dir, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as output:
            output.write(data)
        return path

    def ingest(self, source):
        return vdl._ingest_watched_file(
            source, vdl._source_signature(source),
            ingest_root=self.ingest_dir,
            relative_path=os.path.relpath(source, self.ingest_dir),
        )

    def run_import(self):
        vdl.IngestStartupImporter(self.ingest_dir).run(threading.Event())

    def test_mounted_publication_queues_assets_and_preserves_receipt_without_extracting(self):
        source = self.source('validated-video.unknown')
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value='720p'), \
                mock.patch.object(vdl, 'generate_video_thumbnail') as thumbnail, \
                mock.patch.object(vdl, 'generate_video_preview') as montage:
            download_id = self.ingest(source)
        thumbnail.assert_not_called()
        montage.assert_not_called()
        self.assertEqual(vdl.db_get_download(download_id)['status'], 'finished')
        self.assertIn(source, vdl.db_get_ingest_receipts(self.ingest_dir))
        with vdl.db() as conn:
            rows = conn.execute('SELECT kind,state FROM generated_assets WHERE download_id=? '
                                'ORDER BY sequence', (download_id,)).fetchall()
        self.assertEqual([(row['kind'], row['state']) for row in rows],
                         [('thumbnail', 'queued'), ('montage', 'queued')])

    def test_snapshot_is_recursive_sorted_and_excludes_hidden_temporary_and_symlinks(self):
        nested = self.source('Season/Part/Movie.MP4')
        root = self.source('root.unknown')
        self.source('.hidden.mp4')
        self.source('Season/.hidden.mp4')
        self.source('Season/unfinished.MP4.PART')
        self.source('.hidden-dir/movie.mp4')
        self.source('Season/hidden/.movie.mp4')
        os.symlink(nested, os.path.join(self.ingest_dir, 'linked.mp4'))
        os.symlink(os.path.join(self.ingest_dir, 'Season'),
                   os.path.join(self.ingest_dir, 'linked-dir'))

        snapshot = vdl._snapshot_ingest_files(self.ingest_dir)

        self.assertEqual(
            [relative for _path, relative, _signature in snapshot],
            ['Season/Part/Movie.MP4', 'root.unknown'],
        )
        self.assertEqual([path for path, _relative, _signature in snapshot],
                         [nested, root])
        for path, _relative, signature in snapshot:
            self.assertEqual(signature, vdl._source_signature(path))

    def test_snapshot_failure_aborts_batch_without_pruning_receipts(self):
        retained = self.source('keep.mp4')
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value=None):
            self.ingest(retained)
        os.remove(retained)
        self.source('bad/file.mp4')
        real_open_directory = vdl._open_ingest_directory

        def fail_subdirectory(root, relative_path):
            if relative_path == 'bad':
                raise PermissionError('cannot list child')
            return real_open_directory(root, relative_path)

        with (mock.patch.object(vdl, '_open_ingest_directory',
                                side_effect=fail_subdirectory),
              mock.patch.object(vdl, '_ingest_watched_file') as ingest,
              mock.patch('builtins.print') as output):
            self.run_import()

        ingest.assert_not_called()
        self.assertIn(retained, vdl.db_get_ingest_receipts(self.ingest_dir))
        self.assertTrue(any('cannot list child' in str(call) for call in output.call_args_list))

    def test_fixed_snapshot_does_not_import_later_files_or_retry_failures(self):
        first = self.source('a.mp4')
        last = self.source('z.mp4')
        attempted = []

        def attempt(path, *_args, **_kwargs):
            attempted.append(path)
            if path == first:
                self.source('m.mp4')
                raise ValueError('invalid video')
            return 'imported'

        with (mock.patch.object(vdl, '_ingest_watched_file', side_effect=attempt),
              mock.patch('builtins.print')):
            self.run_import()

        self.assertEqual(attempted, [first, last])
        self.assertEqual(vdl.db_list_downloads(), [])

    def test_captured_file_changed_before_its_turn_is_skipped_once(self):
        first = self.source('a.mp4')
        later = self.source('z.mp4')

        def change_later(path, *_args, **_kwargs):
            if path == first:
                with open(later, 'ab') as output:
                    output.write(b' changed')
            return 'imported'

        with mock.patch.object(vdl, '_ingest_watched_file', side_effect=change_later) as ingest:
            self.run_import()

        self.assertEqual([call.args[0] for call in ingest.call_args_list], [first])

    def test_nested_and_root_files_get_expected_tags_and_distinct_paths(self):
        root = self.source('movie.mp4', data=b'root movie')
        nested = self.source('Some/Subfolder/movie.mp4', data=b'nested movie')
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value='1080p'):
            self.run_import()

        rows = vdl.db_list_downloads()
        self.assertEqual(len(rows), 2)
        by_source = {row['id']: row for row in rows}
        receipts = vdl.db_get_ingest_receipts(self.ingest_dir)
        self.assertEqual(set(receipts), {root, nested})
        root_row = next(row for row in by_source.values() if row['tags'] == [])
        nested_row = next(row for row in by_source.values()
                          if row['tags'] == ['Some', 'Subfolder'])
        self.assertNotEqual(root_row['filename'], nested_row['filename'])
        for row in (root_row, nested_row):
            self.assertEqual(row['status'], 'finished')
            self.assertEqual(row['source_type'], 'upload')
            self.assertEqual(row['display_filename'], 'movie.mp4')
            self.assertRegex(os.path.basename(row['filename']),
                             r'^movie--[0-9a-f]{12}\.mp4$')
            self.assertTrue(os.path.isfile(row['filename']))
        with open(root, 'rb') as source_file:
            self.assertEqual(source_file.read(), b'root movie')
        with open(nested, 'rb') as source_file:
            self.assertEqual(source_file.read(), b'nested movie')

    def test_folder_tags_reuse_case_insensitive_identity_and_deduplicate(self):
        self.source('  Music   Videos /music videos/movie.mp4')
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value=None):
            self.run_import()

        rows = vdl.db_list_downloads()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['tags'], ['Music Videos'])
        self.assertEqual(vdl.db_list_tags(), ['Music Videos'])

    def test_invalid_folder_tag_fails_one_file_without_partial_registration(self):
        invalid = self.source('bad,tag/movie.mp4')
        valid = self.source('good/other.mp4')
        with (mock.patch.object(vdl, 'inspect_uploaded_video', return_value=None),
              mock.patch('builtins.print') as output):
            self.run_import()

        rows = vdl.db_list_downloads()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['tags'], ['good'])
        self.assertEqual(set(vdl.db_get_ingest_receipts(self.ingest_dir)), {valid})
        self.assertTrue(os.path.isfile(invalid))
        self.assertTrue(any('bad,tag' in str(call) for call in output.call_args_list))

    def test_insert_event_sees_folder_tags_and_receipt(self):
        source = self.source('some/subfolder/movie.mp4')
        published = []
        real_publish = vdl.event_bus.publish

        def inspect_event(name, payload):
            if payload.get('reason') == 'insert':
                rows = vdl.db_list_downloads()
                published.append((rows[0]['tags'],
                                  source in vdl.db_get_ingest_receipts(self.ingest_dir)))
            return real_publish(name, payload)

        with (mock.patch.object(vdl, 'inspect_uploaded_video', return_value=None),
              mock.patch.object(vdl.event_bus, 'publish', side_effect=inspect_event)):
            self.run_import()

        self.assertEqual(published, [(['some', 'subfolder'], True)])

    def test_exact_receipt_skips_restart_and_removed_source_is_pruned(self):
        source = self.source('folder/movie.mp4')
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value=None):
            self.run_import()
        first_id = vdl.db_list_downloads()[0]['id']
        with mock.patch.object(vdl, '_ingest_watched_file') as ingest:
            self.run_import()
        ingest.assert_not_called()
        self.assertEqual([row['id'] for row in vdl.db_list_downloads()], [first_id])
        os.remove(source)
        self.run_import()
        self.assertEqual(vdl.db_get_ingest_receipts(self.ingest_dir), {})
        self.assertEqual([row['id'] for row in vdl.db_list_downloads()], [first_id])

    def test_changed_source_reimport_preserves_each_rows_mounted_origin(self):
        source = self.source('folder/movie.mp4', data=b'first movie')
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value=None):
            self.run_import()
            first = vdl.db_list_downloads()[0]
            with open(source, 'ab') as output:
                output.write(b' changed')
            self.run_import()

        rows = vdl.db_list_downloads()
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['mounted_import'] for row in rows))
        self.assertTrue(all(row['tags'] == ['folder'] for row in rows))
        self.assertEqual(vdl.db_get_download(first['id'])['ingest_source_path'], source)
        self.assertEqual({vdl.db_get_download(row['id'])['ingest_source_path']
                          for row in rows}, {source})
        self.assertEqual(set(vdl.db_get_ingest_receipts(self.ingest_dir)), {source})

    def test_mutation_during_validation_discards_unpublished_copy(self):
        source = self.source('movie.mp4', data=b'first version')

        def change_source(_temporary_path):
            with open(source, 'ab') as output:
                output.write(b' changed')
            return '720p'

        with (mock.patch.object(vdl, 'inspect_uploaded_video', side_effect=change_source),
              self.assertRaises(vdl.IngestSourceChanged)):
            self.ingest(source)

        self.assertEqual(vdl.db_list_downloads(), [])
        self.assertEqual(os.listdir(self.download_dir), [])
        self.assertTrue(os.path.isfile(source))

    def test_invalid_video_is_left_in_inbox_without_library_artifacts(self):
        source = self.source('notes.txt', data=b'not a movie')
        with (mock.patch.object(vdl, 'inspect_uploaded_video',
                                side_effect=ValueError('no video stream')),
              self.assertRaisesRegex(ValueError, 'video stream')):
            self.ingest(source)
        self.assertTrue(os.path.isfile(source))
        self.assertEqual(os.listdir(self.download_dir), [])
        self.assertEqual(vdl.db_list_downloads(), [])

    def test_symlinked_ancestor_and_mount_escape_are_rejected(self):
        outside = os.path.join(self.temp_dir.name, 'outside')
        os.mkdir(outside)
        external = os.path.join(outside, 'movie.mp4')
        with open(external, 'wb') as output:
            output.write(b'video')
        os.symlink(outside, os.path.join(self.ingest_dir, 'linked'))
        linked = os.path.join(self.ingest_dir, 'linked', 'movie.mp4')
        with self.assertRaises(vdl.IngestSourceChanged):
            self.ingest(linked)
        with self.assertRaises((ValueError, vdl.IngestSourceChanged)):
            vdl._ingest_watched_file(
                external, vdl._source_signature(external),
                ingest_root=self.ingest_dir, relative_path='../outside/movie.mp4',
            )
        self.assertEqual(vdl.db_list_downloads(), [])

    def test_mount_and_library_trees_must_be_disjoint(self):
        source = self.source()
        vdl.db_set_preferences({'download_dir': self.ingest_dir})
        with self.assertRaisesRegex(ValueError, 'different|overlap|disjoint'):
            self.ingest(source)
        vdl.db_set_preferences({'download_dir': self.download_dir})
        with mock.patch.dict(os.environ, {'VDL_INGEST_DIR': self.temp_dir.name}):
            with self.assertRaisesRegex(RuntimeError, 'different|overlap|disjoint'):
                vdl.start_ingest_import()

    def test_stale_ingest_partials_are_removed_without_touching_other_files(self):
        stale = os.path.join(self.download_dir, '.vdl_abcdef12.random.ingest.part')
        retained = os.path.join(self.download_dir, 'ordinary.part')
        for path in (stale, retained):
            with open(path, 'wb') as output:
                output.write(b'data')
        vdl._remove_stale_ingest_partials(self.download_dir)
        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.exists(retained))

    def test_startup_service_validates_mount_and_starts_only_one_worker(self):
        with mock.patch.dict(os.environ, {'VDL_INGEST_DIR': ''}):
            self.assertIsNone(vdl.start_ingest_import())
        missing = os.path.join(self.temp_dir.name, 'missing')
        with mock.patch.dict(os.environ, {'VDL_INGEST_DIR': missing}):
            with self.assertRaisesRegex(RuntimeError, 'not a directory'):
                vdl.start_ingest_import()
        with (mock.patch.dict(os.environ, {'VDL_INGEST_DIR': self.ingest_dir}),
              mock.patch.object(vdl.os, 'access', return_value=False)):
            with self.assertRaisesRegex(RuntimeError, 'not readable|searchable'):
                vdl.start_ingest_import()

        entered = threading.Event()
        release = threading.Event()

        def hold_worker(_importer, _stop_event):
            entered.set()
            release.wait(timeout=3)

        with (mock.patch.dict(os.environ, {'VDL_INGEST_DIR': self.ingest_dir}),
              mock.patch.object(vdl.IngestStartupImporter, 'run', hold_worker)):
            try:
                first = vdl.start_ingest_import()
                self.assertTrue(entered.wait(timeout=2))
                second = vdl.start_ingest_import()
                self.assertIs(first, second)
            finally:
                release.set()
                vdl.stop_ingest_import()
        self.assertFalse(first.is_alive())

    def test_debug_reloader_parent_does_not_start_import(self):
        with mock.patch.dict(os.environ, {'FLASK_DEBUG': '1'}, clear=False):
            os.environ.pop('WERKZEUG_RUN_MAIN', None)
            self.assertFalse(vdl._should_start_ingest_import())
        with mock.patch.dict(os.environ, {'FLASK_DEBUG': '1',
                                          'WERKZEUG_RUN_MAIN': 'true'}):
            self.assertTrue(vdl._should_start_ingest_import())
        with mock.patch.dict(os.environ, {'FLASK_DEBUG': '0'}, clear=False):
            self.assertTrue(vdl._should_start_ingest_import())

    def test_source_signature_rejects_missing_and_non_regular_paths(self):
        with self.assertRaises(vdl.IngestSourceChanged):
            vdl._source_signature(os.path.join(self.ingest_dir, 'missing'))
        with self.assertRaises(vdl.IngestSourceChanged):
            vdl._source_signature(self.ingest_dir)


if __name__ == '__main__':
    unittest.main()
