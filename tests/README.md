# Permanent regression suite

The suite is deterministic and never contacts a public media site. Each layer
uses temporary databases, download directories, generated media, dynamic
ports, and uniquely named container resources.

## Focused test selection

Use the reviewed functional areas in [`areas.json`](areas.json) to select test
files without rediscovering ownership. The map owns membership, source hints,
and directed expansion reasons. Source hints guide selection; the runner does
not infer impact from changed filenames or Git diffs.

```bash
python3 tests/run-area.py --list
python3 tests/run-area.py rename --dry-run
python3 tests/run-area.py rename --layer python
python3 tests/run-area.py rename --layer node
python3 tests/run-area.py rename entry-removal --layer browser
python3 tests/run-area.py mutation-core --layer node --dry-run --json
python3 tests/run-area.py --all-areas --layer python --layer node
python3 tests/run-area.py --check
```

The default layers are `python` and `node`. Repeated `--layer` arguments replace
those defaults with their union. The `browser`, `media`, and `container` layers
require explicit selection. An explicitly selected empty layer is an error.
Selectors identify complete files or fixed container checks, so a shared media
module still runs all its cases. Native runners can narrow a failing case during
editing; area selection does not isolate individual cases.

Before code changes, identify affected leaf areas and every changed shared
contract from the map's summaries and source hints. Record the selection and
uncertainty in the progress update, then preview the expanded plan once. A leaf
selection such as `rename` stays local. A shared selection such as
`mutation-core` expands to the implemented adapters because admission, receipts,
replay, and ordering are shared. Expansion is directional. If impact remains
uncertain, broaden explicitly, including all areas in the affected layers when
necessary.

During editing, rerun the failing native regression or the affected area/layer.
After the change stabilizes, run the union of affected areas and relevant
layers. Browser-visible changes require the relevant browser checks;
decoding/merge changes require media checks; deployment/dependency changes
require the corresponding container checks. The default layers alone do not
establish that omitted layers are irrelevant. Add or update memberships when
tests move, appear, or disappear. Maintain source hints and expansion rules when
shared contracts change, then run `--check`. New behavior needs an area before
focused selection can validate that behavior. If the map or runner is invalid
or unavailable, report the condition and use explicit native commands or the
existing broader gates.

Listing, dry runs, and map validation use only the Python standard library.
`--check` recursively checks permanent test ownership, including nested tests,
while excluding support, fixture, dependency, and generated-output directories.
It does not import tests or start the application. Plans explain selected files,
expansion reasons, exact argv, environment overrides, counts, and omitted layers.
JSON plans are available only with `--dry-run --json`.

Execution uses `VDL_PYTHON` or the interpreter running the focused runner. Install
`requirements.txt` into that interpreter before Python, browser fixture, media,
or Python-backed Node parity work. Node work also requires Node and root
development dependencies (`npm ci`). Browser work requires installed Playwright
and its selected browser (`VDL_TEST_BROWSER`, default Chromium); use the browser
setup commands below. `PLAYWRIGHT_CLI` can select an existing CLI. Media work
requires ffmpeg and ffprobe. The focused runner checks prerequisites for all
selected layers before executing tests and never installs dependencies or uses
a container fallback for native layers.

Explicit container checks retain their existing engine handling, builds, and
network requirements. `CONTAINER_ENGINE` and `VDL_IMAGE` select the engine and
image. The preview-maintenance check requires an image built from the current
sources; a tag alone does not establish freshness. Dependency-lock validation
contacts the package index. Check the printed plan before running these layers.

Layers execute sequentially and stop on failure; remaining commands are
`not_run`. Summaries show exit codes and elapsed times. Exit `0` means selected
commands passed, `1` means a prerequisite or test failure, and `2` means an
invalid command, map, or selection. Interruptions return a nonzero status.
Skipped cases remain visible in native output and do not establish exercised
behavior.

Report focused results separately from completion gates. Focused execution
does not enforce coverage and cannot satisfy the completion requirement by
itself. Run `./tests/run-all.sh --unit` and verify at least 90% `vdl.py` line
coverage, using Python 3.12 for CI parity. Keep the existing broader CI/release
checks. Rerun affected checks after implementation changes following a passed
gate; an explanation-only edit does not require repeating a gate.

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

Entry-removal recovery has protocol, authorization, coordinator, and real-UI
checks. Use Python 3.12 for parity with the coverage gate in CI:

```bash
python -m unittest tests.test_entry_removal tests.test_entry_removal_security -v
node --test tests/removal-client.test.cjs
python3 tests/browser/run.py entry-removal-feedback.spec.cjs
VDL_TEST_BROWSER=firefox python3 tests/browser/run.py entry-removal-feedback.spec.cjs
```

These checks inject crashes at ownership and publication boundaries, preserve
replacement files, and hold real requests to verify pending presentation and
canonical confirmation. The [Feature 0051 rollout](../ARCHITECTURE/feature-0051-rollout.md)
records the completion evidence; focused checks do not replace the full unit
coverage gate.

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

Playlist editor saves and quick-add/delete share one integer revision and
receipt boundary. Their browser checks hold actual requests and committed
responses to verify immediate status, direct canonical confirmation, explicit
conflict review, frozen-attempt recovery, and deletion/authentication fences:

```bash
VDL_PYTHON=/path/to/python3.12 ./tests/run-all.sh --unit
VDL_PYTHON=/path/to/python3.12 node --test tests/*.test.cjs
VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py playlists-actions-feedback.spec.cjs playlists-feedback.spec.cjs playlists.spec.cjs
VDL_TEST_BROWSER=firefox VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py playlists-actions-feedback.spec.cjs playlists-feedback.spec.cjs playlists.spec.cjs
```

Run the coverage gate separately from browser work so instrumentation of the
large asset-queue regression has its normal execution budget. Deletion receipts
recover the removed identity without returning its former private contents;
they do not establish deletion of videos or media files.

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
