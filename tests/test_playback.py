import os
import unittest

import vdl
from tests.support.app_case import AppCase


class PlaybackTest(AppCase):
    def test_quality_classification_uses_compact_standard_tiers(self):
        cases = {
            "7680x4320": "8k",
            "2160p": "4k",
            "2560x1440": "2k",
            "1080p": "1080",
            "720p": "720p",
            "480p": "480p",
            "360p": "360p",
            "240p": "240",
            "audio only": None,
            None: None,
        }
        for resolution, expected in cases.items():
            with self.subTest(resolution=resolution):
                self.assertEqual(
                    vdl.classify_video_quality(resolution), expected
                )

    def test_preview_activation_counts_views_but_media_requests_do_not(self):
        self.finished_file()
        vdl.db_update_download("test0001", resolution="2160p")

        media = self.client.get("/api/file/test0001")
        media.close()
        self.assertEqual(vdl.db_get_download("test0001")["view_count"], 0)

        first = self.client.post("/api/view/test0001")
        second = self.client.post("/api/view/test0001")

        self.assertEqual(first.get_json(), {
            "id": "test0001", "view_count": 1,
        })
        self.assertEqual(second.get_json(), {
            "id": "test0001", "view_count": 2,
        })
        row = self.client.get("/api/history").get_json()[0]
        self.assertEqual(row["view_count"], 2)
        self.assertEqual(row["quality"], "4k")

    def test_view_count_rejects_unplayable_rows(self):
        self.insert("active01")
        self.assertEqual(
            self.client.post("/api/view/active01").status_code, 404
        )
        self.assertEqual(
            self.client.post("/api/view/missing1").status_code, 404
        )

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

    def test_download_response_uses_the_stored_basename_as_an_attachment(self):
        payload = b"downloadable media"
        self.finished_file(name="saved video.mp4", data=payload)

        response = self.client.get("/api/file/test0001?download=1")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, payload)
        self.assertEqual(
            response.headers["Content-Disposition"],
            "attachment; filename=\"saved video.mp4\"",
        )
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

    def test_tampered_row_cannot_authorize_its_own_external_directory(self):
        external_dir = os.path.join(self.temp_dir.name, "external")
        os.mkdir(external_dir)
        external_path = os.path.join(external_dir, "private.mp4")
        with open(external_path, "wb") as output:
            output.write(b"outside the trusted download roots")
        self.insert("tampered")
        vdl.db_update_download(
            "tampered",
            status="finished",
            filename=external_path,
            finished_at=1,
        )

        response = self.client.get("/api/file/tampered")
        status_code = response.status_code
        response.close()
        self.assertEqual(status_code, 403)


if __name__ == "__main__":
    unittest.main()
