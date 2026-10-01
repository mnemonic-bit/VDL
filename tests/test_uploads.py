import os
import subprocess
import threading
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class UploadTest(AppCase):
    def start_upload(self, payload=b"video bytes", filename="desktop-video.mp4"):
        return self.client.post(
            "/api/upload",
            json={"filename": filename, "filesize": len(payload)},
        )

    def upload(self, payload=b"video bytes", filename="desktop-video.mp4"):
        start = self.start_upload(payload, filename)
        self.assertEqual(start.status_code, 202)
        upload_id = start.get_json()["id"]
        response = self.client.put(
            f"/api/upload/{upload_id}",
            data=payload,
            content_type="application/octet-stream",
        )
        return upload_id, response

    def test_video_upload_is_added_as_finished_library_item(self):
        with mock.patch.object(
            vdl, "inspect_uploaded_video", return_value="1080p"
        ) as inspect:
            upload_id, response = self.upload()

        self.assertEqual(response.status_code, 200)
        row = vdl.db_get_download(upload_id)
        self.assertEqual(row["status"], "finished")
        self.assertEqual(row["progress"], "100%")
        self.assertEqual(row["source_type"], "upload")
        self.assertEqual(row["url"], "")
        self.assertEqual(row["title"], "desktop-video")
        self.assertEqual(row["resolution"], "1080p")
        self.assertEqual(row["filesize"], len(b"video bytes"))
        self.assertEqual(row["downloaded_bytes"], len(b"video bytes"))
        self.assertEqual(row["total_bytes"], len(b"video bytes"))
        self.assertIsNone(row["requested_format"])
        self.assertEqual(os.path.basename(row["filename"]), "desktop-video.mp4")
        self.assertEqual(row["output_dir"], os.path.abspath(self.download_dir))
        with open(row["filename"], "rb") as stored:
            self.assertEqual(stored.read(), b"video bytes")
        inspect.assert_called_once()

        history_row = self.client.get("/api/history").get_json()[0]
        self.assertEqual(history_row["source_type"], "upload")

    def test_upload_preserves_an_existing_file_with_a_collision_suffix(self):
        existing = os.path.join(self.download_dir, "desktop-video.mp4")
        with open(existing, "wb") as output:
            output.write(b"existing")

        with mock.patch.object(
            vdl, "inspect_uploaded_video", return_value=None
        ):
            upload_id, response = self.upload(payload=b"new video")

        self.assertEqual(response.status_code, 200)
        row = vdl.db_get_download(upload_id)
        self.assertEqual(os.path.basename(row["filename"]), "desktop-video (1).mp4")
        with open(existing, "rb") as original:
            self.assertEqual(original.read(), b"existing")
        with open(row["filename"], "rb") as stored:
            self.assertEqual(stored.read(), b"new video")

    def test_client_path_is_reduced_to_a_safe_basename(self):
        with mock.patch.object(
            vdl, "inspect_uploaded_video", return_value="720p"
        ):
            upload_id, response = self.upload(filename="../../holiday.mp4")

        self.assertEqual(response.status_code, 200)
        row = vdl.db_get_download(upload_id)
        self.assertEqual(os.path.basename(row["filename"]), "holiday.mp4")
        self.assertEqual(os.path.dirname(row["filename"]), self.download_dir)

    def test_non_video_and_empty_uploads_leave_no_files(self):
        with mock.patch.object(
            vdl,
            "inspect_uploaded_video",
            side_effect=ValueError(
                "The uploaded file does not contain a video stream"
            ),
        ):
            upload_id, invalid = self.upload(
                payload=b"not video", filename="notes.txt"
            )
        empty = self.start_upload(payload=b"", filename="empty.mp4")

        self.assertEqual(invalid.status_code, 415)
        self.assertEqual(empty.status_code, 400)
        self.assertEqual(vdl.db_get_download(upload_id)["status"], "error")
        self.assertEqual(len(vdl.db_list_downloads()), 1)
        self.assertEqual(os.listdir(self.download_dir), [])

    def test_missing_file_and_missing_ffprobe_report_clear_errors(self):
        missing = self.client.post(
            "/api/upload", json={}
        )
        with mock.patch.object(
            vdl,
            "inspect_uploaded_video",
            side_effect=RuntimeError(
                "ffprobe is required to validate uploaded videos"
            ),
        ):
            upload_id, unavailable = self.upload()

        self.assertEqual(missing.status_code, 400)
        self.assertEqual(unavailable.status_code, 503)
        self.assertIn("ffprobe", unavailable.get_json()["error"])
        self.assertEqual(vdl.db_get_download(upload_id)["status"], "error")
        self.assertEqual(os.listdir(self.download_dir), [])

    def test_upload_is_current_and_can_be_stopped_then_removed(self):
        payload = b"video bytes"
        start = self.start_upload(payload)
        upload_id = start.get_json()["id"]
        inspecting = threading.Event()
        release_inspection = threading.Event()
        result = {}

        def inspect(_path):
            inspecting.set()
            release_inspection.wait(2)
            return "720p"

        def transfer():
            with vdl.app.test_client() as client:
                result["response"] = client.put(
                    f"/api/upload/{upload_id}",
                    data=payload,
                    content_type="application/octet-stream",
                )

        with mock.patch.object(vdl, "inspect_uploaded_video", side_effect=inspect):
            thread = threading.Thread(target=transfer)
            thread.start()
            self.assertTrue(inspecting.wait(2))
            active = vdl.db_get_download(upload_id)
            self.assertEqual(active["status"], "downloading")
            self.assertEqual(active["downloaded_bytes"], len(payload))
            self.assertEqual(active["total_bytes"], len(payload))

            stopped = self.client.post(f"/api/stop/{upload_id}")
            self.assertEqual(stopped.status_code, 200)
            release_inspection.set()
            thread.join(2)

        self.assertFalse(thread.is_alive())
        self.assertEqual(result["response"].status_code, 409)
        self.assertEqual(vdl.db_get_download(upload_id)["status"], "cancelled")
        removed = self.client.post(f"/api/remove/{upload_id}")
        self.assertEqual(removed.status_code, 200)
        self.assertIsNone(vdl.db_get_download(upload_id))
        self.assertEqual(os.listdir(self.download_dir), [])

    def test_transfer_rejects_unknown_non_upload_and_terminal_rows(self):
        unknown = self.client.put("/api/upload/missing1", data=b"video")
        download_id = self.insert("remote01")
        remote = self.client.put(f"/api/upload/{download_id}", data=b"video")
        start = self.start_upload()
        upload_id = start.get_json()["id"]
        vdl.db_update_download(upload_id, status="cancelled")
        terminal = self.client.put(f"/api/upload/{upload_id}", data=b"video")

        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(remote.status_code, 409)
        self.assertEqual(terminal.status_code, 409)

    def test_transfer_rejects_more_or_fewer_bytes_than_declared(self):
        too_large = self.client.post(
            "/api/upload", json={"filename": "large.mp4", "filesize": 1}
        ).get_json()["id"]
        large_response = self.client.put(
            f"/api/upload/{too_large}", data=b"two"
        )
        too_small = self.client.post(
            "/api/upload", json={"filename": "small.mp4", "filesize": 10}
        ).get_json()["id"]
        small_response = self.client.put(
            f"/api/upload/{too_small}", data=b"one"
        )

        self.assertEqual(large_response.status_code, 400)
        self.assertEqual(small_response.status_code, 400)
        self.assertEqual(vdl.db_get_download(too_large)["status"], "error")
        self.assertEqual(vdl.db_get_download(too_small)["status"], "error")
        self.assertEqual(os.listdir(self.download_dir), [])

    def test_ffprobe_validation_returns_resolution_when_available(self):
        result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout='{"streams": [{"height": 1440}]}',
        )
        with mock.patch.object(vdl.subprocess, "run", return_value=result):
            self.assertEqual(vdl.inspect_uploaded_video("fixture.mp4"), "1440p")

    def test_ffprobe_validation_allows_video_without_height_metadata(self):
        result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout='{"streams": [{"height": null}]}',
        )
        with mock.patch.object(vdl.subprocess, "run", return_value=result):
            self.assertIsNone(vdl.inspect_uploaded_video("fixture.mp4"))

    def test_ffprobe_validation_rejects_invalid_output_and_missing_stream(self):
        cases = (
            subprocess.CompletedProcess(args=[], returncode=1, stdout="{}"),
            subprocess.CompletedProcess(args=[], returncode=0, stdout="not json"),
        )
        for result in cases:
            with self.subTest(result=result), mock.patch.object(
                vdl.subprocess, "run", return_value=result
            ):
                with self.assertRaises(ValueError):
                    vdl.inspect_uploaded_video("fixture.mp4")

    def test_ffprobe_validation_reports_missing_binary(self):
        with mock.patch.object(
            vdl.subprocess, "run", side_effect=FileNotFoundError
        ):
            with self.assertRaisesRegex(RuntimeError, "ffprobe"):
                vdl.inspect_uploaded_video("fixture.mp4")


if __name__ == "__main__":
    unittest.main()
