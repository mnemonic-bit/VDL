import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase
from tests.support.fake_ytdlp import FakeYoutubeDL


FORMATS = [
    {
        "format_id": "v720",
        "ext": "mp4",
        "height": 720,
        "vcodec": "h264",
        "acodec": "none",
        "tbr": 900,
    },
    {
        "format_id": "v360",
        "ext": "mp4",
        "height": 360,
        "vcodec": "h264",
        "acodec": "none",
        "tbr": 500,
    },
    {
        "format_id": "a1",
        "ext": "m4a",
        "resolution": "audio only",
        "vcodec": "none",
        "acodec": "aac",
        "abr": 128,
    },
]


class FormatContractTest(AppCase):
    def test_summary_drops_source_urls_and_selects_best_video(self):
        summary = vdl.summarize_formats({"formats": [{**FORMATS[0], "url": "secret"}, *FORMATS[1:]]})
        self.assertTrue(all("url" not in item for item in summary))
        self.assertEqual(vdl.pick_best_format_id(summary), "v720")

    def test_audio_only_table_falls_back_to_best_audio_format(self):
        summary = vdl.summarize_formats({"formats": FORMATS[2:]})
        self.assertEqual(vdl.pick_best_format_id(summary), "a1")

    @unittest.expectedFailure  # BUG 4
    def test_probe_exposes_only_numeric_video_qualities(self):
        class Probe:
            def __init__(self, _options):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

            def extract_info(self, _url, download=False):
                return {"title": "fixture", "formats": FORMATS}

        with mock.patch.object(vdl.yt_dlp, "YoutubeDL", Probe):
            response = self.client.post("/api/probe", json={"url": "https://fixture.invalid"})
        self.assertEqual(response.get_json()["resolutions"], ["720p", "360p"])

    @unittest.expectedFailure  # BUG 4
    def test_combined_source_audio_selection_configures_audio_extraction(self):
        FakeYoutubeDL.reset()
        download_id = self.insert()
        vdl.db_update_download(download_id, requested_format="bestaudio/best")
        with (
            mock.patch.object(vdl.yt_dlp, "YoutubeDL", FakeYoutubeDL),
            mock.patch.object(vdl, "ffprobe_resolution", return_value=None),
        ):
            vdl.background_download("https://fixture.invalid/combined.mp4", download_id)
        download_options = next(options for options in FakeYoutubeDL.calls if "outtmpl" in options)
        self.assertEqual(
            download_options["postprocessors"],
            [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}],
        )

    def test_mp4_probe_data_preserves_compatible_stream_extensions(self):
        summary = vdl.summarize_formats({"formats": FORMATS})
        video = [item for item in summary if item["ext"] == "mp4" and item["vcodec"] != "none"]
        audio = [item for item in summary if item["ext"] == "m4a" and item["acodec"] != "none"]
        self.assertTrue(video)
        self.assertTrue(audio)


if __name__ == "__main__":
    unittest.main()
