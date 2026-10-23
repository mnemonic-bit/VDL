import os
import subprocess
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
            os.path.join(self.download_dir, ".vdl_test0001.thumbnail-v2.jpg"),
        )

        # The stored file remains authoritative if the old output directory
        # or the current preference points elsewhere.
        self.assertEqual(
            vdl._thumbnail_path(
                {"id": "test0001", "filename": media_path,
                 "output_dir": other_directory}, other_directory,
            ),
            thumbnail_path,
        )

    def test_generator_seeks_two_thirds_and_publishes_one_complete_frame(self):
        media_path = self.finished_file()
        thumbnail_path = vdl._thumbnail_path(vdl.db_get_download("test0001"))
        commands = []

        def encode(command, **_kwargs):
            commands.append(command)
            self.assertFalse(os.path.exists(thumbnail_path))
            with open(command[-1], "wb") as image:
                image.write(b"frame-at-60-seconds")
            return subprocess.CompletedProcess(command, 0)

        with mock.patch.object(vdl, "ffprobe_video_duration", return_value=90) as probe, \
                mock.patch.object(vdl.subprocess, "run", side_effect=encode):
            self.assertTrue(vdl.generate_video_thumbnail(media_path, thumbnail_path))

        probe.assert_called_once_with(media_path)
        self.assertEqual(len(commands), 1)
        command = commands[0]
        self.assertEqual(command[command.index("-ss") + 1], "60.000")
        self.assertEqual(command[command.index("-vf") + 1],
                         "scale=480:-2:force_original_aspect_ratio=decrease")
        self.assertEqual(command[command.index("-q:v") + 1], "4")
        self.assertIn("-an", command)
        with open(thumbnail_path, "rb") as image:
            self.assertEqual(image.read(), b"frame-at-60-seconds")
        self.assertFalse(any(name.endswith(".tmp.jpg") for name in os.listdir(self.download_dir)))

    def test_failed_seeks_leave_no_partial_frame_and_fall_back_in_order(self):
        media_path = self.finished_file()
        thumbnail_path = vdl._thumbnail_path(vdl.db_get_download("test0001"))

        for duration, expected in ((90, ["60.000", "1", "0"]),
                                   (None, ["1", "0"]),
                                   (0.5, ["0.333", "1", "0"])):
            with self.subTest(duration=duration):
                seeks = []

                def encode(command, **_kwargs):
                    seeks.append(command[command.index("-ss") + 1])
                    with open(command[-1], "wb") as image:
                        image.write(b"partial" if len(seeks) < len(expected) else b"frame")
                    return subprocess.CompletedProcess(command, 1 if len(seeks) < len(expected) else 0)

                with mock.patch.object(vdl, "ffprobe_video_duration", return_value=duration), \
                        mock.patch.object(vdl.subprocess, "run", side_effect=encode):
                    self.assertTrue(vdl.generate_video_thumbnail(media_path, thumbnail_path))
                self.assertEqual(seeks, expected)
                with open(thumbnail_path, "rb") as image:
                    self.assertEqual(image.read(), b"frame")
                self.assertFalse(any(name.endswith(".tmp.jpg") for name in os.listdir(self.download_dir)))
                os.remove(thumbnail_path)

    def test_zero_byte_frame_retries_without_publishing_it(self):
        media_path = self.finished_file()
        thumbnail_path = vdl._thumbnail_path(vdl.db_get_download("test0001"))
        seeks = []

        def encode(command, **_kwargs):
            seeks.append(command[command.index("-ss") + 1])
            with open(command[-1], "wb") as image:
                if len(seeks) == 2:
                    image.write(b"usable-frame")
            return subprocess.CompletedProcess(command, 0)

        with mock.patch.object(vdl, "ffprobe_video_duration", return_value=90), \
                mock.patch.object(vdl.subprocess, "run", side_effect=encode):
            self.assertTrue(vdl.generate_video_thumbnail(media_path, thumbnail_path))
        self.assertEqual(seeks, ["60.000", "1"])
        with open(thumbnail_path, "rb") as image:
            self.assertEqual(image.read(), b"usable-frame")

    def test_failed_generation_keeps_existing_sidecar_and_removes_temporary_files(self):
        media_path = self.finished_file()
        thumbnail_path = vdl._thumbnail_path(vdl.db_get_download("test0001"))
        with open(thumbnail_path, "wb") as image:
            image.write(b"previous-frame")

        def fail(command, **_kwargs):
            with open(command[-1], "wb") as image:
                image.write(b"partial")
            return subprocess.CompletedProcess(command, 1)

        with mock.patch.object(vdl, "ffprobe_video_duration", return_value=None), \
                mock.patch.object(vdl.subprocess, "run", side_effect=fail):
            self.assertFalse(vdl.generate_video_thumbnail(media_path, thumbnail_path))

        with open(thumbnail_path, "rb") as image:
            self.assertEqual(image.read(), b"previous-frame")
        self.assertFalse(any(name.endswith(".tmp.jpg") for name in os.listdir(self.download_dir)))

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

    def test_playlist_thumbnail_url_uses_the_new_cache_version(self):
        self.finished_file()
        item = vdl._playlist_item(vdl.db_get_download("test0001"), 0)
        self.assertEqual(item["thumbnail_url"], "/api/thumbnail/test0001?v=2")

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

    def test_old_sidecar_is_replaced_lazily_and_never_served_as_the_new_image(self):
        media_path = self.finished_file()
        entry = vdl.db_get_download("test0001")
        old_path = vdl._thumbnail_path(entry, version=1)
        new_path = vdl._thumbnail_path(entry)
        with open(old_path, "wb") as image:
            image.write(b"old-frame")

        with mock.patch.object(vdl, "generate_video_thumbnail", return_value=False) as generator:
            self.assertEqual(self.client.get("/api/thumbnail/test0001?v=2").status_code, 404)
        generator.assert_called_once_with(media_path, new_path)

        def generate(_source, destination):
            with open(destination, "wb") as image:
                image.write(b"new-frame")
            return True

        # A failed source gets a quiet interval before another decode attempt.
        retry_at = vdl.time.monotonic() + vdl._THUMBNAIL_FAILURE_COOLDOWN + 1
        with mock.patch.object(vdl.time, "monotonic", return_value=retry_at), \
                mock.patch.object(vdl, "generate_video_thumbnail", side_effect=generate) as generator:
            first = self.client.get("/api/thumbnail/test0001?v=2")
            second = self.client.get("/api/thumbnail/test0001?v=2")
        self.assertEqual(first.data, b"new-frame")
        self.assertEqual(second.data, b"new-frame")
        generator.assert_called_once_with(media_path, new_path)
        with open(old_path, "rb") as image:
            self.assertEqual(image.read(), b"old-frame")
        first.close()
        second.close()

    def test_remove_deletes_the_thumbnail_sidecar_with_the_media(self):
        media_path = self.finished_file()
        entry = vdl.db_get_download("test0001")
        thumbnail_path = vdl._thumbnail_path(entry, self.download_dir)
        legacy_path = vdl._thumbnail_path(entry, self.download_dir, version=1)
        for path in (thumbnail_path, legacy_path):
            with open(path, "wb") as image:
                image.write(b"preview")

        response = self.client.post("/api/remove/test0001")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(os.path.exists(media_path))
        self.assertFalse(os.path.exists(thumbnail_path))
        self.assertFalse(os.path.exists(legacy_path))

    def test_remove_deletes_legacy_thumbnail_from_original_output_directory(self):
        media_path = self.finished_file()
        old_directory = os.path.join(self.temp_dir.name, "old-output")
        os.mkdir(old_directory)
        entry = vdl.db_get_download("test0001")
        vdl.db_update_download("test0001", output_dir=old_directory)
        old_path = os.path.join(old_directory, ".vdl_test0001.thumbnail.jpg")
        new_path = vdl._thumbnail_path(entry)
        for path in (old_path, new_path):
            with open(path, "wb") as image:
                image.write(b"preview")

        self.assertEqual(self.client.post("/api/remove/test0001").status_code, 200)
        self.assertFalse(os.path.exists(media_path))
        self.assertFalse(os.path.exists(old_path))
        self.assertFalse(os.path.exists(new_path))

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
