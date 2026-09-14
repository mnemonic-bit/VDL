import os
import unittest

import vdl
from tests.support.app_case import AppCase


class PreferencesTest(AppCase):
    @unittest.expectedFailure  # BUG 16
    def test_rejects_empty_and_unusable_download_directories(self):
        original = vdl.db_get_preferences()["download_dir"]
        blocking_file = os.path.join(self.temp_dir.name, "not-a-directory")
        with open(blocking_file, "wb") as output:
            output.write(b"fixture")

        responses = [
            self.client.post("/api/preferences", json={"download_dir": ""}),
            self.client.post(
                "/api/preferences",
                json={"download_dir": os.path.join(blocking_file, "child")},
            ),
        ]

        self.assertEqual([response.status_code for response in responses], [400, 400])
        self.assertEqual(vdl.db_get_preferences()["download_dir"], original)

    @unittest.expectedFailure  # BUG 16
    def test_worker_setup_failure_becomes_a_terminal_error(self):
        download_id = self.insert("bad-dir1")
        blocking_file = os.path.join(self.temp_dir.name, "not-a-directory")
        with open(blocking_file, "wb") as output:
            output.write(b"fixture")
        vdl.db_set_preferences({
            "download_dir": os.path.join(blocking_file, "child"),
        })

        try:
            vdl.background_download("https://fixture.invalid/video", download_id)
        except OSError as exc:
            self.fail(f"worker setup escaped its failure boundary: {exc}")

        row = self.client.get("/api/history").get_json()[0]
        self.assertEqual(row["status"], "error")
        self.assertIn("directory", row["progress"].lower())


if __name__ == "__main__":
    unittest.main()
