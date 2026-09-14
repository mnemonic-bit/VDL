import os
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase
from tests.support.fake_ytdlp import FakeYoutubeDL


class DownloadRequestTest(AppCase):
    def setUp(self):
        super().setUp()
        FakeYoutubeDL.reset()

    def test_missing_url_returns_400_without_creating_a_row(self):
        response = self.client.post("/api/download", json={})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(vdl.db_list_downloads(), [])

    def test_format_override_is_persisted_on_its_row(self):
        with (
            mock.patch.object(vdl, "background_download"),
            self.start_immediately(),
        ):
            response = self.client.post(
                "/api/download",
                json={"url": "https://fixture.invalid/video", "format": "v360+a1"},
            )
        row = vdl.db_get_download(response.get_json()["id"])
        self.assertEqual(row["requested_format"], "v360+a1")

    @unittest.expectedFailure  # BUG 3
    def test_custom_filename_reaches_output_template_and_preserves_extension(self):
        with (
            mock.patch.object(vdl.yt_dlp, "YoutubeDL", FakeYoutubeDL),
            mock.patch.object(vdl, "ffprobe_resolution", return_value="360p"),
            self.start_immediately(),
        ):
            response = self.client.post(
                "/api/download",
                json={
                    "url": "https://fixture.invalid/video",
                    "filename": "chosen-name",
                },
            )
        row = vdl.db_get_download(response.get_json()["id"])
        self.assertEqual(os.path.basename(row["filename"]), "chosen-name.mp4")

    @unittest.expectedFailure  # BUG 3
    def test_custom_filename_accepts_only_safe_bare_names(self):
        for filename in ("../escape", "a/b", "a\\b", "\x00", ".", ".."):
            with self.subTest(filename=filename):
                response = self.client.post(
                    "/api/download",
                    json={"url": "https://fixture.invalid/video", "filename": filename},
                )
                self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
