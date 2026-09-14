import os
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


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

    @unittest.expectedFailure  # BUG 22
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


if __name__ == "__main__":
    unittest.main()
