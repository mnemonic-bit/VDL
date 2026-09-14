import os
import threading
import time

import yt_dlp


class FakeYoutubeDL:
    """Small yt-dlp double covering probe, progress, errors, and final hooks."""

    calls = []
    entered = threading.Event()
    release = threading.Event()
    block_downloads = False
    fail_downloads = False

    @classmethod
    def reset(cls):
        cls.calls = []
        cls.entered = threading.Event()
        cls.release = threading.Event()
        cls.block_downloads = False
        cls.fail_downloads = False

    def __init__(self, options):
        self.options = options
        type(self).calls.append(options)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def extract_info(self, url, download=False):
        if "slow-probe" in url:
            time.sleep(0.9)
        title = "Rock & Roll <Live>" if "raw-title" in url else os.path.basename(url) or "fixture"
        return {
            "title": title,
            "formats": [
                {
                    "format_id": "v360",
                    "ext": "mp4",
                    "height": 360,
                    "resolution": "640x360",
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
            ],
        }

    def download(self, urls):
        url = urls[0]
        type(self).entered.set()
        if self.fail_downloads or "missing" in url:
            raise yt_dlp.utils.DownloadError("HTTP Error 404: Not Found")
        while self.block_downloads and not self.release.wait(0.02):
            pass

        template = self.options["outtmpl"]
        path = template.replace("%(title)s", "fixture").replace("%(ext)s", "mp4")
        info = {
            "title": "fixture",
            "height": 360,
            "_filename": path,
            "filepath": path,
        }
        for hook in self.options.get("progress_hooks", []):
            hook({
                "status": "downloading",
                "downloaded_bytes": 5,
                "total_bytes": 10,
                "speed": 5,
                "eta": 1,
                "info_dict": info,
            })
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as output:
            output.write(b"fixture-media")
        for hook in self.options.get("progress_hooks", []):
            hook({"status": "finished", "filename": path, "info_dict": info})
        for hook in self.options.get("postprocessor_hooks", []):
            hook({"status": "finished", "info_dict": info})
