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


if __name__ == "__main__":
    unittest.main()
