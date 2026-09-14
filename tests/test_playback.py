import os
import unittest

import vdl
from tests.support.app_case import AppCase


class PlaybackTest(AppCase):
    def test_stored_path_survives_preference_change_and_supports_ranges(self):
        payload = bytes(range(100))
        self.finished_file(data=payload)
        other = os.path.join(self.temp_dir.name, "new-downloads")
        os.mkdir(other)
        vdl.db_set_preferences({"download_dir": other})

        response = self.client.get("/api/file/test0001", headers={"Range": "bytes=10-19"})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.data, payload[10:20])
        self.assertEqual(response.headers["Content-Type"], "video/mp4")
        response.close()

    def test_supported_audio_and_video_extensions_have_stable_mime_types(self):
        cases = {
            "mp4": "video/mp4",
            "webm": "video/webm",
            "mkv": "video/x-matroska",
            "m4a": "audio/mp4",
            "mp3": "audio/mpeg",
            "opus": "audio/ogg; codecs=opus",
        }
        for index, (extension, expected) in enumerate(cases.items()):
            with self.subTest(extension=extension):
                download_id = f"mime{index}"
                self.finished_file(download_id, f"fixture.{extension}")
                response = self.client.get(f"/api/file/{download_id}")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["Content-Type"], expected)
                response.close()

    def test_non_finished_and_missing_files_are_not_playable(self):
        self.insert("active01")
        self.assertEqual(self.client.get("/api/file/active01").status_code, 404)
        self.finished_file("gone0001", "gone.mp4")
        os.remove(vdl.db_get_download("gone0001")["filename"])
        self.assertEqual(self.client.get("/api/file/gone0001").status_code, 404)

    def test_symlink_cannot_escape_the_stored_directory_allow_list(self):
        outside = os.path.join(self.temp_dir.name, "outside.mp4")
        with open(outside, "wb") as output:
            output.write(b"outside")
        link = os.path.join(self.download_dir, "escape.mp4")
        os.symlink(outside, link)
        self.insert("escape01")
        vdl.db_update_download(
            "escape01", status="finished", filename=link, finished_at=1
        )
        self.assertEqual(self.client.get("/api/file/escape01").status_code, 403)


if __name__ == "__main__":
    unittest.main()
