import threading
import time
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase
from tests.support.fake_ytdlp import FakeYoutubeDL


class DownloadLifecycleTest(AppCase):
    def test_pause_is_recorded_once_and_progress_continues_after_unpause(self):
        download_id = self.insert()
        vdl.request_pause(download_id)
        real_update = vdl.db_update_download
        statuses = []

        def record_update(*args, **kwargs):
            statuses.append(kwargs.get("status"))
            return real_update(*args, **kwargs)

        with (
            mock.patch.object(vdl, "db_update_download", side_effect=record_update),
            mock.patch.object(vdl.time, "sleep", side_effect=lambda _seconds: vdl.clear_pause(download_id)),
        ):
            vdl.progress_hook({
                "status": "downloading",
                "downloaded_bytes": 5,
                "total_bytes": 10,
                "info_dict": {},
            }, download_id)
        self.assertEqual(statuses.count("paused"), 1)
        self.assertEqual(vdl.db_get_download(download_id)["status"], "downloading")

    def test_cancel_wakes_and_overrides_pause(self):
        download_id = self.insert()
        vdl.request_pause(download_id)
        vdl.request_cancel(download_id)
        self.assertFalse(vdl.is_pause_requested(download_id))
        with self.assertRaises(vdl.DownloadCancelled):
            vdl.progress_hook({"status": "downloading"}, download_id)

    def test_resume_accepts_only_resumable_rows_and_keeps_the_id(self):
        download_id = self.insert()
        vdl.db_update_download(download_id, status="cancelled")
        calls = []
        with (
            mock.patch.object(vdl, "background_download", side_effect=lambda *args: calls.append(args)),
            self.start_immediately(),
        ):
            response = self.client.post(f"/api/resume/{download_id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["id"], download_id)
        self.assertEqual(calls, [("https://fixture.invalid/video", download_id)])
        self.assertEqual(vdl.db_get_download(download_id)["status"], "starting")
        self.assertEqual(self.client.post(f"/api/resume/{download_id}").status_code, 409)

    def test_init_db_recovers_all_abandoned_active_states(self):
        for index, status in enumerate(("starting", "downloading", "paused")):
            download_id = f"crash{index}"
            self.insert(download_id)
            vdl.db_update_download(download_id, status=status)
        vdl.init_db()
        for index in range(3):
            row = vdl.db_get_download(f"crash{index}")
            self.assertEqual((row["status"], row["progress"]), ("interrupted", "Interrupted"))

    def test_worker_slot_is_released_after_success_error_and_cancel(self):
        for outcome in ("success", "error", "cancel"):
            with self.subTest(outcome=outcome):
                FakeYoutubeDL.reset()
                download_id = self.insert(f"slot-{outcome}")
                FakeYoutubeDL.fail_downloads = outcome == "error"
                if outcome == "cancel":
                    vdl.request_cancel(download_id)
                with (
                    mock.patch.object(vdl.yt_dlp, "YoutubeDL", FakeYoutubeDL),
                    mock.patch.object(vdl, "ffprobe_resolution", return_value="360p"),
                ):
                    vdl.background_download("https://fixture.invalid/video", download_id)
                self.assertEqual(vdl._active_worker_count, 0)
                self.assertEqual(vdl._worker_queue, [])


if __name__ == "__main__":
    unittest.main()
