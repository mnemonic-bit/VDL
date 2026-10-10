import os
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class ThumbnailTest(AppCase):
    def test_legacy_row_keeps_its_thumbnail_beside_the_stored_media(self):
        media_path = self.finished_file()
        other_directory = os.path.join(self.temp_dir.name, "new-downloads")
        os.mkdir(other_directory)

        thumbnail_path = vdl._thumbnail_path(
            {"id": "test0001", "filename": media_path, "output_dir": None},
            other_directory,
        )

        self.assertEqual(
            thumbnail_path,
            os.path.join(self.download_dir, ".vdl_test0001.thumbnail.jpg"),
        )

    def test_finished_video_generates_and_caches_a_local_thumbnail(self):
        media_path = self.finished_file()
        entry = vdl.db_get_download("test0001")
        thumbnail_path = vdl._thumbnail_path(entry, self.download_dir)

        def generate(source, destination):
            self.assertEqual(source, media_path)
            self.assertEqual(destination, thumbnail_path)
            with open(destination, "wb") as image:
                image.write(b"\xff\xd8preview\xff\xd9")
            return True

        with mock.patch.object(
            vdl, "generate_video_thumbnail", side_effect=generate
        ) as generator:
            first = self.client.get("/api/thumbnail/test0001")
            second = self.client.get("/api/thumbnail/test0001")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.mimetype, "image/jpeg")
        self.assertEqual(first.data, b"\xff\xd8preview\xff\xd9")
        self.assertEqual(second.status_code, 200)
        generator.assert_called_once_with(media_path, thumbnail_path)
        first.close()
        second.close()

    def test_missing_or_non_video_thumbnail_uses_a_404_fallback(self):
        self.finished_file()
        with mock.patch.object(
            vdl, "generate_video_thumbnail", return_value=False
        ):
            self.assertEqual(
                self.client.get("/api/thumbnail/test0001").status_code,
                404,
            )

        self.insert("active01")
        self.assertEqual(
            self.client.get("/api/thumbnail/active01").status_code,
            404,
        )

    def test_remove_deletes_the_thumbnail_sidecar_with_the_media(self):
        media_path = self.finished_file()
        entry = vdl.db_get_download("test0001")
        thumbnail_path = vdl._thumbnail_path(entry, self.download_dir)
        with open(thumbnail_path, "wb") as image:
            image.write(b"preview")

        response = self.client.post("/api/remove/test0001")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(os.path.exists(media_path))
        self.assertFalse(os.path.exists(thumbnail_path))

    def test_thumbnail_rejects_media_outside_the_download_allow_list(self):
        external_dir = os.path.join(self.temp_dir.name, "external")
        os.mkdir(external_dir)
        external_path = os.path.join(external_dir, "private.mp4")
        with open(external_path, "wb") as media:
            media.write(b"outside")
        self.insert("tampered")
        vdl.db_update_download(
            "tampered",
            status="finished",
            filename=external_path,
            finished_at=1,
        )

        with mock.patch.object(vdl, "generate_video_thumbnail") as generator:
            response = self.client.get("/api/thumbnail/tampered")

        self.assertEqual(response.status_code, 403)
        generator.assert_not_called()


if __name__ == "__main__":
    unittest.main()
