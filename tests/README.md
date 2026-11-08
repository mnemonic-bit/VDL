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

Preview-cache upgrades have deterministic fake-clock, publication-fault, and
reader-lease tests. Run their browser checks with native Chromium or Firefox:

```bash
python3 tests/browser/run.py system-logs.spec.cjs asset-demand.spec.cjs preview-handoff-media.spec.cjs
VDL_TEST_BROWSER=firefox python3 tests/browser/run.py system-logs.spec.cjs asset-demand.spec.cjs preview-handoff-media.spec.cjs
python3 tests/container/check-preview-maintenance.py --image vdl:local
```

The last command uses isolated named volumes to verify graceful and abrupt
shutdown, container replacement, persistent logs/counters/pacing, and recovery
after successful publication without another encode. Build the named image
from the current sources first.

Before changing or publishing the container dependency lock, verify that its
hashed wheels cover both shipping architectures:

```bash
./tests/container/check-lock.sh
```

This check contacts the Python package index but never installs the downloaded
wheels. The validation workflow runs it before the multi-platform publication
job can start.

Exercise both signed and unsigned release artifacts through independent staging,
image builds, served bytes, checksum, identity/version and signature-state checks:

```bash
CONTAINER_ENGINE=podman python3 tests/container/check-companion-states.py
# Requires QEMU/binfmt support on an amd64 host:
CONTAINER_ENGINE=docker python3 tests/container/check-companion-states.py --platform linux/arm64
```

These signatures are synthetic fixtures and cannot prove Mozilla signature
validity. Test a real signed XPI manually in Firefox before claiming normal
installation works. For an existing image, `tests/container/smoke.sh` accepts
`VDL_EXPECT_COMPANION_SIGNED=true|false` and `VDL_EXPECT_COMPANION_SHA256`; both
are supplied by verified artifact staging in the publisher. Local defaults
expect the checked-in unsigned package and its checksum.

Validate the CodeQL Action revisions and exercise the one-step-update
regression before changing workflow dependencies:

```bash
npm ci
node scripts/check-codeql-pins.cjs
node --test tests/*.test.cjs
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

Daily video storage has focused checks for persistent scheduling, current
authorization, filesystem aliases, failure recovery, and the accessible footer:

```bash
python -m unittest tests.test_library_storage -v
node --test tests/library-storage-client.test.cjs
python3 tests/browser/run.py library-storage.spec.cjs version-status.spec.cjs
```

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

Feature 0051's initial tag delivery has deterministic production-module tests,
transactional route tests, and browser tests with held mutation responses:

```bash
python -m unittest tests.test_tag_mutations tests.test_tags -v
node --test tests/mutations-client.test.cjs tests/tag-identity-parity.test.cjs
python3 tests/browser/run.py tags.spec.cjs immediate-feedback.spec.cjs
VDL_TEST_BROWSER=firefox python3 tests/browser/run.py tags.spec.cjs immediate-feedback.spec.cjs
```

The tag identity asset contains the Python Unicode tables used by supported
native interpreters and the container. Regenerate it using Python 3.11, 3.12,
3.13 and 3.14 together; `--check` verifies reproducibility without writing:

```bash
python3 scripts/generate-tag-identity.py --python python3.11 --python python3.12 --python python3.13 --python python3.14 --check
```

The parity test compares the helper with the actual server validator over case
folds, whitespace, category boundaries and non-BMP input. Set `VDL_PYTHON` to
select the server interpreter. Unknown Unicode versions deliberately use the
compatibility path until matching identity data ships. Remaining action adapters
are tracked in [the rollout inventory](../ARCHITECTURE/feature-0051-rollout.md).

Feature 0055's playlist editor saves use the same production coordinator and
actor-bound receipts while retaining integer playlist revisions:

```bash
python -m unittest tests.test_playlist_mutations tests.test_playlists -v
node --test tests/playlists-client.test.cjs
python3 tests/browser/run.py playlists-feedback.spec.cjs playlists.spec.cjs
VDL_TEST_BROWSER=firefox python3 tests/browser/run.py playlists-feedback.spec.cjs playlists.spec.cjs
```

The feedback suite holds requests to exercise immediate saving, newer drafts,
canonical confirmation without SSE, explicit conflict review, receipt recovery,
and stale callbacks. Feature 0032's proposed import and collaborative-sharing
controls are outside the current personal-playlist implementation.
