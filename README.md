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

## Docker

Build the image (note: the file is named `Dockerfile.vdl`, not `Dockerfile`):

```bash
docker build -f Dockerfile.vdl -t vdl .
```

Run the container, mounting host directories for persistence across restarts:

```bash
docker run -d \
  -p 5000:5000 \
  -v /path/to/downloads:/downloads \
  -v /path/to/data:/data \
  vdl
```

Then open `http://localhost:5000` in your browser.

- `/downloads` — where downloaded files are saved (`DOWNLOADS_DIR`)
- `/data` — where `downloads.db` (SQLite state) is stored (`DOWNLOADS_DB`)

Both paths are baked into the image as defaults; the `-v` mounts simply persist them on the host so data survives container restarts.

To override defaults, pass `-e` flags:

```bash
docker run -d \
  -p 5000:5000 \
  -v /path/to/downloads:/downloads \
  -v /path/to/data:/data \
  -e PORT=8080 \
  -e FLASK_DEBUG=1 \
  vdl
```

## Notes

- The app stores its SQLite state in `downloads.db` by default.
- The default download directory is `.` unless overridden via the `DOWNLOADS_DIR` environment variable.
- To bind on all interfaces in development, set `HOST=0.0.0.0`.
- `ffmpeg` is needed for some downloaded formats and to probe final resolution.

## Optional Dependencies

Install system packages for full functionality:

- `ffmpeg`
