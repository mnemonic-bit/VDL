# VDL — KNOWLEDGE BASE

**Generated:** 2026-05-03 · **Commit:** `0214834` · **Branch:** `main`

## OVERVIEW
Flask + `yt-dlp` video-downloader UI. **Single-process, single-file backend** ([`vdl.py`](file:///workspace/vdl.py), 1004 lines), vanilla-JS frontend ([`static/app.js`](file:///workspace/static/app.js), 929 lines), SQLite for state, **SSE for live UI push** (no polling).

## STRUCTURE
```
/workspace/
├── vdl.py                # ALL backend: routes, DB, worker threads, event bus
├── static/
│   ├── app.js            # ALL frontend logic — no bundler, no modules
│   └── styles.css        # CSS custom-property theming (light/dark)
├── templates/index.html  # Page shell + inline SVG icon library (#i-* symbols)
├── media/                # gitignored — runtime download output
├── downloads.db          # gitignored — SQLite state, schema in init_db()
├── requirements.txt      # Flask>=2.0, yt-dlp>=2024.12.0
├── Dockerfile            # Hardened VDL image; Compose runtime in compose.yaml
└── TODOs.md              # Roadmap; mostly checked off
```

## WHERE TO LOOK
| Task | Location |
|---|---|
| HTTP routes | [`vdl.py` Routes section](file:///workspace/vdl.py#L660-L989) |
| Download lifecycle | [`background_download`](file:///workspace/vdl.py#L511-L636) + [`progress_hook`](file:///workspace/vdl.py#L323-L411) |
| Pause / cancel flags | [in-memory dicts + lock](file:///workspace/vdl.py#L280-L321) |
| SSE push pipeline | [`EventBus`](file:///workspace/vdl.py#L26-L65) → [`/api/events`](file:///workspace/vdl.py#L891-L926) → [`connectEventStream`](file:///workspace/static/app.js#L909-L928) |
| DB schema + migrations | [`init_db`](file:///workspace/vdl.py#L105-L163) |
| Format auto-fallback | [probe phase](file:///workspace/vdl.py#L556-L573) + [retry on `Requested format is not available`](file:///workspace/vdl.py#L577-L596) |
| Path-traversal guard | [`stream_file` allowlist from history](file:///workspace/vdl.py#L929-L975) |
| Inline rename UX | [`renameDrafts` + start/commit/cancel](file:///workspace/static/app.js#L208-L310) |
| Theme bootstrap (no FOUC) | [inline `<script>`](file:///workspace/templates/index.html#L12-L22) + [`applyTheme`](file:///workspace/static/app.js#L829-L846) |
| Icon set | [`<symbol id="i-*">` defs](file:///workspace/templates/index.html#L28-L121) |
| Status sets (server↔client mirror) | [`TERMINAL_STATUSES`](file:///workspace/vdl.py#L84) ↔ [JS sets](file:///workspace/static/app.js#L1-L8) |

## ARCHITECTURE
- **Threading model**: Flask dev server with `threaded=True` ([required](file:///workspace/vdl.py#L1004) — SSE holds long-lived connections). One **daemon thread per download** runs `background_download(url, id)`.
- **Cancellation**: in-memory `_cancel_flags` / `_pause_flags` dicts guarded by `_cancel_lock`. Pause works by **stalling inside `progress_hook`** between yt-dlp chunk reads — no connection teardown.
- **Pub/sub**: `EventBus` with bounded `queue.Queue(maxsize=64)` per subscriber; **drops oldest on overflow** (clients reconcile via `/api/history` on next event anyway).
- **SQLite**: single global `_db_lock` serialises writes. Connections are **opened per-call**, never shared across threads.
- **Schema evolution**: `init_db()` uses `PRAGMA table_info` + `ALTER TABLE` to add missing columns. New columns go in [the migrations list](file:///workspace/vdl.py#L122-L140), NOT in the initial `CREATE TABLE`.
- **Probe → download → re-probe**: `extract_info(download=False)` first to capture `formats` + `title`, then `ydl.download()`, then `ffprobe` for the merged container's authoritative resolution.
- **Crash recovery**: every `init_db()` flips rows in `starting`/`downloading`/`paused` → `interrupted`. Previous-process workers are gone.

## STATUS VOCABULARY (canonical, mirrored both sides)
- **Active**: `starting`, `downloading`, `paused` *(worker thread alive)*
- **Terminal**: `finished`, `error`, `cancelled`, `interrupted`
- **Current tab** shows: active + `cancelled` + `interrupted` (so user can resume)
- **History tab** shows: `finished` + `error` only

## CONVENTIONS
- **Comment culture**: rationale-not-what. Existing comments explain *why* (e.g. why `speed=0.0` not `None`, why `continuedl=True` is explicit, why we drop the head on full queue). Match this register.
- **Frontend has NO build step**: `app.js` loads raw. No `import`/`export`, no bundler, no transpiler. Browser globals only.
- **Icons** live in [`index.html` `<defs>`](file:///workspace/templates/index.html#L28-L121) — reference via `<svg><use href="#i-name"/></svg>`. Never inline duplicate SVG paths in JS templates.
- **CSS theming** via `:root` and `html[data-theme="dark"]` custom properties. No hard-coded hex outside the var blocks (a few action-button colours excepted).
- **Indentation**: 4 spaces (Python and JS).
- **Commit style**: `fix:`, `feature:`, `refactor:` prefixes; lowercase imperative.
- **Version bump is a completion criterion**: update root `VERSION` in the same change as shipped behavior. Features increment `MINOR` and reset `PATCH`; bug fixes increment `PATCH`; breaking or incompatible API changes increment `MAJOR` and reset `MINOR` and `PATCH` (including while major is zero). For mixed changes, apply only the highest-impact bump: `MAJOR` before `MINOR`, then `PATCH`. Documentation, tests, formatting, and behavior-neutral refactors do not independently require a bump.

## ANTI-PATTERNS (THIS PROJECT)
- **DO NOT** add a bundler / transpiler / framework to the frontend. It's intentionally vanilla.
- **DO NOT** broaden [`_is_format_unavailable_error`](file:///workspace/vdl.py#L500-L508) — only the literal "Requested format is not available" string triggers fallback. Generic ffmpeg/network errors must NOT retry with a different format.
- **DO NOT** write to the DB inside the [pause-wait loop](file:///workspace/vdl.py#L335-L341) — mark `paused` once on entry only.
- **DO NOT** accept `/`, `\`, `\x00`, `.`, or `..` in [rename payloads](file:///workspace/vdl.py#L834-L838). Bare basenames only; original extension is preserved.
- **DO NOT** modify the initial `CREATE TABLE` to add new columns. Append to [`init_db`'s migrations list](file:///workspace/vdl.py#L122-L140) so existing DBs upgrade.
- **DO NOT** remove `threaded=True` from [`app.run`](file:///workspace/vdl.py#L1004) — SSE will block all other requests.
- **DO NOT** rebuild playback paths from current `download_dir` preference. Use the stored `filename` so old history rows keep working after the user changes the preference. ([why](file:///workspace/vdl.py#L933-L942))
- **DO NOT** assume `localStorage` is available in the [theme bootstrap](file:///workspace/templates/index.html#L14-L20) — silently fall through to default light.
- **DO NOT** invent new status strings without updating BOTH [`TERMINAL_STATUSES`](file:///workspace/vdl.py#L84) and the [JS status sets](file:///workspace/static/app.js#L1-L8).

## GOTCHAS
- **Container dependencies are separately locked.** Native development uses `requirements.txt`; the image installs the hashed `requirements-container.txt` and keeps the optional BgUtils plugin dormant unless `VDL_POT_PROVIDER_URL` is set.
- **`/api/resume` ≠ `/api/unpause`**: `resume` spawns a NEW worker thread for `cancelled`/`interrupted` rows (relies on yt-dlp's `continuedl=True` to find the `.part` file). `unpause` clears the flag for an ALIVE paused worker.
- **Cancel beats pause**: [`request_cancel` drops the pause flag](file:///workspace/vdl.py#L290-L295) so a paused worker wakes up and aborts. Don't re-arm pause during cancel.
- **No CI or linter.** Run `python -m unittest discover -s tests -v`; UI lifecycle and external-site verification remain manual.
- **`media/` and `downloads.db` are tracked-in-tree but gitignored.** A fresh clone has neither; both are created on first run.

## COMMANDS
```bash
# Setup
python3 -m venv .venv && source .venv/bin/activate
python -m pip install --upgrade pip -r requirements.txt

# Run (defaults: 127.0.0.1:5000, debug on)
python vdl.py

# Bind all interfaces, debug off
HOST=0.0.0.0 FLASK_DEBUG=0 python vdl.py

# Override DB / download dir (e.g. in a container)
DOWNLOADS_DB=/data/downloads.db DOWNLOADS_DIR=/downloads python vdl.py

# Container deployment (loopback-only port, persistent named volumes)
docker compose up --build -d

# Optional PO-token provider profile
VDL_POT_PROVIDER_URL=http://bgutil-provider:4416 docker compose --profile pot up --build -d
```

## ENV VARS
| Var | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | set `0.0.0.0` for LAN dev |
| `PORT` | `5000` | |
| `FLASK_DEBUG` | `1` | `"1"` enables; any other value disables |
| `DOWNLOADS_DB` | `<repo>/downloads.db` | |
| `DOWNLOADS_DIR` | `.` | preferences row in DB overrides at runtime |
| `VDL_POT_PROVIDER_URL` | empty | HTTP(S) BgUtils base URL; empty disables plugin discovery in the image |

## EXTERNAL REQUIREMENTS
- **Native:** `ffmpeg` supplies media merging and `ffprobe_resolution()` support.
- **Container:** ffmpeg/ffprobe, Deno, EJS, curl-cffi, and tini are included; Chromium remains intentionally deferred.
