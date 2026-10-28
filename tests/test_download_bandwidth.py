import io
import os
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

import yt_dlp
from yt_dlp.downloader.external import FFmpegFD
from yt_dlp.downloader import get_suitable_downloader
from yt_dlp.downloader.hls import HlsFD
from yt_dlp.networking import Response
from yt_dlp.utils import DownloadError, Popen

import vdl
from download_bandwidth import (
    SharedBandwidth, _MediaResponse, _guarded_popen, _guard_external, govern_download,
)
from tests.support.app_case import AppCase
from tests.support.fixture_server import FixtureHandler, fixture_server


class SharedBandwidthTest(unittest.TestCase):
    def test_aggregate_credit_is_bounded_with_deterministic_time(self):
        now = [0.0]
        controller = SharedBandwidth(clock=lambda: now[0])
        controller.configure('16')
        total = 0
        for tick in range(50):
            now[0] = tick / 10
            for _ in range(10 if tick == 0 else 12):
                granted, _ = controller.take('one' if tick % 2 else 'two', 16384)
                total += granted
            self.assertLessEqual(total, 2000000 * now[0] + 2000000)
        # The entire bucket is shared, rather than allocated separately by job.
        self.assertGreater(total, 8000000)

    def test_short_reads_refund_only_unused_bytes_and_retries_count_again(self):
        controller = SharedBandwidth()
        controller.configure('1')
        response = _MediaResponse(io.BytesIO(b'x' * 100), controller, 'one')
        self.assertEqual(len(response.read(1000)), 100)
        self.assertEqual(response.read(1000), b'')
        self.assertGreater(controller.tokens, 124000)
        retry = _MediaResponse(io.BytesIO(b'x' * 100), controller, 'one')
        retry.read(1000)
        self.assertLess(controller.tokens, 124950)

    def test_waiting_readers_get_fifo_turns_and_can_use_idle_capacity(self):
        now = [0.0]
        controller = SharedBandwidth(clock=lambda: now[0])
        controller.configure('0.01')
        for _ in range(10):
            controller.take('seed', 125)
        order = []
        readers = []
        for name in ('one', 'two', 'three'):
            reader = threading.Thread(target=lambda job=name: (
                controller.take(job, 125), order.append(job)))
            reader.start()
            readers.append(reader)
            deadline = time.monotonic() + 1
            while len(controller.waiters) < len(readers) and time.monotonic() < deadline:
                time.sleep(0.001)
        for count in range(1, 4):
            now[0] = count / 10 + 0.00001
            controller.wake()
            deadline = time.monotonic() + 1
            while len(order) < count and time.monotonic() < deadline:
                time.sleep(0.001)
        controller.configure('0')
        for reader in readers:
            reader.join(1)
        self.assertEqual(order, ['one', 'two', 'three'])
        controller.configure('1')
        self.assertEqual(controller.take('only-job', 12500)[0], 12500)

    def test_live_updates_lower_raise_and_unlimited_wake_readers(self):
        controller = SharedBandwidth()
        controller.configure('16')
        controller.configure('1')
        self.assertLessEqual(controller.tokens, 125000)
        self.assertLessEqual(controller.take('one', 1000000)[0], 12500)
        controller.configure('0.01')
        controller.tokens = 0
        result = []
        reader = threading.Thread(target=lambda: result.append(controller.take('one', 100000)))
        reader.start()
        controller.configure('0')
        reader.join(1)
        self.assertFalse(reader.is_alive())
        self.assertEqual(result[0][0], 100000)
        controller.configure('16')
        self.assertEqual(controller.take('one', 100000)[0], 16384)

    def test_stop_interrupts_wait_and_pause_owns_no_private_credit(self):
        cancelled = threading.Event()
        paused = threading.Event()
        resumed = threading.Event()
        controller = SharedBandwidth(cancelled=lambda _: cancelled.is_set(),
                                     paused=lambda _: paused.is_set(),
                                     pause=lambda _: resumed.wait(1))
        controller.configure('0.01')
        controller.tokens = 0
        errors = []

        def read():
            try:
                controller.take('one', 125)
            except InterruptedError:
                errors.append('cancelled')

        reader = threading.Thread(target=read)
        reader.start()
        cancelled.set()
        controller.wake()
        reader.join(1)
        self.assertEqual(errors, ['cancelled'])
        self.assertEqual(len(controller.waiters), 0)
        cancelled.clear()
        paused.set()
        reader = threading.Thread(target=read)
        reader.start()
        deadline = time.monotonic() + 1
        while controller.waiters and time.monotonic() < deadline:
            time.sleep(0.001)
        self.assertEqual(len(controller.waiters), 0)
        controller.configure('16')
        paused.clear()
        resumed.set()
        reader.join(1)
        self.assertFalse(reader.is_alive())
        self.assertLessEqual(controller.tokens, controller.rate)

    def test_unlimited_metadata_zero_and_read_all_keep_response_contract(self):
        controller = SharedBandwidth()
        with _MediaResponse(io.BytesIO(b'fixture'), controller, 'one') as response:
            self.assertEqual(response.read(0), b'')
            self.assertEqual(response.read(), b'fixture')
        self.assertTrue(response.response.closed)
        # Responses used by the extractor remain outside the budget.
        with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
            raw = Response(io.BytesIO(b'metadata'), 'http://fixture.invalid', {})
            ydl.urlopen = lambda *_args, **_kwargs: raw
            govern_download(ydl, controller, 'one')
            self.assertIs(ydl.urlopen('http://fixture.invalid'), raw)
            raw.close()

    def test_aggregated_read_keeps_each_allowance_interruptible(self):
        cancelled = threading.Event()
        paused = threading.Event()
        controller = SharedBandwidth(cancelled=lambda _: cancelled.is_set(),
                                     paused=lambda _: paused.is_set(),
                                     pause=lambda _: paused.clear())
        controller.configure('128')

        class Source(io.BytesIO):
            def read(self, size):
                data = super().read(size)
                cancelled.set()
                return data

        source = Source(b'x' * 65536)
        with self.assertRaises(InterruptedError):
            _MediaResponse(source, controller, 'one').read(65536)
        self.assertEqual(source.tell(), 16384)
        cancelled.clear()

        class LiveSource(io.BytesIO):
            def read(self, size):
                data = super().read(size)
                if self.tell() == 16384:
                    paused.set()
                    controller.configure('0')
                return data

        source = LiveSource(b'x' * 65536)
        with mock.patch.object(controller, 'pause', wraps=controller.pause) as pause:
            self.assertEqual(len(_MediaResponse(source, controller, 'one').read(65536)), 65536)
            pause.assert_called_once_with('one')
        self.assertFalse(paused.is_set())

    def test_aggregation_yields_for_progress_even_when_caller_requests_a_large_buffer(self):
        now = [0.0]
        controller = SharedBandwidth(clock=lambda: now[0])
        controller.configure('128')

        class Source(io.BytesIO):
            def read(self, size):
                now[0] += 0.1
                return super().read(size)

        source = Source(b'x' * 65536)
        self.assertEqual(len(_MediaResponse(source, controller, 'one').read(65536)), 16384)
        self.assertEqual(source.tell(), 16384)

    def test_external_process_rejected_under_cap_and_stopped_on_live_enable(self):
        controller = SharedBandwidth()
        guarded = _guarded_popen(Popen, controller, 'one')
        controller.configure('1')
        with self.assertRaisesRegex(DownloadError, 'Unsupported media transfer'):
            guarded([sys.executable, '-c', 'pass'])
        controller.configure('0')
        with guarded([sys.executable, '-c', 'import time; time.sleep(10)']) as process:
            controller.configure('1')
            with self.assertRaisesRegex(DownloadError, 'Unsupported media transfer'):
                process.wait()
            self.assertIsNotNone(process.poll())
        controller.configure('0')
        with guarded([sys.executable, '-c', 'print("fixture")'], stdout=subprocess.PIPE) as process:
            self.assertEqual(process.communicate()[0].strip(), b'fixture')

    def test_live_cap_kills_external_child_even_when_caller_is_reading_stderr(self):
        controller = SharedBandwidth()
        guarded = _guarded_popen(Popen, controller, 'one')
        with guarded([sys.executable, '-c', 'import time; time.sleep(10)'],
                     stderr=subprocess.PIPE) as process:
            controller.configure('1')
            self.assertEqual(process.stderr.read(), b'')
            with self.assertRaisesRegex(DownloadError, 'Unsupported media transfer'):
                process.wait()
            self.assertIsNotNone(process.poll())

    def test_external_adapter_uses_private_process_guard_without_global_mutation(self):
        class ChildDownloader:
            def transfer(self):
                return Popen.run([sys.executable, '-c', 'print("fixture")'], stdout=subprocess.PIPE)

        controller = SharedBandwidth()
        child = ChildDownloader()
        transfer = _guard_external(child.transfer, controller, 'one')
        self.assertEqual(transfer()[0].strip(), b'fixture')
        controller.configure('1')
        with self.assertRaisesRegex(DownloadError, 'Unsupported media transfer'):
            transfer()
        self.assertIs(child.transfer.__func__.__globals__['Popen'], Popen)

    def test_external_stop_and_timeout_are_interruptible(self):
        cancel = threading.Event()
        controller = SharedBandwidth(cancelled=lambda _: cancel.is_set())
        guarded = _guarded_popen(Popen, controller, 'one')
        with guarded([sys.executable, '-c', 'import time; time.sleep(10)']) as process:
            with self.assertRaises(subprocess.TimeoutExpired):
                process.communicate(timeout=0.01)
            cancel.set()
            with self.assertRaises(InterruptedError):
                process.communicate()
            self.assertIsNotNone(process.poll())


class NativeMediaBandwidthTest(AppCase):
    def test_reported_rates_transfer_with_slow_application_progress(self):
        payload = b'x' * (8 * 1024 * 1024)
        with open(os.path.join(self.temp_dir.name, 'rates.mp4'), 'wb') as output:
            output.write(payload)
        with fixture_server(self.temp_dir.name) as server:
            for rate in ('50', '10', '0'):
                with self.subTest(rate=rate):
                    download_id = 'rate-' + rate
                    vdl.db_set_preferences({'max_total_download_mbps': rate})
                    vdl.db_insert_download(download_id, server.base_url + '/rates.mp4')

                    def progress(data):
                        time.sleep(0.005)
                        vdl.progress_hook(data, download_id)

                    destination = os.path.join(self.download_dir, download_id + '.mp4')
                    started = time.monotonic()
                    with yt_dlp.YoutubeDL({'quiet': True, 'noprogress': True,
                                          'progress_hooks': [progress]}) as ydl:
                        govern_download(ydl, vdl._bandwidth, download_id)
                        success, _ = ydl.dl(destination, {
                            'url': server.base_url + '/rates.mp4', 'protocol': 'http',
                            'ext': 'mp4', 'id': download_id, 'title': 'fixture',
                        })
                    elapsed = time.monotonic() - started
                    self.assertTrue(success)
                    self.assertEqual(vdl.db_get_download(download_id)['downloaded_bytes'], len(payload))
                    self.assertEqual(os.path.getsize(destination), len(payload))
                    if rate != '0':
                        bytes_per_second = float(rate) * 125000
                        # One second of initial credit is allowed. Check both
                        # the cap and useful throughput, with room for tracing.
                        minimum = max(0, len(payload) / bytes_per_second - 1)
                        self.assertGreaterEqual(elapsed + 0.02, minimum)
                        self.assertLess(elapsed, max(1, minimum) * 1.5 + 0.5)
                    else:
                        self.assertLess(elapsed, 2)

    def test_capped_concurrent_http_keeps_useful_throughput_with_slow_progress(self):
        payload = b'x' * (8 * 1024 * 1024)
        with open(os.path.join(self.temp_dir.name, 'large.mp4'), 'wb') as output:
            output.write(payload)
        measurements = []
        with fixture_server(self.temp_dir.name) as server:
            for rate in ('0', '256'):
                vdl.db_set_preferences({'max_total_download_mbps': rate})
                calls = [0, 0]
                errors = []

                def download(index):
                    download_id = f'large-{rate}-{index}'
                    vdl.db_insert_download(download_id, server.base_url + '/large.mp4')

                    def progress(data):
                        # Model the same storage/UI publication cost in both modes.
                        time.sleep(0.005)
                        vdl.progress_hook(data, download_id)
                        calls[index] += 1

                    try:
                        destination = os.path.join(self.download_dir, download_id + '.mp4')
                        with yt_dlp.YoutubeDL({'quiet': True, 'noprogress': True,
                                              'progress_hooks': [progress]}) as ydl:
                            govern_download(ydl, vdl._bandwidth, download_id)
                            success, _ = ydl.dl(destination, {
                                'url': server.base_url + '/large.mp4', 'protocol': 'http',
                                'ext': 'mp4', 'id': download_id, 'title': 'fixture',
                            })
                        self.assertTrue(success)
                        self.assertEqual(vdl.db_get_download(download_id)['downloaded_bytes'], len(payload))
                        with open(destination, 'rb') as source:
                            self.assertEqual(source.read(), payload)
                    except BaseException as exc:
                        errors.append(exc)

                with mock.patch.object(vdl._bandwidth.condition, 'wait',
                                       wraps=vdl._bandwidth.condition.wait) as waits:
                    started = time.monotonic()
                    workers = [threading.Thread(target=download, args=(index,)) for index in range(2)]
                    for worker in workers:
                        worker.start()
                    for worker in workers:
                        worker.join(15)
                    self.assertTrue(all(not worker.is_alive() for worker in workers))
                    measurements.append((time.monotonic() - started, sum(calls)))
                    # Both payloads fit in the shared initial burst allowance.
                    self.assertEqual(waits.call_count, 0)
                self.assertEqual(errors, [])
        self.assertLess(measurements[1][1], 128, 'Tiny allowances must not each publish progress')
        self.assertLess(measurements[1][0], 3 * measurements[0][0] + 0.5)

    def test_unlimited_preserves_downloader_selection_and_options(self):
        controller = SharedBandwidth()
        info = {'url': 'https://fixture.invalid/video.m3u8', 'protocol': 'm3u8',
                'ext': 'mp4', 'is_live': False}
        for options in ({}, {'hls_prefer_native': False,
                             'external_downloader': {'default': 'ffmpeg'}}):
            with self.subTest(options=options), yt_dlp.YoutubeDL({'quiet': True, **options}) as ydl:
                original = dict(ydl.params)
                expected = get_suitable_downloader(dict(info), ydl.params)
                govern_download(ydl, controller, 'unlimited')
                self.assertEqual(ydl.params, original)
                self.assertIs(get_suitable_downloader(dict(info), ydl.params), expected)

    def test_live_rate_changes_restore_transport_options_before_each_transfer(self):
        controller = SharedBandwidth()
        info = {'url': 'https://fixture.invalid/video.m3u8', 'protocol': 'm3u8',
                'ext': 'mp4', 'is_live': False, 'id': 'live-options', 'title': 'fixture'}
        for initial in ('0', '1'):
            with self.subTest(initial=initial), yt_dlp.YoutubeDL({'quiet': True}) as ydl:
                controller.configure(initial)
                selected = []
                govern_download(ydl, controller, 'live-options')
                with mock.patch.object(FFmpegFD, 'real_download',
                                       side_effect=lambda *_: selected.append('external') or True), \
                        mock.patch.object(HlsFD, 'real_download',
                                          side_effect=lambda *_: selected.append('native') or True):
                    for rate in ('0', '1', '0'):
                        controller.configure(rate)
                        success, _ = ydl.dl(os.path.join(self.download_dir, 'selection.mp4'), dict(info))
                        self.assertTrue(success)
                self.assertEqual(selected, ['external', 'native', 'external'])

    def test_simultaneous_http_hls_and_dash_payload_share_one_real_budget(self):
        payload = b'x' * 90000
        for name in ('one.mp4', 'two.ts', 'three.ts'):
            with open(os.path.join(self.temp_dir.name, name), 'wb') as output:
                output.write(payload)
        with open(os.path.join(self.temp_dir.name, 'fixture.m3u8'), 'w') as output:
            output.write('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n'
                         '#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\ntwo.ts\n'
                         '#EXTINF:1,\nthree.ts\n#EXT-X-ENDLIST\n')
        controller = SharedBandwidth()
        controller.configure('0.8')  # 100 kB/s across both clients
        delivered = []
        original_read = _MediaResponse.read
        lock = threading.Lock()
        errors = []

        def measured_read(response, size=-1):
            data = original_read(response, size)
            # A read-all recursively uses the bounded reads; count those once.
            if size is not None and size > 0:
                with lock:
                    delivered.append((time.monotonic(), len(data)))
            return data

        def download(name, protocol, output):
            try:
                with yt_dlp.YoutubeDL({'quiet': True, 'noprogress': True}) as ydl:
                    govern_download(ydl, controller, output)
                    info = {
                        'url': server.base_url + '/' + name, 'protocol': protocol,
                        'ext': 'mp4', 'id': output, 'title': output,
                    }
                    if protocol == 'http_dash_segments':
                        info['fragments'] = [
                            {'url': server.base_url + '/two.ts'},
                            {'url': server.base_url + '/three.ts'},
                        ]
                    success, _ = ydl.dl(os.path.join(self.download_dir, output), info)
                    self.assertTrue(success)
            except BaseException as exc:
                errors.append(exc)

        with fixture_server(self.temp_dir.name) as server, mock.patch.object(_MediaResponse, 'read', measured_read):
            started = time.monotonic()
            workers = [threading.Thread(target=download, args=args) for args in (
                ('one.mp4', 'http', 'http.mp4'), ('fixture.m3u8', 'm3u8_native', 'hls.mp4'),
                ('fixture.mpd', 'http_dash_segments', 'dash.mp4'))]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(10)
            self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(errors, [])
        total = 0
        for timestamp, size in sorted(delivered):
            total += size
            self.assertLessEqual(total, 100000 * (timestamp - started) + 100000 + 1000)
        self.assertGreaterEqual(total, 450000)
        self.assertEqual(os.path.getsize(os.path.join(self.download_dir, 'http.mp4')), 90000)
        self.assertEqual(os.path.getsize(os.path.join(self.download_dir, 'hls.mp4')), 180000)
        self.assertEqual(os.path.getsize(os.path.join(self.download_dir, 'dash.mp4')), 180000)

    def test_resumed_http_counts_only_new_bytes_and_a_retry_spends_again(self):
        payload = b'x' * 90000
        with open(os.path.join(self.temp_dir.name, 'resume.mp4'), 'wb') as output:
            output.write(payload)
        destination = os.path.join(self.download_dir, 'resume.mp4')
        with open(destination + '.part', 'wb') as partial:
            partial.write(payload[:30000])
        controller = SharedBandwidth()
        controller.configure('1')
        received = []
        original_read = _MediaResponse.read

        def count_read(response, size=-1):
            data = original_read(response, size)
            if size > 0:
                received.append(len(data))
            return data

        with fixture_server(self.temp_dir.name) as server, mock.patch.object(_MediaResponse, 'read', count_read):
            for attempt in range(2):
                with yt_dlp.YoutubeDL({'quiet': True, 'noprogress': True}) as ydl:
                    govern_download(ydl, controller, 'resumed-job')
                    success, _ = ydl.dl(destination, {
                        'url': server.base_url + '/resume.mp4', 'protocol': 'http',
                        'ext': 'mp4', 'id': 'resumed-job', 'title': 'fixture',
                    })
                    self.assertTrue(success)
                if attempt == 0:
                    self.assertEqual(sum(received), 60000)
                    os.remove(destination)
            self.assertEqual(sum(received), 150000)
            self.assertTrue(any(start == 30000 for _path, start, _end in
                                FixtureHandler.range_requests))
        with open(destination, 'rb') as output:
            self.assertEqual(output.read(), payload)

    def test_app_pause_and_stop_at_the_read_boundary_preserve_progress(self):
        download_id = self.insert('readpause')
        vdl.db_update_download(download_id, status='downloading', downloaded_bytes=42, progress='42%')
        vdl.db_set_preferences({'max_total_download_mbps': '0.01'})
        vdl.request_pause(download_id)
        results = []
        reader = threading.Thread(target=lambda: results.append(
            _MediaResponse(io.BytesIO(b'payload'), vdl._bandwidth, download_id).read(7)))
        reader.start()
        deadline = time.monotonic() + 1
        while vdl.db_get_download(download_id)['status'] != 'paused' and time.monotonic() < deadline:
            time.sleep(0.001)
        self.assertEqual(vdl.db_get_download(download_id)['downloaded_bytes'], 42)
        self.assertEqual(len(vdl._bandwidth.waiters), 0)
        vdl.clear_pause(download_id)
        reader.join(1)
        self.assertFalse(reader.is_alive())
        self.assertEqual(results, [b'payload'])
        self.assertEqual(vdl.db_get_download(download_id)['progress'], '42%')

    def test_hls_external_fallback_and_ffmpeg_fail_before_process_creation(self):
        controller = SharedBandwidth()
        controller.configure('1')
        with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
            govern_download(ydl, controller, 'one')
            manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n'
            # An unfinished live manifest requires ffmpeg after native HLS reads it.
            info = {'url': 'http://fixture.invalid/live.m3u8', 'ext': 'mp4',
                    'is_live': True, 'hls_media_playlist_data': manifest}
            with mock.patch('yt_dlp.downloader.external.Popen') as process:
                with self.assertRaisesRegex(DownloadError, 'Unsupported media transfer'):
                    HlsFD(ydl, ydl.params).real_download(os.path.join(self.download_dir, 'live.mp4'), info)
                with self.assertRaisesRegex(DownloadError, 'Unsupported media transfer'):
                    FFmpegFD(ydl, ydl.params).real_download(os.path.join(self.download_dir, 'live.mp4'), info)
                process.assert_not_called()


if __name__ == '__main__':
    unittest.main()
