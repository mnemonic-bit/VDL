# Permanent regression suite

The suite is deterministic and never contacts a public media site. Each layer
uses temporary databases, download directories, generated media, dynamic
ports, and uniquely named container resources.

## Commands

The existing fast command remains supported:

```bash
python -m unittest discover -s tests -v
```

Local-media cases intentionally skip in that command. The tier runner makes
requirements explicit:

```bash
./tests/run-all.sh --unit       # fast Python and Flask contracts
./tests/run-all.sh --browser    # Playwright with a deterministic fixture app
./tests/run-all.sh --media      # generated MP4/DASH through yt-dlp + ffmpeg
./tests/run-all.sh --container  # root Dockerfile, persistence, local DASH
./tests/run-all.sh --all        # required retirement/release gate
```

Install native dependencies with `requirements.txt`. Browser setup is:

```bash
cd tests/browser
npm ci
npx playwright install chromium
```

Set `VDL_PYTHON` when the Python with Flask and yt-dlp is not on `PATH`.
The runners can use `CONTAINER_ENGINE=podman` and `VDL_IMAGE=vdl:local`.
Developer media runs skip when tools are absent; `--media`, `--container`, and
`--all` treat missing required tools as failures with setup guidance.

## Expected failures

Open bugs assert desired behavior using `unittest.expectedFailure` or
Playwright `test.fail()`. An unexpected pass fails its tier so the marker must
be removed with the bug fix. Current markers name Bugs 3, 4, 5, 7, and 10–13
from `BUG.md`. Pending roadmap features have no absence assertions.

## Coverage decisions and limitations

- The Download History tab is the accepted replacement for a foldable
  finished-download section.
- Empty Download Options intentionally retains disabled fields behind its
  explanatory message.
- Save and Cancel must both work in inline rename; their relative order is not
  contractual.
- On macOS, manually verify that Escape closes overlay playback without
  unexpectedly leaving native application fullscreen. Linux Chromium cannot
  establish this platform behavior.
- `scripts/network-smoke.sh` remains an explicitly nondeterministic external
  extractor diagnostic and is not part of any permanent tier.

Failure screenshots and traces are generated under
`tests/browser/test-results/` and are not golden inputs.
