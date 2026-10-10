import json
import os
import subprocess
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class HoverPreviewTest(AppCase):
    def test_legacy_row_keeps_preview_beside_stored_media(self):
        media_path = self.finished_file()
        other_directory = os.path.join(self.temp_dir.name, "new-downloads")
        os.mkdir(other_directory)

        preview_path = vdl._preview_path(
            {"id": "test0001", "filename": media_path, "output_dir": None},
            other_directory,
        )

        self.assertEqual(
            preview_path,
            os.path.join(self.download_dir, ".vdl_test0001.preview-v4.mp4"),
        )

    def test_preview_segments_span_long_videos_without_repeating_short_ones(self):
        self.assertEqual(vdl._preview_segments(0), [])
        self.assertEqual(vdl._preview_segments(10), [])
        self.assertEqual(vdl._preview_segments(12), [(5.0, 2.0)])
        self.assertEqual(vdl._preview_segments(20), [(5.0, 10.0)])

        segments = vdl._preview_segments(63)
        self.assertEqual(len(segments), 7)
        self.assertEqual([length for _start, length in segments], [2.0] * 7)
        starts = [start for start, _length in segments]
        self.assertEqual(starts[0], 5.0)
        self.assertEqual(starts[-1], 56.0)
        self.assertEqual(
            [round(starts[index + 1] - starts[index], 6) for index in range(6)],
            [8.5] * 6,
        )

    def test_ffprobe_duration_requires_a_finite_video_stream(self):
        valid = subprocess.CompletedProcess(
            [], 0,
            stdout=json.dumps({
                "streams": [{"duration": "59"}],
                "format": {"duration": "63.25"},
            }),
        )
        with mock.patch.object(vdl.subprocess, "run", return_value=valid) as run:
            self.assertEqual(vdl.ffprobe_video_duration("movie.mp4"), 63.25)
        self.assertIn("stream=duration:format=duration", run.call_args.args[0])

        invalid_results = [
            subprocess.CompletedProcess([], 1, stdout="{}"),
            subprocess.CompletedProcess([], 0, stdout="not json"),
            subprocess.CompletedProcess(
                [], 0, stdout=json.dumps({"streams": [], "format": {"duration": "10"}})
            ),
            subprocess.CompletedProcess(
                [], 0, stdout=json.dumps({"streams": [{}], "format": {"duration": "nan"}})
            ),
        ]
        for result in invalid_results:
            with self.subTest(stdout=result.stdout, returncode=result.returncode):
                with mock.patch.object(vdl.subprocess, "run", return_value=result):
                    self.assertIsNone(vdl.ffprobe_video_duration("movie.mp4"))

    def test_generator_builds_a_seven_excerpt_browser_mp4_atomically(self):
        media_path = self.finished_file()
        entry = vdl.db_get_download("test0001")
        preview_path = vdl._preview_path(entry, self.download_dir)
        commands = []

        def encode(command, **_kwargs):
            commands.append(command)
            with open(command[-1], "wb") as preview:
                preview.write(b"preview")
            return subprocess.CompletedProcess(command, 0)

        with mock.patch.object(vdl, "ffprobe_video_duration", return_value=63), \
                mock.patch.object(vdl.subprocess, "run", side_effect=encode):
            self.assertTrue(vdl.generate_video_preview(media_path, preview_path))

        self.assertTrue(os.path.isfile(preview_path))
        command = commands[0]
        self.assertEqual(command.count("-i"), 7)
        self.assertEqual(
            [command[index + 1] for index, value in enumerate(command) if value == "-ss"],
            ["5.000", "13.500", "22.000", "30.500", "39.000", "47.500", "56.000"],
        )
        self.assertIn("concat=n=7:v=1:a=0[outv]", command[command.index("-filter_complex") + 1])
        self.assertEqual(command[command.index("-c:v") + 1], "libx264")
        self.assertEqual(command[command.index("-r") + 1], "12")
        self.assertEqual(command[command.index("-pix_fmt") + 1], "yuv420p")
        self.assertIn("+faststart", command)

    def test_generator_failure_removes_its_temporary_file(self):
        media_path = self.finished_file()
        entry = vdl.db_get_download("test0001")
        preview_path = vdl._preview_path(entry, self.download_dir)

        def fail(command, **_kwargs):
            with open(command[-1], "wb") as preview:
                preview.write(b"partial")
            return subprocess.CompletedProcess(command, 1)

        with mock.patch.object(vdl, "ffprobe_video_duration", return_value=30), \
                mock.patch.object(vdl.subprocess, "run", side_effect=fail):
            self.assertFalse(vdl.generate_video_preview(media_path, preview_path))

        self.assertFalse(os.path.exists(preview_path))
        self.assertFalse(any(
            name.startswith(os.path.basename(preview_path) + ".")
            for name in os.listdir(self.download_dir)
        ))

    def test_preview_endpoint_generates_once_caches_and_supports_ranges(self):
        self.finished_file()
        stale_path = os.path.join(
            self.download_dir, ".vdl_test0001.preview-v2.mp4"
        )
        with open(stale_path, "wb") as stale_preview:
            stale_preview.write(b"edge-inclusive-preview")

        def generate(_source, destination):
            with open(destination, "wb") as preview:
                preview.write(b"0123456789")
            return True

        with mock.patch.object(vdl, "generate_video_preview", side_effect=generate) as generator:
            first = self.client.get("/api/preview/test0001")
            second = self.client.get(
                "/api/preview/test0001", headers={"Range": "bytes=2-5"}
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.mimetype, "video/mp4")
        self.assertEqual(first.data, b"0123456789")
        self.assertEqual(second.status_code, 206)
        self.assertEqual(second.data, b"2345")
        generator.assert_called_once()
        first.close()
        second.close()

    def test_preview_endpoint_rejects_missing_non_video_and_external_media(self):
        self.insert("active01")
        self.assertEqual(self.client.get("/api/preview/active01").status_code, 404)

        self.finished_file()
        with mock.patch.object(vdl, "generate_video_preview", return_value=False):
            self.assertEqual(self.client.get("/api/preview/test0001").status_code, 404)

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
        with mock.patch.object(vdl, "generate_video_preview") as generator:
            response = self.client.get("/api/preview/tampered")
        self.assertEqual(response.status_code, 403)
        generator.assert_not_called()

    def test_remove_deletes_hover_preview_with_media(self):
        media_path = self.finished_file()
        entry = vdl.db_get_download("test0001")
        preview_path = vdl._preview_path(entry, self.download_dir)
        with open(preview_path, "wb") as preview:
            preview.write(b"preview")

        response = self.client.post("/api/remove/test0001")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(os.path.exists(media_path))
        self.assertFalse(os.path.exists(preview_path))


if __name__ == "__main__":
    unittest.main()
