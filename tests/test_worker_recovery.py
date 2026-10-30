"""Regressions for workers that fail before their first progress callback."""

import sqlite3
import threading
import time
from unittest import mock

import vdl
from tests.support.app_case import AppCase
from tests.support.fake_ytdlp import FakeYoutubeDL


class WorkerRecoveryTest(AppCase):
    def test_setup_sqlite_timeout_publishes_failure_and_releases_successor(self):
        self.insert('orphan')
        self.insert('successor', 'https://other.invalid/video')
        vdl.db_set_preferences({'max_concurrent': '1'})
        original_update = vdl.db_update_download
        failed = threading.Event()
        errors = []
        FakeYoutubeDL.reset()

        def contend(download_id, **changes):
            if download_id == 'orphan' and set(changes) == {'output_dir'}:
                blocker = sqlite3.connect(vdl.DB_PATH)
                blocker.execute('BEGIN IMMEDIATE')
                try:
                    return original_update(download_id, **changes)
                finally:
                    blocker.rollback()
                    blocker.close()
                    failed.set()
            return original_update(download_id, **changes)

        with mock.patch.object(vdl, 'db_update_download', side_effect=contend), \
                mock.patch.object(vdl.yt_dlp, 'YoutubeDL', FakeYoutubeDL), \
                mock.patch.object(vdl, 'ffprobe_resolution', return_value='360p'), \
                mock.patch.object(threading, 'excepthook', side_effect=lambda args: errors.append(args.exc_value)):
            vdl.enqueue_download('https://fixture.invalid/video', 'orphan')
            self.assertTrue(failed.wait(3))
            vdl.enqueue_download('https://other.invalid/video', 'successor')
            self.wait_worker_stopped('orphan')
            self.wait_worker_stopped('successor')
        row = vdl.db_get_download('orphan')
        self.assertEqual(row['status'], 'error')
        self.assertIn('database is locked', row['progress'])
        self.assertIsNotNone(row['finished_at'])
        self.assertIsNone(row['downloaded_bytes'])
        self.assertEqual(errors, [])
        self.assertEqual(vdl.db_get_download('successor')['status'], 'finished')
        self.assertEqual(vdl._active_worker_count, 0)
        self.assertEqual(self.client.post('/api/remove/orphan').status_code, 200)

    def test_terminal_sqlite_timeouts_retry_until_persistence_recovers(self):
        for outcome in ('finished', 'cancelled', 'error'):
            with self.subTest(outcome=outcome):
                download_id = self.insert('terminal-' + outcome)
                original_update = vdl.db_update_download
                blocked = threading.Event()
                errors = []
                FakeYoutubeDL.reset()
                blocker = sqlite3.connect(vdl.DB_PATH, check_same_thread=False)
                attempts = []

                def contend(candidate, **changes):
                    if candidate == download_id and changes.get('status') in vdl.TERMINAL_STATUSES:
                        attempts.append(changes['status'])
                        if len(attempts) == 1:
                            blocker.execute('BEGIN IMMEDIATE')
                        try:
                            return original_update(candidate, **changes)
                        finally:
                            blocked.set()
                    return original_update(candidate, **changes)

                def download(_self, _urls):
                    if outcome == 'cancelled':
                        raise vdl.DownloadCancelled()
                    if outcome == 'error':
                        raise ValueError('original diagnostic')
                    return FakeYoutubeDL.download(_self, _urls)

                class OutcomeYoutubeDL(FakeYoutubeDL):
                    pass
                OutcomeYoutubeDL.download = download

                try:
                    with mock.patch.object(vdl, 'db_update_download', side_effect=contend), \
                            mock.patch.object(vdl.yt_dlp, 'YoutubeDL', OutcomeYoutubeDL), \
                            mock.patch.object(vdl, 'ffprobe_resolution', return_value='360p'), \
                            mock.patch.object(threading, 'excepthook', side_effect=lambda args: errors.append(args.exc_value)):
                        vdl.enqueue_download('https://fixture.invalid/video', download_id)
                        self.assertTrue(blocked.wait(4))
                        # Keep the write lock beyond the first terminal failure;
                        # recovery must not depend on one lucky fallback write.
                        time.sleep(1.2)
                        blocker.rollback()
                        self.wait_worker_stopped(download_id)
                    row = vdl.db_get_download(download_id)
                    self.assertEqual(row['status'], outcome)
                    self.assertIsNotNone(row['finished_at'])
                    if outcome == 'error':
                        self.assertEqual(row['progress'], 'original diagnostic')
                    self.assertEqual(set(attempts), {outcome})
                    self.assertEqual(errors, [])
                finally:
                    blocker.rollback()
                    blocker.close()
                    self.wait_worker_stopped(download_id)

    def test_stop_recovers_dead_url_rows_and_continue_claims_only_once(self):
        for status in ('starting', 'downloading', 'paused'):
            download_id = self.insert('dead-' + status)
            vdl.db_update_download(download_id, status=status)
            self.assertEqual(self.client.post('/api/stop/' + download_id).status_code, 200)
            self.assertEqual(vdl.db_get_download(download_id)['status'], 'cancelled')
            self.assertEqual(self.client.post('/api/remove/' + download_id).status_code, 200)

        download_id = self.insert('dead-resume')
        self.client.post('/api/stop/' + download_id)
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.client.post('/api/resume/' + download_id).status_code, 200)
            self.assertEqual(self.client.post('/api/resume/' + download_id).status_code, 409)
        enqueue.assert_called_once_with('https://fixture.invalid/video', download_id)

    def test_preparation_failures_are_actionable_and_redact_browser_secrets(self):
        cookie = {'name': 'session_cookie', 'value': 'private-value'}
        for operation in ('preferences', 'format', 'preparing'):
            with self.subTest(operation=operation):
                download_id = self.insert('setup-' + operation)
                original_update = vdl.db_update_download
                original_preferences = vdl.db_get_preferences
                preferences_failed = threading.Event()

                def update(candidate, **changes):
                    if ((operation == 'format' and 'requested_format' in changes)
                            or (operation == 'preparing' and changes.get('progress') == 'Preparing download')):
                        raise ValueError('session_cookie private-value failed')
                    return original_update(candidate, **changes)

                def preferences():
                    # Fail inside the worker, after the scheduler has admitted it.
                    if (operation == 'preferences' and not preferences_failed.is_set()
                            and threading.current_thread() is not threading.main_thread()):
                        preferences_failed.set()
                        raise ValueError('session_cookie private-value failed')
                    return original_preferences()

                with mock.patch.object(vdl, 'db_update_download', side_effect=update), \
                        mock.patch.object(vdl, 'db_get_preferences', side_effect=preferences), \
                        mock.patch.object(vdl.yt_dlp, 'YoutubeDL') as ydl:
                    vdl.enqueue_download('https://fixture.invalid/video', download_id, [cookie])
                    self.wait_worker_stopped(download_id)
                row = vdl.db_get_download(download_id)
                self.assertEqual(row['status'], 'error')
                self.assertIn('<redacted>', row['progress'])
                self.assertNotIn('private-value', row['progress'])
                self.assertNotIn('session_cookie', row['progress'])
                ydl.assert_not_called()
