import os
import threading
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class ControlledYoutubeDL:
    """Block downloads so the test can observe worker overlap."""

    lock = threading.Lock()
    release_download = threading.Semaphore(0)
    first_entered = threading.Event()
    second_entered = threading.Event()
    active = 0
    max_active = 0
    entered = 0

    def __init__(self, options):
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def extract_info(self, url, download=False):
        return {
            "title": "fixture",
            "formats": [{
                "format_id": "combined",
                "ext": "mp4",
                "height": 360,
                "vcodec": "h264",
                "acodec": "aac",
            }],
        }

    def download(self, urls):
        with self.lock:
            type(self).active += 1
            type(self).entered += 1
            type(self).max_active = max(type(self).max_active, type(self).active)
            if type(self).entered == 1:
                type(self).first_entered.set()
            elif type(self).entered == 2:
                type(self).second_entered.set()

        self.release_download.acquire(timeout=2)

        output_path = (
            self.options["outtmpl"]
            .replace("%(title)s", "fixture")
            .replace("%(ext)s", "mp4")
        )
        with open(output_path, "wb") as output_file:
            output_file.write(b"fixture")
        info = {"title": "fixture", "_filename": output_path, "filepath": output_path}
        for hook in self.options["progress_hooks"]:
            hook({"status": "finished", "filename": output_path, "info_dict": info})
        for hook in self.options.get("postprocessor_hooks", []):
            hook({"status": "finished", "info_dict": info})

        with self.lock:
            type(self).active -= 1


class MaxConcurrentDownloadsTest(AppCase):
    def setUp(self):
        super().setUp()
        vdl.db_set_preferences({
            "download_dir": self.download_dir,
            "max_concurrent": 1,
        })

        ControlledYoutubeDL.release_download = threading.Semaphore(0)
        ControlledYoutubeDL.first_entered = threading.Event()
        ControlledYoutubeDL.second_entered = threading.Event()
        ControlledYoutubeDL.active = 0
        ControlledYoutubeDL.max_active = 0
        ControlledYoutubeDL.entered = 0

    def test_second_download_waits_for_available_worker_slot(self):
        urls = ["https://fixture.invalid/one", "https://fixture.invalid/two"]
        ids = ["worker01", "worker02"]
        for download_id, url in zip(ids, urls):
            vdl.db_insert_download(download_id, url)

        workers = [
            threading.Thread(target=vdl.background_download, args=(url, download_id))
            for download_id, url in zip(ids, urls)
        ]

        with (
            mock.patch.object(vdl.yt_dlp, "YoutubeDL", ControlledYoutubeDL),
            mock.patch.object(vdl, "ffprobe_resolution", return_value="360p"),
        ):
            workers[0].start()
            self.assertTrue(ControlledYoutubeDL.first_entered.wait(1))
            workers[1].start()

            second_started_while_first_was_active = (
                ControlledYoutubeDL.second_entered.wait(0.2)
            )
            queued_status = vdl.db_get_download(ids[1])["status"]
            ControlledYoutubeDL.release_download.release()
            second_eventually_started = ControlledYoutubeDL.second_entered.wait(1)
            ControlledYoutubeDL.release_download.release()
            for worker in workers:
                worker.join(2)

        self.assertFalse(second_started_while_first_was_active)
        self.assertEqual(queued_status, "starting")
        self.assertTrue(second_eventually_started)
        self.assertEqual(ControlledYoutubeDL.max_active, 1)
        self.assertFalse(any(worker.is_alive() for worker in workers))

    def test_queued_download_can_be_cancelled_without_entering_yt_dlp(self):
        urls = ["https://fixture.invalid/one", "https://fixture.invalid/two"]
        ids = ["cancel01", "cancel02"]
        for download_id, url in zip(ids, urls):
            vdl.db_insert_download(download_id, url)

        workers = [
            threading.Thread(target=vdl.background_download, args=(url, download_id))
            for download_id, url in zip(ids, urls)
        ]

        with (
            mock.patch.object(vdl.yt_dlp, "YoutubeDL", ControlledYoutubeDL),
            mock.patch.object(vdl, "ffprobe_resolution", return_value="360p"),
        ):
            workers[0].start()
            self.assertTrue(ControlledYoutubeDL.first_entered.wait(1))
            workers[1].start()
            self.assertFalse(ControlledYoutubeDL.second_entered.wait(0.2))

            vdl.request_cancel(ids[1])
            workers[1].join(1)
            queued_status = vdl.db_get_download(ids[1])["status"]

            ControlledYoutubeDL.release_download.release()
            workers[0].join(2)

        self.assertEqual(queued_status, "cancelled")
        self.assertFalse(ControlledYoutubeDL.second_entered.is_set())
        self.assertFalse(any(worker.is_alive() for worker in workers))

    def test_increasing_limit_wakes_a_queued_download(self):
        urls = ["https://fixture.invalid/one", "https://fixture.invalid/two"]
        ids = ["resize01", "resize02"]
        for download_id, url in zip(ids, urls):
            vdl.db_insert_download(download_id, url)

        workers = [
            threading.Thread(target=vdl.background_download, args=(url, download_id))
            for download_id, url in zip(ids, urls)
        ]

        with (
            mock.patch.object(vdl.yt_dlp, "YoutubeDL", ControlledYoutubeDL),
            mock.patch.object(vdl, "ffprobe_resolution", return_value="360p"),
        ):
            workers[0].start()
            self.assertTrue(ControlledYoutubeDL.first_entered.wait(1))
            workers[1].start()
            self.assertFalse(ControlledYoutubeDL.second_entered.wait(0.2))

            vdl.db_set_preferences({"max_concurrent": 2})
            self.assertTrue(ControlledYoutubeDL.second_entered.wait(1))

            ControlledYoutubeDL.release_download.release()
            ControlledYoutubeDL.release_download.release()
            for worker in workers:
                worker.join(2)

        self.assertEqual(ControlledYoutubeDL.max_active, 2)
        self.assertFalse(any(worker.is_alive() for worker in workers))


class QueueAdmissionTest(AppCase):
    def setUp(self):
        super().setUp()
        self.started = []
        self.real_thread = threading.Thread
        self.thread_patch = mock.patch.object(vdl.threading, 'Thread')
        self.thread_factory = self.thread_patch.start()
        self.addCleanup(self.thread_patch.stop)
        self.thread_factory.side_effect = self.record_thread

    def record_thread(self, target, args, **kwargs):
        self.started.append(args[1])
        return mock.Mock()

    def queue(self, download_id, host='a.example'):
        url = f'https://{host}/{download_id}'
        self.insert(download_id, url)
        vdl.enqueue_download(url, download_id)

    def finish(self, download_id):
        with vdl._worker_condition:
            vdl._live_worker_ids.discard(download_id)
        vdl.db_update_download(download_id, status='finished')
        vdl._release_worker_slot(download_id)

    def test_oldest_eligible_job_skips_blocked_host_and_keeps_host_fifo(self):
        for download_id, host in [('a1', 'a.example'), ('a2', 'a.example'),
                                  ('a3', 'a.example'), ('b1', 'b.example'),
                                  ('a4', 'a.example')]:
            self.queue(download_id, host)
        self.assertEqual(self.started, ['a1', 'a2', 'b1'])
        self.assertEqual(vdl.db_get_download('a3')['progress'], 'Waiting for a download slot')
        self.finish('a1')
        self.assertEqual(self.started, ['a1', 'a2', 'b1', 'a3'])
        self.finish('a2')
        self.assertEqual(self.started[-1], 'a4')

    def test_global_limit_wins_and_lowering_drains_without_stopping_active_jobs(self):
        vdl.db_set_preferences({'max_concurrent': 2, 'max_concurrent_per_host': 3})
        for i in range(4):
            self.queue(f'job{i}', f'{i}.example')
        self.assertEqual(self.started, ['job0', 'job1'])
        vdl.db_set_preferences({'max_concurrent': 1})
        self.finish('job0')
        self.assertEqual(self.started, ['job0', 'job1'])
        self.finish('job1')
        self.assertEqual(self.started, ['job0', 'job1', 'job2'])
        vdl.db_set_preferences({'max_concurrent': 3})
        self.assertEqual(self.started[-1], 'job3')

    def test_raise_and_lower_per_host_limit_and_pause_retains_slots(self):
        vdl.db_set_preferences({'max_concurrent_per_host': 1})
        self.queue('one')
        self.queue('two')
        vdl.request_pause('one')
        self.assertEqual(self.started, ['one'])
        vdl.db_set_preferences({'max_concurrent_per_host': 2})
        self.assertEqual(self.started, ['one', 'two'])
        self.queue('three')
        vdl.db_set_preferences({'max_concurrent_per_host': 1})
        self.finish('two')
        self.assertEqual(self.started, ['one', 'two'])
        vdl.request_cancel('one')
        self.assertEqual(self.started, ['one', 'two'])
        self.finish('one')
        self.assertEqual(self.started[-1], 'three')

    def test_cancelling_and_resuming_queued_job_gets_new_arrival_position(self):
        vdl.db_set_preferences({'max_concurrent_per_host': 1})
        for name in ('one', 'two', 'three'):
            self.queue(name)
        self.client.post('/api/stop/two')
        self.assertEqual(vdl.db_get_download('two')['status'], 'cancelled')
        self.assertEqual(self.client.post('/api/resume/two').status_code, 200)
        self.finish('one')
        self.assertEqual(self.started, ['one', 'three'])
        self.finish('three')
        self.assertEqual(self.started[-1], 'two')

    def test_large_queue_creates_threads_only_for_admitted_jobs(self):
        vdl.db_set_preferences({'max_concurrent': 1})
        for i in range(60):
            response = self.client.post('/api/download', json={
                'url': f'https://a.example/{i}', 'format': 'chosen-format',
            })
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self.thread_factory.call_count, 1)
        self.assertEqual(len(vdl._worker_queue), 59)
        self.assertEqual(len(vdl.db_list_downloads()), 60)
        self.assertTrue(all(row['requested_format'] == 'chosen-format'
                            for row in vdl.db_list_downloads()))

    def test_resume_waits_until_old_worker_has_fully_unwound(self):
        self.queue('reused')
        self.queue('waiting')
        vdl.db_update_download('reused', status='cancelled')
        self.assertEqual(self.client.post('/api/resume/reused').status_code, 200)
        self.assertEqual(self.started, ['reused', 'waiting'])
        self.assertEqual(vdl._active_worker_count, 2)
        # Releasing counts alone cannot start another worker for the same ID.
        vdl._release_worker_slot('reused')
        self.assertEqual(self.started, ['reused', 'waiting'])
        self.assertEqual(vdl._active_worker_count, 1)
        with vdl._worker_condition:
            vdl._live_worker_ids.discard('reused')
            vdl._dispatch_worker_queue()
        self.assertEqual(self.started, ['reused', 'waiting', 'reused'])
        self.assertEqual(vdl._active_worker_count, 2)
        self.finish('reused')
        self.finish('waiting')
        self.assertEqual(vdl._active_worker_count, 0)
        self.assertEqual(vdl._worker_hosts, {})

    def test_unwinding_resume_blocks_later_same_host_jobs_but_allows_other_hosts(self):
        self.queue('unwinding')
        vdl.db_update_download('unwinding', status='cancelled')
        self.assertEqual(self.client.post('/api/resume/unwinding').status_code, 200)
        self.queue('later')
        self.queue('other', 'b.example')
        self.assertEqual(self.started, ['unwinding', 'other'])
        vdl._release_worker_slot('unwinding')
        self.assertEqual(self.started, ['unwinding', 'other'])
        with vdl._worker_condition:
            vdl._live_worker_ids.discard('unwinding')
            vdl._dispatch_worker_queue()
        self.assertEqual(self.started, ['unwinding', 'other', 'unwinding', 'later'])
        self.assertEqual(vdl._active_worker_count, 3)

    def test_stop_arriving_between_row_creation_and_enqueue_cancels_immediately(self):
        self.insert('precancel')
        vdl.request_cancel('precancel')
        vdl.enqueue_download('https://a.example/precancel', 'precancel')
        self.assertEqual(vdl.db_get_download('precancel')['status'], 'cancelled')
        self.assertEqual(self.started, [])
        self.assertEqual(vdl._worker_queue, [])

    def test_setup_failure_releases_both_counts_and_dispatches_next_job(self):
        vdl.db_set_preferences({'max_concurrent': 1})
        self.thread_factory.side_effect = RuntimeError('cannot create worker')
        self.queue('failed')
        self.assertEqual(vdl.db_get_download('failed')['status'], 'error')
        self.assertEqual(vdl._active_worker_count, 0)
        self.assertEqual(vdl._worker_hosts, {})
        self.thread_factory.side_effect = self.record_thread
        self.queue('next')
        self.assertEqual(self.started, ['next'])

    def test_hostname_normalization_and_shared_unknown_bucket(self):
        groups = [
            ('example.com', ['http://EXAMPLE.com.:80/a', 'https://example.com:443/b']),
            ('xn--bcher-kva.example', ['https://BÜCHER.example/a', 'http://xn--bcher-kva.example./b']),
            ('2001:db8::1', ['https://[2001:0db8:0:0:0:0:0:1]:443/a', 'http://[2001:db8::1]/b']),
            ('127.0.0.1', ['http://127.0.0.1:99/a']),
            ('sub.example.com', ['https://sub.example.com/a']),
            ('unknown-source', ['no-host', 'https://[broken', 'https://bad host/a', 'https://./a']),
        ]
        for expected, urls in groups:
            for url in urls:
                self.assertEqual(vdl._source_server(url), expected)

    def test_concurrent_requests_reserve_atomically(self):
        # Use actual request threads while stubbing only dispatched workers.
        real_thread = self.real_thread
        self.thread_patch.stop()
        threads = []
        with mock.patch.object(vdl, 'background_download') as worker:
            # The worker stub returns immediately; ownership remains reserved
            # until explicitly released, making overlap deterministic.
            for i in range(12):
                self.insert(f'burst{i}', f'https://a.example/{i}')
            for i in range(12):
                threads.append(real_thread(target=vdl.enqueue_download,
                                           args=(f'https://a.example/{i}', f'burst{i}')))
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(3)
            self.assertTrue(all(not thread.is_alive() for thread in threads))
            self.assertEqual(worker.call_count, 2)
            self.assertEqual(vdl._active_worker_count, 2)
            self.assertEqual(len(vdl._worker_queue), 10)


if __name__ == "__main__":
    unittest.main()
