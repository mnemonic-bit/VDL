import os
import tempfile
import unittest
from unittest import mock

import vdl


class FakeYoutubeDL:
    """Model the yt-dlp hook order for separate video/audio streams."""

    def __init__(self, options):
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def extract_info(self, url, download=False):
        return {
            "title": "fixture",
            "formats": [
                {
                    "format_id": "v1",
                    "ext": "mp4",
                    "height": 360,
                    "vcodec": "h264",
                    "acodec": "none",
                },
                {
                    "format_id": "a1",
                    "ext": "m4a",
                    "vcodec": "none",
                    "acodec": "aac",
                },
            ],
        }

    def download(self, urls):
        output_template = self.options["outtmpl"]
        final_path = (
            output_template
            .replace("%(title)s", "fixture")
            .replace("%(ext)s", "mp4")
        )
        base, _ = os.path.splitext(final_path)
        common_info = {"title": "fixture", "_filename": final_path}

        for hook in self.options["progress_hooks"]:
            hook({
                "status": "finished",
                "filename": base + ".f1.mp4",
                "info_dict": {**common_info, "height": 360},
            })
            hook({
                "status": "finished",
                "filename": base + ".f2.m4a",
                "info_dict": common_info,
            })

        with open(final_path, "wb") as merged_file:
            merged_file.write(b"merged video and audio")

        for hook in self.options.get("postprocessor_hooks", []):
            hook({
                "status": "finished",
                "postprocessor": "Merger",
                "info_dict": {
                    **common_info,
                    "filepath": final_path,
                },
            })


class MergedDownloadPathTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = vdl.DB_PATH
        vdl.DB_PATH = os.path.join(self.temp_dir.name, "downloads.db")
        vdl.init_db()
        vdl.db_set_preferences({"download_dir": self.temp_dir.name})

    def tearDown(self):
        vdl.DB_PATH = self.old_db_path
        self.temp_dir.cleanup()

    def test_stream_completion_does_not_finish_job_before_merge(self):
        download_id = "merge000"
        vdl.db_insert_download(download_id, "https://fixture.invalid/manifest.mpd")
        final_path = os.path.join(
            self.temp_dir.name,
            f"fixture_{download_id}.mp4",
        )

        vdl.progress_hook({
            "status": "finished",
            "filename": os.path.splitext(final_path)[0] + ".f1.mp4",
            "info_dict": {
                "title": "fixture",
                "height": 360,
                "_filename": final_path,
            },
        }, download_id)

        row = vdl.db_get_download(download_id)
        self.assertEqual(row["status"], "downloading")
        self.assertIsNone(row["finished_at"])

    def test_merged_output_is_used_for_playback_rename_and_removal(self):
        download_id = "merge001"
        vdl.db_insert_download(download_id, "https://fixture.invalid/manifest.mpd")
        vdl.db_update_download(
            download_id,
            requested_format="bestvideo+bestaudio/best",
        )

        with (
            mock.patch.object(vdl.yt_dlp, "YoutubeDL", FakeYoutubeDL),
            mock.patch.object(vdl, "ffprobe_resolution", return_value="360p"),
        ):
            vdl.background_download(
                "https://fixture.invalid/manifest.mpd",
                download_id,
            )

        expected_path = os.path.join(
            self.temp_dir.name,
            f"fixture_{download_id}.mp4",
        )
        row = vdl.db_get_download(download_id)
        self.assertEqual(row["status"], "finished")
        self.assertEqual(row["filename"], expected_path)
        self.assertEqual(row["filesize"], os.path.getsize(expected_path))
        self.assertEqual(row["resolution"], "360p")

        client = vdl.app.test_client()
        playback_response = client.get(f"/api/file/{download_id}")
        self.assertEqual(playback_response.status_code, 200)
        playback_response.close()

        rename_response = client.post(
            f"/api/rename/{download_id}",
            json={"filename": "renamed-merge"},
        )
        self.assertEqual(rename_response.status_code, 200)
        renamed_path = os.path.join(self.temp_dir.name, "renamed-merge.mp4")
        self.assertEqual(vdl.db_get_download(download_id)["filename"], renamed_path)

        self.assertEqual(client.post(f"/api/remove/{download_id}").status_code, 200)
        self.assertFalse(os.path.exists(renamed_path))


if __name__ == "__main__":
    unittest.main()
