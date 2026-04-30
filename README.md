# VDL

A lightweight Flask-based video downloader UI powered by `yt-dlp`.

## Setup

1. Create and activate a Python virtual environment:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```

2. Install dependencies:

   ```bash
   python -m pip install --upgrade pip
   python -m pip install -r requirements.txt
   ```

## Run

```bash
python vdl.py
```

Then open `http://127.0.0.1:5000` in your browser.

## Notes

- The app stores its SQLite state in `downloads.db` by default.
- The default download directory is `.` unless overridden via the `DOWNLOADS_DIR` environment variable.
- To bind on all interfaces in development, set `HOST=0.0.0.0`.
- `ffmpeg` is needed for some downloaded formats and to probe final resolution.

## Optional Dependencies

Install system packages for full functionality:

- `ffmpeg`
