import collections
import os
import sqlite3
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class LiveRefreshBackendTest(AppCase):
    def test_library_constructs_one_allowlist_and_closes_connections_at_any_size(self):
        media = self.finished_file('library0')
        real_connect = sqlite3.connect
        counts = collections.Counter()

        class CountedConnection(sqlite3.Connection):
            def close(self):
                counts['closed'] += 1
                super().close()

        def connect(*args, **kwargs):
            counts['opened'] += 1
            connection = real_connect(*args, factory=CountedConnection, **kwargs)
            connection.set_trace_callback(lambda sql: counts.update(
                ['allowlist'] if 'SELECT DISTINCT output_dir' in sql else []
            ))
            return connection

        for size in (10, 100):
            with vdl.db() as connection:
                connection.execute('DELETE FROM downloads')
                connection.executemany(
                    'INSERT INTO downloads '
                    '(id, url, status, created_at, filename, output_dir) '
                    'VALUES (?, ?, ?, ?, ?, ?)',
                    [(f'library{i}', 'https://fixture.invalid/video',
                      'finished', i, media, self.download_dir)
                     for i in range(size)],
                )
            counts.clear()
            with mock.patch.object(vdl.sqlite3, 'connect', side_effect=connect):
                response = self.client.get('/api/library')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(response.get_json()), size)
            self.assertEqual(counts['allowlist'], 1, dict(counts))
            self.assertLessEqual(counts['opened'], 4, dict(counts))
            self.assertEqual(counts['opened'], counts['closed'], dict(counts))

    def test_library_snapshot_keeps_stored_roots_and_rejects_filename_and_symlink_escape(self):
        original = self.finished_file('original')
        external = os.path.join(self.temp_dir.name, 'external')
        os.mkdir(external)
        outside = os.path.join(external, 'secret.mp4')
        with open(outside, 'wb') as stream:
            stream.write(b'private')
        link = os.path.join(self.download_dir, 'escape.mp4')
        os.symlink(outside, link)
        for download_id, filename in [('tampered', outside), ('symlink', link)]:
            self.insert(download_id)
            vdl.db_update_download(download_id, status='finished', filename=filename)
        replacement = os.path.join(self.temp_dir.name, 'replacement')
        os.mkdir(replacement)
        vdl.db_set_preferences({'download_dir': replacement})

        response = self.client.get('/api/library')
        self.assertEqual([entry['id'] for entry in response.get_json()], ['original'])
        self.assertTrue(os.path.isfile(original))

    def test_collection_queries_filter_status_before_materializing_rows(self):
        self.finished_file('finished')
        self.insert('active')
        self.insert('failed')
        vdl.db_update_download('failed', status='error')
        statements = []
        real_connect = sqlite3.connect

        def connect(*args, **kwargs):
            connection = real_connect(*args, **kwargs)
            connection.set_trace_callback(statements.append)
            return connection

        with mock.patch.object(vdl.sqlite3, 'connect', side_effect=connect):
            library = self.client.get('/api/library').get_json()
            current = self.client.get('/api/current-downloads').get_json()
        self.assertEqual([entry['id'] for entry in library], ['finished'])
        self.assertEqual([entry['id'] for entry in current], ['active'])
        collection_queries = [sql for sql in statements if sql.startswith('SELECT downloads.id, url')]
        self.assertEqual(len(collection_queries), 2)
        for sql in collection_queries:
            self.assertIn('downloads.status IN (', sql)

    def test_thumbnail_requests_share_inflight_work_without_waiting(self):
        import concurrent.futures
        import threading

        media = self.finished_file('thumbnail')
        other_client = self.authenticated_client()
        entered = threading.Event()
        release = threading.Event()
        calls = []

        def generate(source, destination):
            calls.append(source)
            entered.set()
            release.wait(3)
            with open(destination, 'wb') as image:
                image.write(b'jpeg')
            return True

        assets = vdl._get_asset_queue()
        with mock.patch.object(vdl, 'generate_video_thumbnail', side_effect=generate), \
                concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            work = pool.submit(assets.step)
            try:
                self.assertTrue(entered.wait(2))
                for method in (other_client.get, other_client.head):
                    second = method('/api/thumbnail/thumbnail')
                    self.assertEqual(second.status_code, 202)
                    self.assertEqual(second.headers['Cache-Control'], 'no-store')
                self.assertFalse(assets.step())
                self.assertEqual(calls, [media])
            finally:
                release.set()
            self.assertTrue(work.result(2))
        response = self.client.get('/api/thumbnail/thumbnail')
        self.assertEqual(response.status_code, 200)
        response.close()

    def test_failed_thumbnail_generation_has_persistent_bounded_backoff(self):
        self.finished_file('thumbnail')
        assets = vdl._get_asset_queue()
        clock = mock.Mock(return_value=100)
        assets.clock = clock
        with mock.patch.object(vdl, 'generate_video_thumbnail', return_value=False) as generate, \
                mock.patch.object(vdl, 'generate_video_preview', return_value=False):
            self.assertTrue(assets.step())
            self.assertEqual(self.client.get('/api/thumbnail/thumbnail').status_code, 202)
            clock.return_value = 110
            self.assertTrue(assets.step())  # Independent montage attempt.
            self.assertFalse(assets.step())
            self.assertEqual(generate.call_count, 1)
            for instant in (140, 440):
                clock.return_value = instant
                self.assertTrue(assets.step())
                self.assertTrue(assets.step())
            self.assertEqual(generate.call_count, 3)
            self.assertEqual(self.client.get('/api/thumbnail/thumbnail').status_code, 404)
            clock.return_value = 100000
            self.assertFalse(assets.step())
            self.assertEqual(generate.call_count, 3)

    def test_thumbnail_and_montage_requests_deduplicate_persistent_tasks(self):
        for identifier in ('first', 'second', 'third'):
            self.finished_file(identifier, identifier + '.mp4')
        with mock.patch.object(vdl, 'generate_video_thumbnail') as thumbnail, \
                mock.patch.object(vdl, 'generate_video_preview') as montage:
            for _ in range(3):
                for identifier in ('first', 'second', 'third'):
                    for kind in ('thumbnail', 'preview'):
                        response = self.client.get('/api/' + kind + '/' + identifier)
                        self.assertEqual(response.status_code, 202)
            thumbnail.assert_not_called()
            montage.assert_not_called()
        with vdl.db() as conn:
            rows = conn.execute('SELECT kind, state, attempts FROM generated_assets').fetchall()
        self.assertEqual(len(rows), 6)
        self.assertEqual({row['state'] for row in rows}, {'queued'})
        self.assertEqual({row['attempts'] for row in rows}, {0})

    def test_backfill_batch_constructs_the_allowlist_once(self):
        for index in range(5):
            self.finished_file(f'backfill{index}', f'backfill{index}.mp4')
        with mock.patch.object(vdl, '_trusted_download_directories',
                               wraps=vdl._trusted_download_directories) as snapshot:
            vdl._hash_backfill_once()
        snapshot.assert_called_once_with()

    def test_library_selection_batch_constructs_the_allowlist_once(self):
        for index in range(5):
            self.finished_file(f'selection{index}', f'selection{index}.mp4')
        with mock.patch.object(vdl, '_trusted_download_directories',
                               wraps=vdl._trusted_download_directories) as snapshot:
            entries = vdl.resolve_library_selection(None, True, '', 'newest')
        self.assertEqual(len(entries), 5)
        snapshot.assert_called_once_with()
