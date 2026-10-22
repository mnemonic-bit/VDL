# Permanent regression suite

The suite is deterministic and never contacts a public media site. Each layer
uses temporary databases, download directories, generated media, dynamic
ports, and uniquely named container resources.

## Commands

The existing fast command remains supported:

```bash
python -m unittest discover -s tests -v
```

The tier runner additionally measures executable lines in `vdl.py` with the
Python standard library and enforces the reviewed 90% baseline. This keeps the
gate dependency-free; behavior assertions remain the primary measure of test
quality.

Local-media cases intentionally skip in that command. The tier runner makes
requirements explicit:

```bash
./tests/run-all.sh --unit       # fast Python and Flask contracts
./tests/run-all.sh --browser    # Playwright with a deterministic fixture app
./tests/run-all.sh --media      # generated MP4/DASH through yt-dlp + ffmpeg
./tests/run-all.sh --container  # root Dockerfile, persistence, local DASH
./tests/run-all.sh --all        # required retirement/release gate
```

Before changing or publishing the container dependency lock, verify that its
hashed wheels cover both shipping architectures:

```bash
./tests/container/check-lock.sh
```

This check contacts the Python package index but never installs the downloaded
wheels. The validation workflow runs it before the multi-platform publication
job can start.

Validate the CodeQL Action revisions and exercise the one-step-update
regression before changing workflow dependencies:

```bash
npm ci
node scripts/check-codeql-pins.cjs
node --test tests/codeql-pins.test.cjs
```

The validation workflow runs both commands on every pull request to `main`,
including Dependabot updates. They use the root development tooling; no YAML
parser is added to the application or container dependencies.

Install native dependencies with `requirements.txt`. Browser setup is:

```bash
cd tests/browser
npm ci
npx playwright install chromium
```

The crossfade tests include a small generated WebM fixture for real buffering,
media clocks, and fullscreen, alongside simulated clocks for failure cases.
To exercise them on additional engines:

```bash
cd tests/browser
npx playwright install firefox webkit
VDL_TEST_BROWSER=firefox python3 run.py crossfade.spec.cjs crossfade-media.spec.cjs
VDL_TEST_BROWSER=webkit python3 run.py crossfade.spec.cjs crossfade-media.spec.cjs
```

Playwright WebKit is useful engine coverage; Safari's native fullscreen and
per-element autoplay policy still need a supported macOS device.

Set `VDL_PYTHON` when the Python with Flask and yt-dlp is not on `PATH`.
The runners can use `CONTAINER_ENGINE=podman` and `VDL_IMAGE=vdl:local`.
Developer media runs skip when tools are absent; `--media`, `--container`, and
`--all` treat missing required tools as failures with setup guidance.

## Expected failures

Open bugs assert desired behavior using `unittest.expectedFailure` or
Playwright `test.fail()`. An unexpected pass fails its tier so the marker must
be removed with the bug fix. There are currently no expected-failure markers.
Bug 22's passing tests protect rejected actions, cleanup failures, migrations,
pagination, version rendering, state-transition rejection, and container
parity. Pending roadmap features have no absence assertions.

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
