import json
import math
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
            os.path.join(self.download_dir, ".vdl_test0001.preview-v5.mp4"),
        )

    def test_preview_segments_span_long_videos_without_repeating_short_ones(self):
        for duration in (0, 9.999, 10):
            with self.subTest(duration=duration):
                self.assertEqual(vdl._preview_segments(duration), [])
        for duration in (10.001, 12, 15.999):
            with self.subTest(duration=duration):
                self.assertEqual(vdl._preview_segments(duration), [(5.0, duration - 10)])

        examples = {
            16: [5, 7, 9],
            19: [5, 8.5, 12],
            29: [5, 13.5, 22],
            30: [5, 11, 17, 23],
            31: [5, 34 / 3, 53 / 3, 24],
            59: [5, 62 / 3, 109 / 3, 52],
            60: [5, 17, 29, 41, 53],
        }
        for duration, expected in examples.items():
            with self.subTest(duration=duration):
                segments = vdl._preview_segments(duration)
                self.assertEqual(len(segments), len(expected))
                for (start, length), expected_start in zip(segments, expected):
                    self.assertAlmostEqual(start, expected_start)
                    self.assertEqual(length, 2)

        durations = [16.001, 63, 600, 3600, 7200, 86400]
        for multiple in (30, 60, 90, 600, 7200):
            durations.extend((multiple - 0.001, multiple, multiple + 0.001))
        for duration in durations:
            with self.subTest(duration=duration):
                segments = vdl._preview_segments(duration)
                self.assertEqual(len(segments), math.floor(duration / 30) + 3)
                self.assertEqual(segments[0][0], 5)
                self.assertAlmostEqual(sum(segments[-1]), duration - 5)
                self.assertTrue(all(length == 2 for _start, length in segments))
                spacing = (duration - 12) / (len(segments) - 1)
                rounded_intervals = []
                for (start, length), (following, _) in zip(segments, segments[1:]):
                    self.assertGreater(following, start)
                    self.assertGreaterEqual(following + 1e-9, start + length)
                    self.assertAlmostEqual(following - start, spacing)
                    self.assertLessEqual(following - start, 30)
                    rounded_intervals.append(round(following, 3) - round(start, 3))
                self.assertLessEqual(max(rounded_intervals) - min(rounded_intervals), 0.001 + 1e-9)

    def test_invalid_duration_keeps_preview_unavailable(self):
        for duration in (None, float('nan'), float('inf'), -float('inf'), -1, 'invalid'):
            with self.subTest(duration=duration):
                with mock.patch.object(vdl, 'ffprobe_video_duration', return_value=duration), \
                        mock.patch.object(vdl.subprocess, 'run') as encoder:
                    self.assertFalse(vdl.generate_video_preview('movie.mp4', 'preview.mp4'))
                encoder.assert_not_called()

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

        stream_duration = subprocess.CompletedProcess(
            [], 0,
            stdout=json.dumps({
                "streams": [{"duration": "42"}],
                "format": {"duration": "nan"},
            }),
        )
        with mock.patch.object(vdl.subprocess, "run", return_value=stream_duration):
            self.assertEqual(vdl.ffprobe_video_duration("movie.mp4"), 42)

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

    def test_generator_builds_a_duration_scaled_browser_mp4_atomically(self):
        media_path = self.finished_file()
        entry = vdl.db_get_download("test0001")
        preview_path = vdl._preview_path(entry, self.download_dir)
        commands = []

        def encode(command, **_kwargs):
            commands.append(command)
            with open(command[-1], "wb") as preview:
                preview.write(b"preview")
            return subprocess.CompletedProcess(command, 0)

        with mock.patch.object(vdl, "ffprobe_video_duration", return_value=600), \
                mock.patch.object(vdl.subprocess, "run", side_effect=encode):
            self.assertTrue(vdl.generate_video_preview(media_path, preview_path))

        self.assertTrue(os.path.isfile(preview_path))
        command = commands[0]
        self.assertEqual(command.count("-i"), 23)
        self.assertEqual(
            [command[index + 1] for index, value in enumerate(command) if value == "-ss"],
            [f'{5 + index * (588 / 22):.3f}' for index in range(23)],
        )
        self.assertEqual(
            [command[index + 1] for index, value in enumerate(command) if value == '-t'],
            ['2.000'] * 23,
        )
        filters = command[command.index('-filter_complex') + 1]
        self.assertIn(''.join(f'[v{index}]' for index in range(23))
                      + 'concat=n=23:v=1:a=0[outv]', filters)
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
            self.assertEqual(self.client.get("/api/preview/test0001").status_code, 202)
            generator.assert_not_called()
            with mock.patch.object(vdl, 'generate_video_thumbnail', return_value=False):
                self.assertTrue(vdl._get_asset_queue().step())
                self.assertTrue(vdl._get_asset_queue().step())
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

    def test_existing_library_item_regenerates_v4_montage_and_publishes_readiness(self):
        self.finished_file()
        entry = vdl.db_get_download('test0001')
        stale_path = os.path.join(self.download_dir, '.vdl_test0001.preview-v4.mp4')
        thumbnail_path = vdl._thumbnail_path(entry)
        for path in (stale_path, thumbnail_path):
            with open(path, 'wb') as asset:
                asset.write(b'cached-v4-era-asset')
        with vdl._db_lock, vdl.db() as connection:
            connection.execute("UPDATE generated_assets SET version=4,state='ready' "
                               "WHERE download_id='test0001' AND kind='montage'")
        queue = vdl._get_asset_queue()
        self.assertEqual(self.client.get('/api/library').get_json()[0]['assets'],
                         {'thumbnail': 'ready', 'montage': 'queued'})

        def generate(_source, destination):
            with open(destination, 'wb') as preview:
                preview.write(b'current-montage')
            return True

        with mock.patch.object(vdl, 'generate_video_preview', side_effect=generate) as generator, \
                mock.patch.object(vdl, 'generate_video_thumbnail') as thumbnail, \
                mock.patch.object(vdl.event_bus, 'publish') as publish:
            pending = self.client.post('/api/assets/demand', json={
                'tab_id': 'library', 'revision': 1, 'ids': ['test0001'],
                'hovered_id': 'test0001',
            })
            self.assertEqual(pending.get_json()['assets']['test0001']['montage'], 'queued')
            self.assertTrue(queue.step())
            publish.assert_called_with('assets', {'ids': ['test0001']})
            self.assertEqual(self.client.get('/api/library').get_json()[0]['assets'],
                             {'thumbnail': 'ready', 'montage': 'ready'})
            for _ in range(2):
                response = self.client.get('/api/preview/test0001?v=5')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, b'current-montage')
                response.close()
            self.assertFalse(queue.step())
        generator.assert_called_once()
        thumbnail.assert_not_called()
        self.assertEqual(vdl.db_get_download('test0001')['view_count'], 0)
        with vdl.db() as connection:
            versions = connection.execute("SELECT version FROM generated_assets "
                                          "WHERE download_id='test0001' AND kind='montage'").fetchall()
        self.assertEqual([row['version'] for row in versions], [5])

    def test_preview_endpoint_rejects_missing_non_video_and_external_media(self):
        self.insert("active01")
        self.assertEqual(self.client.get("/api/preview/active01").status_code, 404)

        self.finished_file()
        with mock.patch.object(vdl, "generate_video_preview") as generator:
            self.assertEqual(self.client.get("/api/preview/test0001").status_code, 202)
            generator.assert_not_called()

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
