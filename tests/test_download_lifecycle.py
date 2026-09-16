import threading
import time
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase
from tests.support.fake_ytdlp import FakeYoutubeDL


class DownloadLifecycleTest(AppCase):
    def test_unknown_size_progress_exposes_live_metadata_and_indeterminate_state(self):
        download_id = self.insert("unknown1")

        vdl.progress_hook({
            "status": "downloading",
            "downloaded_bytes": 4096,
            "speed": 1024,
            "info_dict": {
                "title": "Unknown length fixture",
                "height": 720,
            },
        }, download_id)

        row = self.client.get("/api/history").get_json()[0]
        self.assertEqual(row["status"], "downloading")
        self.assertEqual(row["progress"], "Downloading")
        self.assertEqual(row["title"], "Unknown length fixture")
        self.assertEqual(row["resolution"], "720p")
        self.assertEqual(row["speed"], 1024.0)
        self.assertIsNone(row["filesize"])

    def test_changing_size_estimates_are_smoothed(self):
        download_id = self.insert("estimate1")
        mib = 1024 * 1024
        observed_sizes = []
        observed_progress = []

        for estimate in (800, 806, 794, 805, 796):
            vdl.progress_hook({
                "status": "downloading",
                "downloaded_bytes": 400 * mib,
                "total_bytes_estimate": estimate * mib,
                "info_dict": {},
            }, download_id)

            row = self.client.get("/api/history").get_json()[0]
            observed_sizes.append(row["filesize"])
            observed_progress.append(float(row["progress"].rstrip("%")))

        self.assertEqual(observed_sizes, [800 * mib] * 5)
        self.assertEqual(observed_progress, [50.0] * 5)

        for _ in range(30):
            vdl.progress_hook({
                "status": "downloading",
                "downloaded_bytes": 400 * mib,
                "total_bytes_estimate": 820 * mib,
                "info_dict": {},
            }, download_id)
            row = self.client.get("/api/history").get_json()[0]
            observed_sizes.append(row["filesize"])
            observed_progress.append(float(row["progress"].rstrip("%")))

        self.assertGreater(observed_sizes[-1], 815 * mib)
        self.assertLessEqual(observed_sizes[-1], 820 * mib)
        self.assertLess(len(set(observed_sizes)), 10)
        self.assertEqual(observed_progress, sorted(observed_progress))

    def test_exact_size_drives_determinate_progress(self):
        download_id = self.insert("exact001")

        vdl.progress_hook({
            "status": "downloading",
            "downloaded_bytes": 400,
            "total_bytes": 800,
            "total_bytes_estimate": 725,
            "info_dict": {},
        }, download_id)

        row = self.client.get("/api/history").get_json()[0]
        self.assertEqual(row["progress"], "50.0%")
        self.assertEqual(row["filesize"], 800)

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

    def test_transition_endpoints_reject_unknown_or_incompatible_states(self):
        self.assertEqual(self.client.post("/api/pause/missing1").status_code, 404)
        self.assertEqual(self.client.post("/api/unpause/missing1").status_code, 404)
        self.assertEqual(self.client.post("/api/stop/missing1").status_code, 404)
        self.assertEqual(self.client.post("/api/resume/missing1").status_code, 404)
        self.assertEqual(self.client.post("/api/remove/missing1").status_code, 404)

        self.insert("finished1")
        vdl.db_update_download("finished1", status="finished")
        self.assertEqual(self.client.post("/api/pause/finished1").status_code, 409)
        self.assertEqual(self.client.post("/api/unpause/finished1").status_code, 409)
        self.assertEqual(self.client.post("/api/resume/finished1").status_code, 409)

        self.insert("active01")
        vdl.db_update_download("active01", status="downloading")
        self.assertEqual(self.client.post("/api/remove/active01").status_code, 409)

    def test_pause_unpause_and_stop_apply_only_to_active_workers(self):
        self.insert("pause001")
        vdl.db_update_download("pause001", status="downloading")
        self.assertEqual(self.client.post("/api/pause/pause001").status_code, 200)
        progress = threading.Thread(
            target=vdl.progress_hook,
            args=({
                "status": "downloading",
                "downloaded_bytes": 5,
                "total_bytes": 10,
                "info_dict": {},
            }, "pause001"),
        )
        progress.start()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            row = self.client.get("/api/history").get_json()[0]
            if row["status"] == "paused":
                break
            time.sleep(0.01)
        self.assertEqual(row["status"], "paused")

        self.assertEqual(self.client.post("/api/unpause/pause001").status_code, 200)
        progress.join(1)
        self.assertFalse(progress.is_alive())
        self.assertEqual(
            self.client.get("/api/history").get_json()[0]["status"],
            "downloading",
        )

        self.assertEqual(self.client.post("/api/stop/pause001").status_code, 200)
        with self.assertRaises(vdl.DownloadCancelled):
            vdl.progress_hook({"status": "downloading"}, "pause001")

        self.insert("terminal1")
        vdl.db_update_download("terminal1", status="cancelled")
        response = self.client.post("/api/stop/terminal1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "cancelled")

    def test_simultaneous_resume_requests_start_exactly_one_worker(self):
        download_id = self.insert("race0001")
        vdl.db_update_download(download_id, status="cancelled")
        read_barrier = threading.Barrier(2)
        real_get = vdl.db_get_download
        real_thread = threading.Thread
        starts = []

        def synchronized_get(candidate_id):
            entry = real_get(candidate_id)
            if candidate_id == download_id and entry and entry["status"] == "cancelled":
                read_barrier.wait(timeout=2)
            return entry

        class RecordingWorker:
            def __init__(self, target=None, args=(), **_kwargs):
                self.target = target
                self.args = args
                self.daemon = False

            def start(self):
                starts.append(self.args)

        responses = []

        def resume():
            with vdl.app.test_client() as client:
                responses.append(client.post(f"/api/resume/{download_id}").status_code)

        with (
            mock.patch.object(vdl, "db_get_download", side_effect=synchronized_get),
            mock.patch.object(vdl.threading, "Thread", RecordingWorker),
        ):
            requests = [real_thread(target=resume) for _ in range(2)]
            for request_thread in requests:
                request_thread.start()
            for request_thread in requests:
                request_thread.join(3)

        self.assertFalse(any(request_thread.is_alive() for request_thread in requests))
        self.assertEqual(sorted(responses), [200, 409])
        self.assertEqual(starts, [("https://fixture.invalid/video", download_id)])

    def test_resume_remove_race_has_one_consistent_winner(self):
        download_id = self.insert("remove-race")
        vdl.db_update_download(download_id, status="cancelled")
        read_barrier = threading.Barrier(2)
        real_get = vdl.db_get_download
        real_thread = threading.Thread
        starts = []

        def synchronized_get(candidate_id):
            entry = real_get(candidate_id)
            if candidate_id == download_id and entry and entry["status"] == "cancelled":
                read_barrier.wait(timeout=2)
            return entry

        class RecordingWorker:
            def __init__(self, target=None, args=(), **_kwargs):
                self.args = args
                self.daemon = False

            def start(self):
                starts.append(self.args)

        responses = {}

        def post(name, path):
            with vdl.app.test_client() as client:
                responses[name] = client.post(path).status_code

        with (
            mock.patch.object(vdl, "db_get_download", side_effect=synchronized_get),
            mock.patch.object(vdl.threading, "Thread", RecordingWorker),
        ):
            requests = [
                real_thread(
                    target=post,
                    args=("resume", f"/api/resume/{download_id}"),
                ),
                real_thread(
                    target=post,
                    args=("remove", f"/api/remove/{download_id}"),
                ),
            ]
            for request_thread in requests:
                request_thread.start()
            for request_thread in requests:
                request_thread.join(3)

        self.assertFalse(any(request_thread.is_alive() for request_thread in requests))
        self.assertIn(
            responses,
            [
                {"resume": 200, "remove": 409},
                {"resume": 404, "remove": 200},
            ],
        )
        if responses["resume"] == 200:
            self.assertEqual(vdl.db_get_download(download_id)["status"], "starting")
            self.assertEqual(len(starts), 1)
        else:
            self.assertIsNone(vdl.db_get_download(download_id))
            self.assertEqual(starts, [])

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
