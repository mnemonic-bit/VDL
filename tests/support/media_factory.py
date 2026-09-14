import json
import os
import shutil
import subprocess


def require_media_tools(test_case):
    if os.environ.get("VDL_RUN_MEDIA") != "1" and os.environ.get("VDL_REQUIRE_MEDIA_TOOLS") != "1":
        test_case.skipTest("set VDL_RUN_MEDIA=1 to run local-media integration")
    missing = [tool for tool in ("ffmpeg", "ffprobe") if not shutil.which(tool)]
    if missing:
        message = "requires " + ", ".join(missing)
        if os.environ.get("VDL_REQUIRE_MEDIA_TOOLS") == "1":
            test_case.fail(message)
        test_case.skipTest(message)


def run(command):
    subprocess.run(command, check=True, capture_output=True, text=True)


def generate_media(directory, duration=4):
    """Generate a combined MP4 and a two-quality DASH presentation."""
    combined = os.path.join(directory, "combined.mp4")
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc=size=1280x720:rate=24:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=1000:duration={duration}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
        "-c:a", "aac", "-shortest", combined,
    ])

    manifest = os.path.join(directory, "manifest.mpd")
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", combined,
        "-map", "0:v:0", "-map", "0:v:0", "-map", "0:a:0",
        "-filter:v:0", "scale=1280:720", "-filter:v:1", "scale=640:360",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
        "-adaptation_sets", "id=0,streams=v id=1,streams=a",
        "-use_template", "1", "-use_timeline", "1", "-f", "dash", manifest,
    ])
    return {"combined": combined, "manifest": manifest}


def streams(path):
    output = subprocess.check_output([
        "ffprobe", "-v", "quiet", "-show_streams", "-of", "json", path,
    ], text=True)
    return json.loads(output)["streams"]
