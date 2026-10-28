import os
import shutil
import threading
import time
import unittest
from unittest import mock

import yt_dlp

import vdl
from download_bandwidth import govern_download
from tests.support.app_case import AppCase
from tests.support.fixture_server import FixtureHandler, fixture_server
from tests.support.media_factory import generate_media, require_media_tools, run, streams


class RealMediaIntegrationTest(AppCase):
    def setUp(self):
        require_media_tools(self)
        super().setUp()
        self.media = generate_media(self.temp_dir.name)

    def download(self, url, selector, download_id):
        self.insert(download_id, url)
        vdl.db_update_download(download_id, requested_format=selector)
        vdl.background_download(url, download_id)
        row = vdl.db_get_download(download_id)
        self.assertEqual(row["status"], "finished", row["progress"])
        return row

    def test_hls_unlimited_external_and_capped_native_downloads_keep_playable_media(self):
        manifest = os.path.join(self.temp_dir.name, 'fixture.m3u8')
        run([
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', self.media['combined'], '-c', 'copy',
            '-hls_time', '1', '-hls_list_size', '0', '-f', 'hls', manifest,
        ])
        with fixture_server(self.temp_dir.name) as server:
            for rate in ('0', '10', '50'):
                with self.subTest(rate=rate):
                    download_id = 'hls-rate-' + rate
                    vdl.db_set_preferences({'max_total_download_mbps': rate})
                    url = server.base_url + '/fixture.m3u8'
                    self.insert(download_id, url)
                    destination = os.path.join(self.download_dir, download_id + '.mp4')
                    with yt_dlp.YoutubeDL({
                        'quiet': True, 'noprogress': True,
                        'progress_hooks': [lambda data: vdl.progress_hook(data, download_id)],
                    }) as ydl:
                        govern_download(ydl, vdl._bandwidth, download_id)
                        success, _ = ydl.dl(destination, {
                            'url': url, 'protocol': 'm3u8', 'ext': 'mp4',
                            'is_live': False, 'id': download_id, 'title': 'fixture',
                        })
                    self.assertTrue(success)
                    actual = streams(destination)
                    self.assertTrue(any(stream['codec_type'] == 'video' for stream in actual))
                    self.assertTrue(any(stream['codec_type'] == 'audio' for stream in actual))
                    run(['ffmpeg', '-hide_banner', '-loglevel', 'error',
                         '-i', destination, '-f', 'null', '-'])

    def test_dash_merge_stored_path_playback_rename_and_removal(self):
        with fixture_server(self.temp_dir.name) as server:
            row = self.download(
                server.base_url + "/manifest.mpd",
                "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]",
                "dash0360",
            )
        actual = streams(row["filename"])
        self.assertTrue(any(item["codec_type"] == "video" and item["height"] == 360 for item in actual))
        self.assertTrue(any(item["codec_type"] == "audio" for item in actual))

        playback = self.client.get("/api/file/dash0360", headers={"Range": "bytes=0-99"})
        self.assertEqual((playback.status_code, len(playback.data)), (206, 100))
        playback.close()
        renamed = self.client.post("/api/rename/dash0360", json={"filename": "renamed-dash"})
        self.assertEqual(renamed.status_code, 200)
        renamed_path = vdl.db_get_download("dash0360")["filename"]
        self.assertEqual(renamed.get_json()["filename"], os.path.basename(renamed_path))
        self.assertTrue(os.path.isfile(renamed_path))
        self.client.post("/api/remove/dash0360")
        self.assertFalse(os.path.exists(renamed_path))

    def test_separate_stream_audio_selection_is_audio_only(self):
        with fixture_server(self.temp_dir.name) as server:
            row = self.download(server.base_url + "/manifest.mpd", "bestaudio/best", "dashaudio")
        self.assertTrue(streams(row["filename"]))
        self.assertTrue(all(item["codec_type"] == "audio" for item in streams(row["filename"])))

    def test_combined_source_audio_selection_extracts_audio(self):
        with fixture_server(self.temp_dir.name) as server:
            row = self.download(server.base_url + "/combined.mp4", "bestaudio/best", "mp4audio")
        self.assertTrue(all(item["codec_type"] == "audio" for item in streams(row["filename"])))

    def test_hover_preview_is_a_cached_silent_browser_mp4(self):
        media_path = os.path.join(self.download_dir, "preview-source.mp4")
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=160x90:rate=12:duration=24",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
            media_path,
        ])
        self.insert("preview1")
        vdl.db_update_download(
            "preview1",
            status="finished",
            progress="100%",
            filename=media_path,
            output_dir=self.download_dir,
            filesize=os.path.getsize(media_path),
            finished_at=time.time(),
        )

        pending = self.client.get("/api/preview/preview1")
        self.assertEqual(pending.status_code, 202)
        commands = []
        native_run = vdl.subprocess.run

        def record(command, **kwargs):
            commands.append(command)
            return native_run(command, **kwargs)

        with mock.patch.object(vdl.subprocess, "run", side_effect=record):
            queue = vdl._get_asset_queue()
            self.assertTrue(queue.step())
            self.assertTrue(queue.step())

        thumbnail_path = vdl._thumbnail_path(vdl.db_get_download("preview1"))
        with open(thumbnail_path, "rb") as image:
            self.assertEqual(image.read(2), b"\xff\xd8")
        ffmpeg_commands = [command for command in commands if command[0] == "ffmpeg"]
        self.assertEqual(len(ffmpeg_commands), 2)
        for command in ffmpeg_commands:
            for flag in ("-filter_threads", "-filter_complex_threads"):
                self.assertEqual(command[command.index(flag) + 1], "1")
            self.assertEqual(command[command.index("-threads") + 1], "1")
        montage_command = next(command for command in ffmpeg_commands if "-filter_complex" in command)
        for index, argument in enumerate(montage_command):
            if argument == "-i":
                self.assertIn("-threads", montage_command[max(0, index - 8):index])

        first = self.client.get("/api/preview/preview1")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.mimetype, "video/mp4")
        first.close()

        preview_path = vdl._preview_path(
            vdl.db_get_download("preview1"), self.download_dir
        )
        preview_streams = streams(preview_path)
        self.assertEqual(len(preview_streams), 1)
        self.assertEqual(preview_streams[0]["codec_type"], "video")
        self.assertEqual(preview_streams[0]["codec_name"], "h264")
        self.assertLessEqual(preview_streams[0]["level"], 30)
        self.assertLessEqual(preview_streams[0]["width"], 480)
        self.assertAlmostEqual(vdl.ffprobe_video_duration(preview_path), 14, delta=0.5)
        modified_at = os.path.getmtime(preview_path)

        second = self.client.get("/api/preview/preview1")
        self.assertEqual(second.status_code, 200)
        self.assertEqual(os.path.getmtime(preview_path), modified_at)
        second.close()

    def test_stop_and_continue_uses_http_range(self):
        slow_dir = os.path.join(self.temp_dir.name, "slow")
        os.mkdir(slow_dir)
        shutil.copy2(self.media["combined"], os.path.join(slow_dir, "combined.mp4"))
        FixtureHandler.slow_chunk_delay = 0.04

        with fixture_server(self.temp_dir.name) as server:
            url = server.base_url + "/slow/combined.mp4"
            download_id = self.insert("resume01", url)
            worker = threading.Thread(target=vdl.background_download, args=(url, download_id))
            worker.start()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                row = vdl.db_get_download(download_id)
                if row["status"] == "downloading" and row["progress"] != "0%":
                    break
                time.sleep(0.02)
            vdl.request_cancel(download_id)
            worker.join(10)
            self.assertEqual(vdl.db_get_download(download_id)["status"], "cancelled")

            vdl.db_update_download(download_id, status="starting", progress="0%")
            vdl.background_download(url, download_id)
            self.assertEqual(vdl.db_get_download(download_id)["status"], "finished")
        self.assertTrue(any(start > 0 for _path, start, _end in FixtureHandler.range_requests))


if __name__ == "__main__":
    unittest.main()
