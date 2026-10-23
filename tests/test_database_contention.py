import sqlite3
import os
import threading
import time
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class DatabaseContentionTest(AppCase):
    def test_startup_converts_existing_delete_database_and_connections_are_bounded(self):
        with sqlite3.connect(vdl.DB_PATH) as connection:
            connection.execute('PRAGMA journal_mode = DELETE')
        vdl.init_db()
        with vdl.db() as connection:
            self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
            self.assertEqual(connection.execute('PRAGMA busy_timeout').fetchone()[0], 1000)
            self.assertEqual(connection.execute('PRAGMA foreign_keys').fetchone()[0], 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute('SELECT 1')

    def test_startup_refuses_storage_without_wal_support(self):
        with mock.patch.object(vdl, 'DB_PATH', ':memory:'):
            with self.assertRaisesRegex(RuntimeError, 'SQLite WAL is required'):
                vdl.init_db()

    def test_startup_reports_wal_setup_failure(self):
        connection = mock.MagicMock()
        connection.execute.side_effect = sqlite3.OperationalError('fixture failure')
        with mock.patch.object(vdl, 'db') as database:
            database.return_value.__enter__.return_value = connection
            with self.assertRaisesRegex(RuntimeError, 'Unable to enable SQLite WAL'):
                vdl.init_db()

    def test_small_and_cache_spilling_writers_allow_authenticated_reads(self):
        self.insert()
        original_record = vdl.download_history.record
        for size in (32, 4 * 1024 * 1024):
            with self.subTest(size=size):
                written = threading.Event()
                release = threading.Event()
                failures = []

                def hold_after_write(*args, **kwargs):
                    written.set()
                    if not release.wait(3):
                        raise TimeoutError('test did not release writer')
                    return original_record(*args, **kwargs)

                def write():
                    try:
                        vdl.db_update_download('test0001', formats='x' * size)
                    except BaseException as error:
                        failures.append(error)

                with mock.patch.object(vdl.download_history, 'record', side_effect=hold_after_write):
                    writer = threading.Thread(target=write, name='contention-large-writer')
                    writer.start()
                    try:
                        self.assertTrue(written.wait(2))
                        self.assertEqual(self.client.get('/api/current-downloads').status_code, 200)
                        self.assertEqual(self.client.get('/api/library').status_code, 200)
                    finally:
                        release.set()
                        writer.join(3)
                self.assertFalse(writer.is_alive())
                self.assertEqual(failures, [])

    def test_old_reader_does_not_delay_real_progress_commit_or_new_authentication(self):
        self.insert()
        reader = sqlite3.connect(vdl.DB_PATH)
        reader.execute('BEGIN')
        reader.execute('SELECT progress FROM downloads').fetchall()
        finished = threading.Event()
        failures = []

        def write():
            try:
                vdl.db_update_download('test0001', progress='25%')
            except BaseException as error:
                failures.append(error)
            finally:
                finished.set()

        writer = threading.Thread(target=write, name='contention-pending-commit')
        writer.start()
        try:
            self.assertTrue(finished.wait(0.8), 'writer commit waited for an existing reader')
            self.assertEqual(self.client.get('/api/current-downloads').status_code, 200)
            self.assertEqual(reader.execute('SELECT progress FROM downloads').fetchone()[0], '0%')
        finally:
            reader.rollback()
            reader.close()
            writer.join(3)
        self.assertFalse(writer.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(vdl.db_get_download('test0001')['progress'], '25%')

    def test_locked_authentication_returns_retryable_response_and_recovers(self):
        # DELETE mode makes a forced exclusive lock block even readers. This
        # exercises exceptional contention independently of WAL's normal case.
        with sqlite3.connect(vdl.DB_PATH) as connection:
            connection.execute('PRAGMA journal_mode = DELETE')
        blocker = sqlite3.connect(vdl.DB_PATH)
        try:
            blocker.execute('BEGIN EXCLUSIVE')
            started = time.monotonic()
            response = self.client.get('/api/current-downloads')
            elapsed = time.monotonic() - started
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.headers['Retry-After'], '1')
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(response.get_json()['code'], 'database_busy')
            self.assertIs(response.get_json()['retryable'], True)
            with self.client.session_transaction() as session:
                self.assertIn('user_id', session)
            self.assertGreaterEqual(elapsed, 0.8)
            self.assertLess(elapsed, 2)
        finally:
            blocker.rollback()
            blocker.close()
        self.assertEqual(self.client.get('/api/current-downloads').status_code, 200)

    def _assert_lock_does_not_bypass_updated_authorization(self, update):
        admin = vdl.db_get_user_by_username('admin')
        with sqlite3.connect(vdl.DB_PATH) as connection:
            connection.execute('PRAGMA journal_mode = DELETE')
        blocker = sqlite3.connect(vdl.DB_PATH)
        try:
            blocker.execute('BEGIN EXCLUSIVE')
            blocker.execute(f'UPDATE users SET {update} WHERE id = ?', (admin['id'],))
            self.assertEqual(self.client.get('/api/current-downloads').status_code, 503)
            with self.client.session_transaction() as session:
                self.assertEqual(session['user_id'], admin['id'])
            blocker.commit()
        finally:
            blocker.close()
        self.assertEqual(self.client.get('/api/current-downloads').status_code, 401)

    def test_suspension_takes_effect_after_authentication_contention(self):
        self._assert_lock_does_not_bypass_updated_authorization('suspended = 1')

    def test_session_invalidation_takes_effect_after_authentication_contention(self):
        self._assert_lock_does_not_bypass_updated_authorization('session_version = session_version + 1')

    def test_busy_mutation_is_not_replayed_and_recovers(self):
        admin = vdl.db_get_user_by_username('admin')
        blocker = sqlite3.connect(vdl.DB_PATH)
        try:
            blocker.execute('BEGIN IMMEDIATE')
            response = self.client.patch(f"/api/users/{admin['id']}", json={'name': 'Changed'})
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.get_json()['code'], 'database_busy')
        finally:
            blocker.rollback()
            blocker.close()
        self.assertEqual(vdl.db_get_user_by_id(admin['id'])['name'], admin['name'])
        self.assertEqual(self.client.get('/api/current-downloads').status_code, 200)

    def test_failed_publication_rolls_back_receipt_tags_and_download(self):
        source = os.path.join(self.temp_dir.name, 'fixture.mp4')
        with mock.patch.object(vdl.download_history, 'record', side_effect=ValueError('fixture failure')):
            with self.assertRaisesRegex(ValueError, 'fixture failure'):
                vdl.db_insert_ingested_video(
                    'ingest1', source, (1, 2, 3, 4), 'fixture.mp4',
                    'Fixture', 3, self.download_dir,
                    os.path.join(self.download_dir, 'fixture.mp4'), '720p',
                    folder_tags=('Fixture',),
                )
        self.assertIsNone(vdl.db_get_download('ingest1'))
        self.assertEqual(vdl.db_get_ingest_receipts(self.temp_dir.name), {})
        self.assertEqual(vdl.db_list_tags(), [])

    def test_serial_ingest_publication_with_progress_and_authenticated_reads(self):
        # A small synthetic library exercises real publication, tags, receipts,
        # and attempt history. Filesystem copying/probing are outside this seam.
        for index in range(24):
            self.insert(f'existing{index}')
        published = threading.Event()
        release = threading.Event()
        errors = []
        original_record = vdl.download_history.record

        def hold_first_publication(connection, download_id, **kwargs):
            if download_id == 'ingest0':
                published.set()
                if not release.wait(3):
                    raise TimeoutError('test did not release publication')
            return original_record(connection, download_id, **kwargs)

        def ingest():
            try:
                for index in range(8):
                    name = f'fixture{index}.mp4'
                    vdl.db_insert_ingested_video(
                        f'ingest{index}', os.path.join(self.temp_dir.name, name),
                        (1, index, 3, 4), name, 'Fixture', 3,
                        self.download_dir, os.path.join(self.download_dir, name),
                        '720p', folder_tags=('Fixtures',),
                    )
            except BaseException as error:
                errors.append(error)

        def progress():
            try:
                for index in range(12):
                    vdl.db_update_download('existing0', progress=f'{index}%')
            except BaseException as error:
                errors.append(error)

        with mock.patch.object(vdl.download_history, 'record', side_effect=hold_first_publication):
            importer = threading.Thread(target=ingest, name='contention-ingest')
            downloader = threading.Thread(target=progress, name='contention-progress')
            importer.start()
            try:
                self.assertTrue(published.wait(2))
                downloader.start()
                self.assertEqual(self.client.get('/api/current-downloads').status_code, 200)
                self.assertEqual(self.client.get('/api/library').status_code, 200)
                # The ingest transaction remains invisible until all related
                # records are committed together.
                self.assertIsNone(vdl.db_get_download('ingest0'))
                release.set()
                for _ in range(5):
                    self.assertEqual(self.client.get('/api/current-downloads').status_code, 200)
                    self.assertEqual(self.client.get('/api/library').status_code, 200)
            finally:
                release.set()
                importer.join(3)
                if downloader.ident is not None:
                    downloader.join(3)
        self.assertFalse(importer.is_alive())
        self.assertFalse(downloader.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(vdl.db_get_ingest_receipts(self.temp_dir.name)), 8)
        self.assertEqual(vdl.db_get_download('existing0')['progress'], '11%')
        self.assertEqual(vdl.db_get_download('ingest7')['tags'], ['Fixtures'])

    def test_commit_timeout_is_logged_and_rolls_back_the_whole_update(self):
        self.insert()
        with sqlite3.connect(vdl.DB_PATH) as connection:
            connection.execute('PRAGMA journal_mode = DELETE')
        reader = sqlite3.connect(vdl.DB_PATH)
        reader.execute('BEGIN')
        reader.execute('SELECT progress FROM downloads').fetchall()
        try:
            with self.assertLogs(vdl.app.logger, level='WARNING') as logs:
                with self.assertRaises(sqlite3.OperationalError):
                    vdl.db_update_download('test0001', progress='25%')
            diagnostic = '\n'.join(logs.output)
            self.assertIn('operation=db_update_download', diagnostic)
            self.assertIn('phase=commit', diagnostic)
            self.assertIn('result=SQLITE_BUSY code=5', diagnostic)
            self.assertIn('execution_seconds=', diagnostic)
            self.assertIn('commit_seconds=', diagnostic)
        finally:
            reader.rollback()
            reader.close()
        self.assertEqual(vdl.db_get_download('test0001')['progress'], '0%')
        with vdl.db() as connection:
            self.assertEqual(connection.execute('SELECT progress FROM download_attempts').fetchone()[0], '0%')

    def test_slow_diagnostics_do_not_contain_sql_or_private_parameters(self):
        private = 'https://fixture.invalid/private?token=secret'
        with (mock.patch.object(vdl, 'DB_SLOW_TRANSACTION_SECONDS', 0),
              self.assertLogs(vdl.app.logger, level='WARNING') as logs):
            with vdl.db() as connection:
                connection.execute("UPDATE preferences SET value = ? WHERE key = 'format'", (private,))
        diagnostic = '\n'.join(logs.output)
        self.assertIn('thread_name=', diagnostic)
        self.assertIn('timestamp=', diagnostic)
        self.assertNotIn('UPDATE', diagnostic)
        self.assertNotIn(private, diagnostic)

    def test_locked_authentication_never_calls_endpoint_or_retries_lookup(self):
        error = sqlite3.OperationalError('private diagnostic')
        error.sqlite_errorcode = sqlite3.SQLITE_LOCKED
        with mock.patch.object(vdl, 'db_get_user_by_id', side_effect=error) as lookup:
            response = self.client.get('/api/current-downloads')
        self.assertEqual(response.status_code, 503)
        lookup.assert_called_once()
        self.assertEqual(self.client.get('/api/current-downloads').status_code, 200)

    def test_busy_and_locked_codes_are_narrowly_classified(self):
        for code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED, sqlite3.SQLITE_BUSY | (2 << 8)):
            error = sqlite3.OperationalError('private details')
            error.sqlite_errorcode = code
            self.assertTrue(vdl._is_database_busy(error))
        self.assertTrue(vdl._is_database_busy(sqlite3.OperationalError('database is locked')))
        self.assertFalse(vdl._is_database_busy(sqlite3.OperationalError('no such table')))
        error = sqlite3.OperationalError('database is locked')
        error.sqlite_errorcode = sqlite3.SQLITE_CORRUPT
        self.assertFalse(vdl._is_database_busy(error))

    def test_non_busy_operational_errors_are_not_hidden(self):
        with mock.patch.object(vdl, 'db_get_user_by_id', side_effect=sqlite3.OperationalError('no such table')):
            with self.assertRaisesRegex(sqlite3.OperationalError, 'no such table'):
                self.client.get('/api/current-downloads')
