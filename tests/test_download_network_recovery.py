"""Real yt-dlp against silent local HTTP, before progress hooks can run."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from unittest import mock

import vdl
from tests.support.app_case import AppCase


@contextmanager
def stalled_source(stage):
    held = threading.Event()
    release = threading.Event()
    count = [0]
    payload = Path('tests/browser/fixtures/fit-16-9.webm').read_bytes()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            count[0] += 1
            request_number = count[0]
            stall = self.path == '/held.webm' and (
                stage in ('headers', 'metadata-body') or request_number >= 3)
            if stall and stage == 'headers':
                held.set()
                release.wait(10)
            self.send_response(200)
            self.send_header('Content-Type', 'text/html' if stage == 'metadata-body' and stall else 'video/webm')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            if stall and stage != 'headers':
                held.set()
                release.wait(10)
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', held, release, count
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        serving.join(2)


class DownloadNetworkRecoveryTest(AppCase):
    def test_stop_during_real_http_wait_keeps_ownership_until_cleanup(self):
        for rate in ('0', '50'):
            for stage in ('headers', 'metadata-body', 'media-body'):
                with self.subTest(rate=rate, stage=stage), stalled_source(stage) as (base, held, release, count):
                    vdl.db_set_preferences({'max_total_download_mbps': rate, 'max_concurrent': '1'})
                    download_id = self.insert(f'held-{rate}-{stage}', base + '/held.webm')
                    successor = self.insert(f'next-{rate}-{stage}', base + '/next.webm')
                    errors = []
                    try:
                        with mock.patch.object(vdl, 'DOWNLOAD_SOCKET_TIMEOUT', 1), \
                                mock.patch.object(vdl, 'ffprobe_resolution', return_value='360p'), \
                                mock.patch.object(threading, 'excepthook', side_effect=lambda args: errors.append(args.exc_value)):
                            vdl.enqueue_download(base + '/held.webm', download_id)
                            # Cold extractor initialization is much slower under coverage;
                            # the recovery deadline starts after HTTP is reached.
                            self.assertTrue(held.wait(30), 'source never reached the controlled network wait')
                            row = vdl.db_get_download(download_id)
                            self.assertIn(row['progress'], ('Reading source information', 'Waiting for media'))
                            vdl.enqueue_download(base + '/next.webm', successor)
                            self.assertEqual(vdl.db_get_download(successor)['progress'], 'Waiting for a download slot')
                            self.assertEqual(self.client.post('/api/stop/' + download_id).status_code, 200)
                            public = self.client.get('/api/current-downloads').get_json()
                            self.assertIn('Stopping download', next(row for row in public if row['id'] == download_id)['progress'])
                            self.assertIn(download_id, vdl._live_worker_ids)
                            self.assertIn(download_id, vdl._worker_hosts)
                            self.assertEqual(self.client.post('/api/resume/' + download_id).status_code, 409)
                            self.assertEqual(self.client.post('/api/remove/' + download_id).status_code, 409)
                            self.wait_worker_stopped(download_id)
                            self.wait_worker_stopped(successor)
                        self.assertEqual(vdl.db_get_download(download_id)['status'], 'cancelled')
                        self.assertEqual(vdl.db_get_download(successor)['status'], 'finished')
                        self.assertEqual(errors, [])
                        self.assertEqual(vdl._active_worker_count, 0)
                        self.assertEqual(self.client.post('/api/remove/' + download_id).status_code, 200)
                    finally:
                        release.set()
                        self.wait_worker_stopped(download_id)
                        self.wait_worker_stopped(successor)

    def test_silent_source_reaches_actionable_error_without_stop(self):
        for rate, stage in (('0', 'headers'), ('50', 'headers'), ('0', 'media-body'), ('50', 'media-body')):
            with self.subTest(rate=rate, stage=stage), stalled_source(stage) as (base, held, release, count):
                vdl.db_set_preferences({'max_total_download_mbps': rate})
                download_id = self.insert('timeout-' + rate + stage, base + '/held.webm')
                try:
                    with mock.patch.object(vdl, 'DOWNLOAD_SOCKET_TIMEOUT', 0.2):
                        vdl.enqueue_download(base + '/held.webm', download_id)
                        self.assertTrue(held.wait(30))
                        self.wait_worker_stopped(download_id)
                    row = vdl.db_get_download(download_id)
                    self.assertEqual(row['status'], 'error')
                    self.assertIsNotNone(row['finished_at'])
                    self.assertIn('timed out', row['progress'].lower())
                finally:
                    release.set()
                    self.wait_worker_stopped(download_id)
