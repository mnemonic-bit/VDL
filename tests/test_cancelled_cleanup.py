import gc
import os
import threading
import time
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase
from tests.support.fake_ytdlp import FakeYoutubeDL


class DescriptorHoldingYoutubeDL(FakeYoutubeDL):
    """Keep the partial open until the worker function has fully returned."""

    opened = threading.Event()
    descriptor = None
    path = None

    @classmethod
    def reset(cls):
        super().reset()
        cls.opened = threading.Event()
        cls.descriptor = None
        cls.path = None

    def download(self, urls):
        template = self.options["outtmpl"]
        path = template.replace("%(title)s", "fixture").replace("%(ext)s", "mp4")
        path += ".part"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.output_file = open(path, "wb")
        self.output_file.write(b"partial")
        self.output_file.flush()
        # FragmentFD retains its destination stream through a progress-hook
        # reference cycle when cancellation skips its normal close path.
        self.fragment_context = {"dl": self, "dest_stream": self.output_file}
        type(self).descriptor = self.output_file.fileno()
        type(self).path = path
        type(self).opened.set()

        info = {"title": "fixture", "_filename": path, "filepath": path}
        payload = {
            "status": "downloading",
            "downloaded_bytes": 7,
            "total_bytes": 10,
            "speed": 1,
            "eta": 3,
            "info_dict": info,
        }
        for hook in self.options.get("progress_hooks", []):
            hook(payload)
        while not vdl.is_cancel_requested(
                os.path.basename(path).split("_")[-1].split(".")[0]):
            time.sleep(0.01)
        for hook in self.options.get("progress_hooks", []):
            hook(payload)

    def __del__(self):
        output_file = getattr(self, "output_file", None)
        if output_file is not None:
            output_file.close()


class CancelledDownloadCleanupTest(AppCase):
    def setUp(self):
        super().setUp()
        self.other_dir = os.path.join(self.temp_dir.name, "other")
        os.mkdir(self.other_dir)

    def _write(self, filename):
        path = os.path.join(self.download_dir, filename)
        with open(path, "wb") as output_file:
            output_file.write(b"partial")
        return path

    def test_remove_cancelled_download_deletes_its_partial_files(self):
        download_id = "cancel01"
        vdl.db_insert_download(download_id, "https://fixture.invalid/video.mp4")
        vdl.db_update_download(download_id, status="cancelled")

        owned_paths = [
            self._write(f"fixture_{download_id}.mp4.part"),
            self._write(f"fixture_{download_id}.mp4.part-Frag2.part"),
            self._write(f"fixture_{download_id}.mp4.ytdl"),
        ]
        unrelated_path = self._write("fixture_cancel02.mp4.part")

        response = vdl.app.test_client().post(f"/api/remove/{download_id}")

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(vdl.db_get_download(download_id))
        self.assertTrue(all(not os.path.exists(path) for path in owned_paths))
        self.assertTrue(os.path.exists(unrelated_path))

    def test_remove_uses_worker_directory_after_preference_changes(self):
        download_id = "cancel03"
        vdl.db_insert_download(download_id, "https://fixture.invalid/video.mp4")
        vdl.db_update_download(
            download_id,
            status="cancelled",
            output_dir=self.download_dir,
        )
        partial_path = self._write(f"fixture_{download_id}.mp4.part")
        vdl.db_set_preferences({"download_dir": self.other_dir})

        response = vdl.app.test_client().post(f"/api/remove/{download_id}")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(os.path.exists(partial_path))

    def test_worker_records_its_output_directory_before_downloading(self):
        download_id = "cancel04"
        vdl.db_insert_download(download_id, "https://fixture.invalid/video.mp4")
        vdl.request_cancel(download_id)

        vdl.background_download("https://fixture.invalid/video.mp4", download_id)

        entry = vdl.db_get_download(download_id)
        self.assertEqual(entry["status"], "cancelled")
        self.assertEqual(entry["output_dir"], os.path.abspath(self.download_dir))

    def test_cleanup_failure_keeps_the_row_available_for_retry(self):
        download_id = "cleanup1"
        vdl.db_insert_download(download_id, "https://fixture.invalid/video.mp4")
        partial_path = self._write(f"fixture_{download_id}.mp4.part")
        vdl.db_update_download(
            download_id,
            status="cancelled",
            output_dir=self.download_dir,
        )

        with mock.patch.object(vdl.os, "remove", side_effect=PermissionError("read only")):
            response = self.client.post(f"/api/remove/{download_id}")

        self.assertEqual(response.status_code, 500)
        self.assertIsNotNone(vdl.db_get_download(download_id))
        self.assertTrue(os.path.exists(partial_path))

    def test_remove_waits_for_cancelled_worker_to_release_open_partial(self):
        download_id = "cancel05"
        url = "https://fixture.invalid/video.mp4"
        vdl.db_insert_download(download_id, url)
        DescriptorHoldingYoutubeDL.reset()
        release_entered = threading.Event()
        finish_release = threading.Event()
        original_release = vdl._release_worker_slot

        def delayed_release():
            release_entered.set()
            finish_release.wait(2)
            original_release()

        gc_was_enabled = gc.isenabled()
        gc.disable()
        try:
            with (
                mock.patch.object(vdl.yt_dlp, "YoutubeDL", DescriptorHoldingYoutubeDL),
                mock.patch.object(vdl, "_release_worker_slot", side_effect=delayed_release),
            ):
                worker = threading.Thread(
                    target=vdl.background_download,
                    args=(url, download_id),
                )
                worker.start()
                self.assertTrue(DescriptorHoldingYoutubeDL.opened.wait(1))
                self.assertEqual(self.client.post(f"/api/stop/{download_id}").status_code, 200)
                self.assertTrue(release_entered.wait(1))
                self.assertEqual(vdl.db_get_download(download_id)["status"], "cancelled")

                try:
                    response = self.client.post(f"/api/remove/{download_id}")

                    self.assertEqual(response.status_code, 409)
                    self.assertTrue(os.path.exists(DescriptorHoldingYoutubeDL.path))
                    self.assertEqual(os.fstat(DescriptorHoldingYoutubeDL.descriptor).st_nlink, 1)
                finally:
                    finish_release.set()
                    worker.join(1)

            self.assertFalse(worker.is_alive())
            with self.assertRaises(OSError):
                os.fstat(DescriptorHoldingYoutubeDL.descriptor)
            response = self.client.post(f"/api/remove/{download_id}")
            self.assertEqual(response.status_code, 200)
            self.assertFalse(os.path.exists(DescriptorHoldingYoutubeDL.path))
        finally:
            if gc_was_enabled:
                gc.enable()
            gc.collect()


if __name__ == "__main__":
    unittest.main()
