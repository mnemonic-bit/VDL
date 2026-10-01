import os
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class PreferencesTest(AppCase):
    def test_history_page_size_is_available_validated_and_persists(self):
        self.assertEqual(
            self.client.get("/api/preferences").get_json()["history_page_size"],
            "10",
        )

        response = self.client.post(
            "/api/preferences",
            json={"history_page_size": "20"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["history_page_size"], "20")
        rejected = self.client.post(
            "/api/preferences",
            json={"history_page_size": "12"},
        )
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(
            vdl.db_get_preferences()["history_page_size"],
            "20",
        )

    def test_fullscreen_preference_is_available_and_persists(self):
        self.assertEqual(
            self.client.get("/api/preferences").get_json()["start_fullscreen"],
            "false",
        )

        response = self.client.post(
            "/api/preferences",
            json={"start_fullscreen": "true"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["start_fullscreen"], "true")

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
        with mock.patch.object(vdl.os, "access", return_value=False):
            responses.append(self.client.post(
                "/api/preferences",
                json={"download_dir": self.download_dir},
            ))

        self.assertEqual(
            [response.status_code for response in responses],
            [400, 400, 400],
        )
        self.assertEqual(vdl.db_get_preferences()["download_dir"], original)

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
        self.assertEqual(vdl._active_worker_count, 0)


if __name__ == "__main__":
    unittest.main()
