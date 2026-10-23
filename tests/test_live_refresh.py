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
            if len(calls) > 1:
                return False
            entered.set()
            release.wait(3)
            with open(destination, 'wb') as image:
                image.write(b'jpeg')
            return True

        with mock.patch.object(vdl, 'generate_video_thumbnail', side_effect=generate), \
                concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.client.get, '/api/thumbnail/thumbnail')
            try:
                self.assertTrue(entered.wait(2))
                second = other_client.get('/api/thumbnail/thumbnail')
                self.assertEqual(second.status_code, 503)
                self.assertEqual(second.headers['Retry-After'], '1')
                self.assertEqual(calls, [media])
            finally:
                release.set()
            response = first.result(2)
        self.assertEqual(response.status_code, 200)
        response.close()

    def test_failed_thumbnail_generation_has_a_retry_cooldown(self):
        self.finished_file('thumbnail')
        with mock.patch.object(vdl, 'generate_video_thumbnail', return_value=False) as generate, \
                mock.patch.object(vdl.time, 'monotonic', return_value=100) as clock:
            self.assertEqual(self.client.get('/api/thumbnail/thumbnail').status_code, 404)
            clock.return_value = 110
            cooling = self.client.get('/api/thumbnail/thumbnail')
            self.assertEqual(cooling.status_code, 404)
            self.assertIn('Retry-After', cooling.headers)
            self.assertEqual(generate.call_count, 1)
            clock.return_value = 131
            self.assertEqual(self.client.get('/api/thumbnail/thumbnail').status_code, 404)
            self.assertEqual(generate.call_count, 2)

    def test_thumbnail_generation_capacity_and_failure_bookkeeping_are_bounded(self):
        import concurrent.futures
        import threading

        self.finished_file('first', 'first.mp4')
        self.finished_file('second', 'second.mp4')
        self.finished_file('third', 'third.mp4')
        clients = [self.authenticated_client() for _ in range(3)]
        entered = threading.Barrier(3)
        release = threading.Event()

        def generate(_source, _destination):
            entered.wait(3)
            release.wait(3)
            return False

        with mock.patch.object(vdl, 'generate_video_thumbnail', side_effect=generate) as generator, \
                concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            pending = [pool.submit(client.get, '/api/thumbnail/' + identifier)
                       for client, identifier in zip(clients, ('first', 'second'))]
            try:
                entered.wait(3)
                response = clients[2].get('/api/thumbnail/third')
                self.assertEqual(response.status_code, 503)
                self.assertEqual(generator.call_count, 2)
            finally:
                release.set()
            self.assertEqual([request.result(2).status_code for request in pending], [404, 404])

        with mock.patch.object(vdl, '_THUMBNAIL_FAILURE_LIMIT', 2), \
                mock.patch.object(vdl, '_thumbnail_generation_failures', {}), \
                mock.patch.object(vdl, 'generate_video_thumbnail', return_value=False) as generator:
            for identifier in ('first', 'second', 'third'):
                self.assertEqual(self.client.get('/api/thumbnail/' + identifier).status_code, 404)
            self.assertEqual(len(vdl._thumbnail_generation_failures), 2)
            # The oldest failure is evicted, so a fresh request can retry it.
            self.client.get('/api/thumbnail/first')
            self.assertEqual(generator.call_count, 4)

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
