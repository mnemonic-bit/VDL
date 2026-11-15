# Focused test selection by functional area

**Source:** User-requested development workflow\
**Status:** Implemented and verified\
**Last refined:** 2026-11-14\
**Baseline:** Commit `2469109`, application version `0.66.0`\
**Inputs:** [Repository instructions](../AGENTS.md), [test commands and constraints](../tests/README.md), [tier runner](../tests/run-all.sh), [coverage gate](../tests/coverage_gate.py), [validation workflow](../.github/workflows/validation.yml)

## Decision summary

Preserve test-selection knowledge in a version-controlled test-area map. Add a
small runner that executes the mapped tests through the existing test tools.
Require development agents to consult the map, apply documented expansion rules
for shared changes, and maintain the map alongside implementation changes.

The outcome is a repeatable development loop: identify the changed behavior,
select its relevant tests, rerun the failing regression during editing, and run
the selected area before the existing completion gates. An agent should not
have to rediscover test ownership and shared dependencies for every task.

The map describes a reviewed relevant set at test-file granularity. It does not
prove that the set is mathematically minimal or sufficient for every possible
change. Final validation remains independent of focused selection.

## Goals and boundaries

### Required outcomes

- Select tests by stable functional area, independently of directory layout.
- Select one layer when iterating on a backend, client, or browser change.
- Preserve known cross-area consequences of changes to shared code.
- Explain every selected test and every dependency expansion.
- Detect missing mappings and stale test references before they silently narrow
  validation.
- Make the same commands available to developers, agents, and CI.
- Avoid full-suite discovery, application startup, coverage instrumentation,
  dependency installation, and unrelated test execution during selection.

### Outside this feature

- Moving existing tests into functional folders.
- Replacing unittest, Node's test runner, Playwright, or container checks.
- Automatic impact inference from Git diffs, changed line ranges, call graphs,
  execution traces, or historical coverage.
- Persistent watch processes, result caching, automatic retries, or a new service.
- Selecting individual Node or Playwright cases by title. A developer can use
  the native runner for a single failing case after selecting its file.
- Removing or reducing existing CI/release checks or the 90% coverage threshold.
- A mandatory skill, custom agent, or agent delegation step. A future skill may
  call the runner and read the map; it must not duplicate test membership.

## Observed baseline

At the baseline revision, `tests/` contains 64 top-level Python test files and
18 top-level Node test files. `tests/browser/` contains 54 browser spec files.
`tests/integration/` contains one Python real-media module. These are file
counts, not test-case counts or performance measurements.

Existing focused commands already accept selected modules or files:

```bash
python -m unittest tests.test_rename tests.test_rename_mutations -v
node --test tests/rename-client.test.cjs
python3 tests/browser/run.py rename-feedback.spec.cjs
```

`tests/run-all.sh --unit` runs the Python coverage gate; the validation workflow
runs Node tests separately. `--all` runs the existing unit, browser, media, and
container tiers. Preserve these meanings and the separate Node validation step.

Functional areas span `vdl.py` and `static/app.js`; other shared implementation
files include `static/client-state.js`, `static/mutations.js`, `asset_generation.py`,
`preview_maintenance.py`, and `download_bandwidth.py`. A changed source filename
alone cannot determine the appropriate focused tests.

## Required artifacts and authority

| Artifact | Responsibility |
| --- | --- |
| `tests/areas.json` | Authoritative executable test membership, area descriptions, source hints, and expansion rules. |
| `tests/run-area.py` | Validate selections, construct an explainable plan, and invoke existing tools. Use only the Python standard library for selection and validation. |
| `tests/test_area_runner.py` | Test selection semantics, maintenance checks, and execution boundaries without starting the application or real browsers/containers. |
| `tests/README.md` | Explain the commands, layer names, development loop, prerequisite setup, and completion boundary. Link to the map instead of copying its inventory. |
| Root `AGENTS.md` | Require the selection workflow and map maintenance; retain the existing coverage requirement. |
| `.github/workflows/validation.yml` | Run map validation and retain every existing validation/release gate. |

The JSON map owns test membership. The runner owns command construction and
execution adapters. Agent instructions own the requirement to use the workflow.
Documentation explains these interfaces without maintaining another test list.

Implement the feature without adding runtime or development dependencies.
Existing test dependencies remain prerequisites for their selected layers.

## Terms and map contract

An **area** is a named behavior, such as `rename`, or a shared implementation
contract, such as `mutation-core`. An **expansion** is a directed rule that adds
another area when the source area is selected. A **layer** identifies the tool
and execution requirements. A **selector** identifies an existing test file or
one of the fixed container checks. A **plan** is the expanded, filtered,
deduplicated selection and its commands and reasons.

### JSON schema, version 1

The root object contains exactly `schema_version` and `areas`.
`schema_version` is integer `1`; reject unsupported versions and unknown keys.
`areas` is a nonempty object keyed by area ID. IDs match
`[a-z][a-z0-9]*(?:-[a-z0-9]+)*` and are unique. Reject duplicate JSON object keys
rather than accepting the parser's last value.

Every area has exactly these fields:

| Field | Contract |
| --- | --- |
| `summary` | Nonempty string identifying the protected behavior. |
| `source_hints` | List of objects with `path` and `scope`, both nonempty strings. `path` names an existing repository file; `scope` names relevant symbols, routes, or behavioral boundaries. Hints guide human/agent selection; they are not an automatic impact classifier. |
| `tests` | Object containing exactly the five layer keys defined below. Each value is a list of unique selector strings; an unused layer is `[]`. |
| `expands_to` | List of objects with `area` and `reason`, both nonempty strings. Each target exists and appears at most once per source area. |

An area has at least one source hint and at least one direct selector or
expansion. The complete expansion graph is acyclic; reject self-edges and cycles
with the offending area path. Use explicit lists, not glob patterns, shell
commands, expressions, or automatically inferred membership.

| Layer | Selector and execution meaning |
| --- | --- |
| `python` | Repository-relative `test_*.py` file paths under `tests/`, outside `tests/integration/` and excluded support/generated/dependency directories. Execute the corresponding unittest modules without coverage instrumentation. |
| `node` | Repository-relative `*.test.cjs` paths under `tests/`, outside excluded support/generated/dependency directories. Includes client logic and workflow/tooling regressions. |
| `browser` | Repository-relative `*.spec.cjs` paths under `tests/browser/`, outside excluded support/generated/dependency directories. Execute through the existing browser fixture runner. |
| `media` | Repository-relative `test_*.py` file paths under `tests/integration/`. Execute with the existing mandatory media-tool flags. |
| `container` | Fixed check IDs: `smoke`, `preview-maintenance`, `companion-states`, and `dependency-lock`. Command construction is defined by the runner, never executable text in the map. |

Paths are normalized repository-relative POSIX paths. Reject absolute paths,
traversal components, unexpected suffixes, and paths resolving outside the
repository. A selector must resolve to an existing regular file of its declared
layer. Python test paths must have an unambiguous importable unittest module
name. Allow the same selector in several areas; deduplicate at planning time.

`source_hints.scope` is reviewed prose. Structural validation verifies the
hint's file, but cannot prove that a symbol name or dependency description is
current. Implementation and review must maintain that semantic information.

### Example area

This complete area illustrates the schema. The implementation must populate
the remaining inventory rather than shipping only this example.

```json
{
    "schema_version": 1,
    "areas": {
        "rename": {
            "summary": "Rename validation, canonical identity, filesystem recovery, and UI feedback.",
            "source_hints": [
                {"path": "vdl.py", "scope": "_execute_rename_mutation and rename recovery helpers"},
                {"path": "static/app.js", "scope": "Inline rename editor and mutation feedback"},
                {"path": "static/mutations.js", "scope": "Rename-specific admission and response handling"}
            ],
            "tests": {
                "python": ["tests/test_rename.py", "tests/test_rename_mutations.py"],
                "node": ["tests/rename-client.test.cjs"],
                "browser": ["tests/browser/rename-feedback.spec.cjs"],
                "media": [],
                "container": []
            },
            "expands_to": []
        }
    }
}
```

## Initial area inventory

Use the following behaviors as separate selectable areas. Broad areas such as
all Library metadata are too coarse for the primary development loop.

| Area IDs | Required coverage in the initial map |
| --- | --- |
| `download-submissions`, `download-commands`, `download-lifecycle`, `download-formats`, `download-concurrency`, `download-bandwidth`, `download-recovery` | Request admission, form/options feedback, pause/stop/resume/retry, lifecycle, format selection and PO-token configuration, queues, shared bandwidth, cancelled cleanup and worker/network recovery. |
| `uploads`, `ingest` | Upload registration/transfer/publication/security/recovery, browser drop flows, and folder import. |
| `history`, `duplicates`, `duration-filter` | Attempt history, library queries/pagination, search, duplicate indexing, and duration selection across library and playback. |
| `tags`, `favorites`, `rename`, `visibility` | Each area's protocol, authorization, identity, client adapter, and browser feedback. Tag identity parity belongs to `tags`; shared use is recorded separately. |
| `entry-removal`, `bulk-clear` | Removal/bulk-clear execution, audit, file ownership, authorization, client recovery, and browser feedback. |
| `playlists` | Personal playlists, editor saves, quick-add/delete, queue playback, and progress. |
| `playback`, `crossfade`, `shuffle-clips`, `skip-video-edges` | Playback sessions/metadata, player controls and fullscreen, crossfade, clip continuity, and intro/outro skipping. Shared playback files may belong to several areas. |
| `library-rotation`, `library-storage` | Rotation membership/access/playback and persisted authorized storage measurement/footer behavior. |
| `asset-queue`, `thumbnails`, `hover-previews`, `preview-maintenance` | Scheduling/demand, image publication, hover playback/leases, cache inventory/retirement, maintenance API/queue, and system logs. |
| `preferences`, `settings-ui` | Preference validation/protocol/client feedback and settings/theme/navigation behavior. |
| `extension-pairing`, `extension-companion`, `extension-release` | Pairing lifecycle, companion integration and browser gestures, package validation and signing/publication workflow. |
| `authentication`, `request-security`, `live-refresh`, `database`, `startup-version` | Login/session/users, cross-origin mutation protection, SSE/reconciliation, contention/migration, startup/shutdown, version/uptime behavior. |
| `workflow-validation`, `test-tooling` | CodeQL pins, validation ordering, and the new map/runner regressions. |
| `mutation-core`, `client-state-core`, `file-ownership`, `playback-core`, `asset-protocol`, `test-support` | Shared-change profiles with the directed expansion rules below. |
| `container-runtime`, `container-dependencies` | Existing container smoke/recovery/package checks and the dependency-lock check. |

Every test file in the observed inventory must be represented. Multi-area files
receive multiple memberships when they establish more than one area's contract.
For example, `test_duration_filter.py` protects playback selection as well as
library filtering, and `history-actions.spec.cjs` spans several UI actions.
Inspect each file's cases when seeding membership; filename similarity alone is
not sufficient evidence.

Assign `tests/integration/test_real_media.py` to the affected download, playback,
rename/removal, and preview areas in the `media` layer. V1 deliberately runs the
whole selected file. Document the resulting breadth; do not claim that selecting
one area runs only individual cases within a multi-area file.

Assign each fixed container check to the corresponding runtime, preview,
extension-release, or dependency area. The implementation's map is the ongoing
inventory; this section describes the bootstrap requirement, not a second map
to keep synchronized after implementation.

## Directed expansion and change classification

Select leaf areas for changes confined to their behavior. Select shared areas
when a change alters the shared contract described by their source hints.
Selecting a consumer must not implicitly select all other consumers merely
because they share a source file or import a common helper.

The initial map must encode at least these shared consequences, using explicit
`expands_to` edges and reasons:

| Changed contract | Required expansion |
| --- | --- |
| `mutation-core`: common admission, fingerprinting, receipts, replay, revision interpretation, quotas, or queue ordering | Every implemented mutation adapter: tags, favorites, rename, preferences, playlists, download commands/submissions, uploads, entry removal, bulk clear, visibility, and extension pairing. Include shared coordinator tests directly. |
| `client-state-core`: common canonical merging, projection, reset, or stale-response fencing | Mutation consumers, live refresh, and other current state-store consumers found during implementation. Include their affected browser checks. |
| `authentication`: shared session identity, authorization predicates, account reset, or authentication-epoch behavior | Visibility, pairing/companion, private library/history, playlists/playback, uploads, removal, bulk clear, and other current authorization consumers. |
| `database`: shared connection/write-lock/migration/transaction behavior | All current database consumers. Schema changes confined to one feature may select that feature plus migration tests; changing the shared database contract requires the broad profile. |
| `file-ownership`: common stored-path, alias, inode, retirement, or publication authority | Rename, removal, bulk clear, uploads/ingest, playback, previews, and storage. |
| `playback-core`: shared session stepping, loading, seek, player lifecycle, or handoff | Playback, crossfade, shuffle clips, skip edges, playlists, rotation, and duration filtering. |
| `asset-protocol`: shared readiness, demand revisions, publication, leases, or cache identity | Asset queue, thumbnails, hover previews, preview maintenance, and UI consumers retaining those assets during refresh. |
| `test-support`: shared AppCase, fake downloader, fixture server, fixture app, or browser support changes | Every current consumer of the changed support contract; the profile may conservatively contain the entire affected layer when narrower membership is not established. |

These are minimum relationships. Seeding the map must include additional
dependencies found in the actual implementation. Add edge reasons that identify
the shared contract, rather than saying only "related tests".

Edges are directional: `mutation-core -> rename` does not imply
`rename -> mutation-core`. Leaf areas can list shared regression files directly
without adding an edge to a profile that expands to all consumers.

When selecting tests, the developer or agent must classify every changed
behavior and every changed shared contract. Source hints help that decision;
V1 does not perform it automatically. If impact remains uncertain, state the
uncertainty and broaden selection explicitly, up to all areas in the affected
layers. An empty selection is never evidence that a code change needs no tests.

## Command-line contract

The runner provides the following interfaces.

```bash
# Discover areas without importing or running tests.
python3 tests/run-area.py --list

# Preview default layers, commands, expansion chains, and omissions.
python3 tests/run-area.py rename --dry-run

# Iterate on one layer; repeated areas/layers form a union.
python3 tests/run-area.py rename --layer python
python3 tests/run-area.py rename --layer node
python3 tests/run-area.py rename entry-removal --layer browser

# Obtain a machine-readable plan without executing it.
python3 tests/run-area.py mutation-core --layer node --dry-run --json

# Broaden explicitly when a shared impact cannot be bounded.
python3 tests/run-area.py --all-areas --layer python --layer node

# Validate the complete map and test ownership inventory without execution.
python3 tests/run-area.py --check
```

- Positional area IDs select one or more areas. Repeated IDs are deduplicated.
- `--all-areas` selects all areas and is mutually exclusive with positional IDs.
- Omitting `--layer` selects exactly `python` and `node`, in that order. It does
  not select browsers, real-media integration, or container checks.
- Repeated `--layer` values select exactly the named layers. Explicit layers
  replace the default pair. Canonical order is `python`, `node`, `browser`,
  `media`, `container`, regardless of argument order.
- `--list` and `--check` accept no area/layer selection and execute no tests.
- `--dry-run` requires a selection and executes no tests. `--json` is valid only
  with `--dry-run`; it emits one JSON plan to stdout, with diagnostics on stderr.
- Reject incompatible flags, unknown IDs/layers, malformed maps, and an empty
  resulting plan with exit code `2` before starting a test process.
- If an explicitly requested layer has no selectors across the expanded area
  union, reject the request with exit code `2`; name the empty layer. An empty
  default layer is permitted when the other default layer has selectors.
- All execution plans explain selection by default. There is no separate flag
  that an agent must remember to obtain dependency reasons.

## Planning algorithm and output

The runner must apply this order:

1. Locate the repository relative to the runner, independently of the caller's
   working directory. Parse the command and map.
2. Validate the complete schema, IDs, and expansion graph. Validate selected
   source/test paths before execution. Full ownership scanning belongs to
   `--check`, not every focused invocation.
3. Compute the transitive closure of selected areas, retaining every direct
   selection and expansion reason. Do not traverse edges in reverse.
4. Take the union of selectors in that closure. Apply the requested layer filter
   after expansion. Deduplicate by `(layer, selector)` and sort selectors.
5. Reject invalid or empty selections. Construct argument arrays and prerequisite
   requirements for every selected layer before starting any test process.
6. Print the plan. For execution, preflight all selected layers, then execute
   them in canonical order and report their results.

The human-readable plan must identify:

- Requested areas, expanded areas, edge reasons, and requested/default layers.
- Every selected selector, all owning selected areas, and why those areas entered
  the plan. A shared file appears once, with all relevant reasons preserved.
- Exact command arguments and working directories, relevant interpreter/browser
  choices, and required environment changes. Never print unrelated environment
  values or credentials.
- Selector counts per layer. Label these as file/check counts, not test counts.
- Available but omitted layers, including omitted media/container checks.
- The statement that focused results do not satisfy completion gates by themselves.

The JSON plan uses `schema_version: 1` and contains `requested_areas`,
`expanded_areas`, `expansions`, `layers`, `selectors`, `commands`, and
`omitted_layers`. Each selector records `layer`, `selector`, and owning areas;
each expansion records `from`, `to`, and `reason`; each command records `argv`,
repository-relative `cwd`, and only the runner's explicit environment overrides.
Sort all unordered collections. Equivalent input orders produce the same plan
in the same environment. A dry run reports intended commands without requiring
installed test dependencies or claiming those prerequisites are available.

## Execution and prerequisite behavior

Use `subprocess` argument arrays without shell evaluation. Run commands from the
repository root except where the existing browser runner establishes its own
working directory. Preserve test isolation, fixture cleanup, timeouts, and
browser failure artifacts.

| Layer | Required adapter behavior |
| --- | --- |
| `python` | Convert selected paths to module names; invoke one selected Python process with `-m unittest <modules...> -v`. Use `VDL_PYTHON` if set, otherwise the interpreter running `run-area.py`. Do not invoke `coverage_gate.py` or unittest discovery. |
| `node` | Invoke one `node --test <exact paths...>` process. Preserve `VDL_PYTHON` for Python-backed parity tests. If unset, pass the selected Python interpreter as `VDL_PYTHON` so parity uses the same environment. |
| `browser` | Invoke the selected Python interpreter on `tests/browser/run.py` once with only selected spec paths relative to its test directory. Set `VDL_PYTHON` to the selected interpreter so the fixture uses that environment too. Preserve `VDL_TEST_BROWSER` and `PLAYWRIGHT_CLI`. Test selectors must be anchored/escaped for Playwright's regex file matching so another filename cannot match accidentally. |
| `media` | Invoke selected unittest modules once with `VDL_RUN_MEDIA=1` and `VDL_REQUIRE_MEDIA_TOOLS=1`. Require ffmpeg/ffprobe and retain generated local-media behavior. |
| `container` | Execute each selected fixed check once in stable ID order, using the adapters below. Respect existing `CONTAINER_ENGINE` and `VDL_IMAGE` settings. |

Fixed container adapters are: `smoke` runs `tests/container/smoke.sh --build`;
`preview-maintenance` runs `tests/container/check-preview-maintenance.py --image
<VDL_IMAGE or vdl:local>`; `companion-states` runs
`tests/container/check-companion-states.py`; `dependency-lock` runs
`tests/container/check-lock.sh`. Use the selected Python for Python scripts.
Retain each script's own checks and engine handling.

`preview-maintenance` requires an image built from the current sources, as the
existing check documents. The runner must expose that prerequisite and must not
claim image freshness from the tag alone. Container selection does not broaden
to every container check. The dependency-lock check contacts the package index;
mark that network requirement in its plan.

Preflight checks the selected layers' documented baseline prerequisites: the
Python interpreter and application packages for Python/app-fixture/parity work;
Node and the root tooling dependencies for Node work; Playwright and the selected
installed browser for browser work; ffmpeg/ffprobe for media work; and the tools
required by each selected container script. Do not import `vdl` or test modules
as a prerequisite probe. Report actionable setup guidance and stop before tests
run if a known prerequisite is missing. Preflight does not promise exhaustive
static dependency inference or continued tool availability; additional import
errors and runtime failures still fail the run visibly.

Focused Python, Node, and browser execution requires native prerequisites. The
focused runner must not install packages, download browsers, select a container
fallback, or pull/build an image for those layers. In particular, require native
app packages before calling the browser fixture runner, so its standalone
container fallback is not entered. Explicit container checks may perform their
existing documented builds/network work. Preserve the standalone tier runners'
fallback behavior; a developer can invoke those runners explicitly when native
setup is unavailable.

Run selected layers sequentially. Stop after a failed layer by default, marking
remaining layers `not_run`; the developer can rerun another layer explicitly.
An interrupted run terminates its active child using the existing runner cleanup
semantics and reports interruption with a nonzero exit code.

Return `0` only when all selected commands exit successfully. Return `1` for
test failures or missing/runtime prerequisites; reserve `2` for command/map/
selection errors. Preserve interruption as nonzero. Use `passed`, `failed`,
`not_run`, and `inconclusive` in the result summary, with command exit codes and
elapsed times. A successful command containing skipped tests is reported as a
successful runner result with its skips visible; it is not evidence that skipped
behavior was exercised. Existing expected-failure semantics remain unchanged.

## Maintenance checks and CI integration

`--check` performs structural and inventory validation without importing test or
application modules, starting fixtures, contacting the network, or requiring
Flask, Node, Playwright, ffmpeg, or a container engine.

It must reject:

1. Schema/type/duplicate-key errors, unknown layer keys, invalid IDs, and cycles.
2. Missing/outside-repository source hints or selected test paths, incorrect
   layer placement, and unknown fixed check IDs.
3. Any unmapped Python test file, Node test file, or browser spec in the
   repository's permanent `tests/` tree. Exclude dependency directories,
   generated output, fixtures, and support files by explicit discovery rules;
   do not exclude a directory merely because its test files are unmapped.
4. Any fixed container check with no area membership.

New nested test files must be detected by validation, even before the existing
native discovery configuration is updated to execute them. Map validation checks
ownership, not whether unittest/Playwright discovery already reaches a file.
The feature's own regression file must belong to `test-tooling`.

Every new or moved test receives map updates in the same change. Changes to
shared contracts update source hints, expansion edges, and representative
selection regressions in the same change. Removing a test removes its selectors.
Multiple memberships are permitted; orphan tests and dangling references fail.
Avoid an automatic catch-all assignment that would hide missing review.

Add `python tests/run-area.py --check` to the validation workflow after Python
setup and before expensive test setup. Keep the existing full Python coverage,
Node, browser, media, container, dependency-lock, and extension validation steps.
Focused selection is an additional development interface, not a CI filter.

Structural validation cannot detect a missing semantic dependency between two
otherwise valid areas. Review and selection-regression cases establish known
edges; the full validation gates remain the independent check for missed impact.

## Required agent workflow

Update root `AGENTS.md` during implementation with a short mandatory pointer to
`tests/README.md` and `tests/areas.json`. Do not add the complete inventory to
always-loaded instructions. The instruction must establish this sequence:

1. Before code changes, identify affected leaf areas and changed shared contracts
   using the map's summaries/source hints. Record the selection and any impact
   uncertainty in the task's progress update.
2. Preview the expanded plan once. If impact is uncertain, broaden explicitly.
   Do not silently omit a changed contract because a narrower command is faster.
3. During editing, run the relevant failing regression through its native tool,
   or run the selected area/layer. Repeat only tests affected by subsequent edits
   or tests whose failures/uncertainties remain unresolved.
4. After the change stabilizes, run the union of affected areas and relevant
   layers. Browser-visible behavior requires the relevant browser checks;
   decoding/merge behavior requires the relevant media checks; deployment or
   dependency changes require their corresponding checks. Defaults alone are
   not a decision that the other layers are irrelevant.
5. Maintain mappings and expansion rules with the change. Run `--check` after map,
   test-inventory, or shared-dependency changes.
6. Run completion gates and report their actual outcomes separately from focused
   results. Do not claim full validation from a focused run or an omitted layer.

If a new behavior has no suitable area, add an area and its regression membership
before relying on focused selection. If the runner/map is unavailable or invalid,
report that condition and use explicit native test commands or the broader
existing gates; an invalid selection is not a successful check.

## Completion gates

Preserve the requirement to run `./tests/run-all.sh --unit` and verify at least
90% `vdl.py` line coverage before completing a feature or bug fix. Use Python
3.12 for CI parity, especially near the threshold. Focused runs neither enforce
that threshold on a subset nor reuse a partial result as the full gate.

When implementation code changes after a gate passed, rerun the checks affected
by those changes and obtain the required completion evidence for the final code.
Do not rerun a gate merely because another agent-facing explanation was written.
The existing broader CI/release requirements remain in force.

Writing this proposed spec is documentation-only and leaves `VERSION` unchanged.
Implementing the runner is a feature: increment MINOR and reset PATCH once for
that implementation change, following repository versioning instructions.

## Acceptance criteria

Each criterion requires recorded evidence. Use synthetic fixture maps and fake
subprocesses for selection/adapter regression tests; do not start real browsers
or containers merely to test planning.

| ID | Observable acceptance result | Verification |
| --- | --- | --- |
| AC-01 | All baseline test files, new runner tests, and fixed container checks have valid area membership. | Run `--check`; compare inventory totals with filesystem discovery and inspect representative multi-area memberships. |
| AC-02 | `rename --layer python` selects exactly `test_rename.py` and `test_rename_mutations.py`; the Node and browser variants select exactly their rename client/spec files. | Assert exact plans and argv, then run the three focused commands with installed dependencies. |
| AC-03 | Selecting `rename` does not expand to other mutation adapters. Selecting `mutation-core` includes every implemented mutation adapter and shared coordinator checks. | Assert both selections, exact reason chains, and absence of reverse expansion. |
| AC-04 | Shared authentication, database, file-ownership, playback, asset, and test-support profiles include their documented consumers. | Add one explicit expected-set regression per shared profile; review expectations against current implementations rather than generating expectations from the same map. |
| AC-05 | Transitive and overlapping expansions produce one execution per selector with all reasons; input ordering does not change a plan. | Test chain/diamond graphs, repeated arguments, multi-area files, and reordered inputs. Reject cycles/self-edges. |
| AC-06 | Default selection contains only Python/Node. Explicit layers replace defaults; empty explicit layers and wholly empty plans fail before execution. | Test defaults, union filtering after expansion, unknown/empty selections, and omitted-layer reporting with zero subprocess launches on errors. |
| AC-07 | Invalid versions, duplicate JSON keys, malformed fields, missing references, traversal, and wrong-layer paths fail with useful diagnostics and exit `2`. | Mutate fixture maps for each invalid condition; assert no test process starts. |
| AC-08 | New unassigned tests, deleted/moved selectors, and orphan fixed checks fail `--check`, including new nested test directories. | Add/remove/rename fixture inventory entries and verify failures; ensure support/generated/dependency files are excluded. |
| AC-09 | Listing, planning, and validation work without test dependencies and have no application/fixture/network side effects. | Run in a clean stdlib-only Python environment; spy on imports/process/network entry points and inspect filesystem changes. |
| AC-10 | Python/Node/browser adapters invoke only selected files, batch each layer once, use the declared interpreter/environment, and match browser filenames exactly. | Capture subprocess calls; include browser filenames with regex metacharacters, a repository path containing spaces, and a similar unselected browser filename. Python module path components remain valid identifiers. |
| AC-11 | Missing prerequisites fail visibly before test execution, without installation or an undisclosed fallback. Failures/interruption remain nonzero; later layers are `not_run`. | Inject missing tools/packages and child failures; verify preflight, cleanup, result summaries, and exit codes. |
| AC-12 | Media flags and all fixed container argv match the adapter contract; expensive checks require explicit layer selection. | Use fake subprocesses for all adapters; execute relevant existing media/container checks when their adapters or fixture plumbing change. |
| AC-13 | A fresh agent can discover the workflow from root instructions, select rename without scanning test files, and explain a shared-coordinator expansion. | Start a clean session/task and record the map lookup, dry-run plan, selected commands, and expansion explanation. No custom agent or manually invoked skill is required. |
| AC-14 | Selection overhead remains small and focused runs avoid unrelated discovery/coverage work. | Measure `rename --dry-run` five times on a documented warmed Python 3.12 CI/developer environment; median elapsed time is at most 2 seconds. Verify no unittest/Node/Playwright discovery process or coverage instrumentation occurs during planning. |
| AC-15 | Actual development-loop savings and remaining breadth are visible. | Record selected file counts and elapsed time for rename Python/Node/browser separately; compare Python/Node focused execution with their full counterparts on the same environment. Record setup separately. Report observed timings without inventing a required speedup ratio or claiming file-level selection isolates individual cases. |
| AC-16 | Existing commands and release protection remain operational on the final implementation. | Run `--check`, runner regressions, focused adapter smoke checks, full Node tests, and `./tests/run-all.sh --unit` with recorded 90%+ coverage. Confirm the full validation workflow retains its existing checks; run further browser/media/container checks when changed integration paths require them. |

## Delivery order and verification status

Implement in this order: seed/review the map, add planner/validator regressions,
add execution adapters, add CI validation and documentation pointers, then run
focused and completion checks. Keep the existing suite usable throughout; do not
combine this feature with test-folder migration or application refactoring.

The feature is complete only when AC-01 through AC-16 have passed with recorded
commands/results and any platform-dependent checks are identified accurately.
If a required check is unavailable, report `not_run` or `inconclusive` with its
cause; do not mark the feature implemented.

## Implementation verification

Verification date: 2026-11-14. Environment: Linux amd64, Python 3.12.14,
Node 22.23.5, global Playwright with Chromium, and Podman 4.3.1. The implementation
increments the application version from `0.66.0` to `0.67.0`.

Native setup used an isolated `/tmp/vdl-feature68-venv` environment with
`requirements.txt` installed through uv. Root Node tooling, global Playwright,
Chromium, ffmpeg, and ffprobe were already available. Setup is separate from the
timings below. Final Python/Node comparisons and the coverage gate set
`TMPDIR=/tmp/vdl-feature68-tmpfs`, an isolated executable tmpfs, because the
workspace filesystem spent most of the large queue test waiting on filesystem
I/O. An initial `/dev/shm` setup could not execute a temporary shell fixture
because that filesystem uses `noexec`; the full Node rerun exposed that setup
failure. Tests and application code were unchanged to address either setup
condition. The container smoke check built `localhost/vdl:feature68` from
the current sources before preview-maintenance used that image. Companion-state
checks built their own signed/unsigned fixture images. No application runtime
files or standalone tier-runner fallback behavior changed.

Commands below use `VDL_PYTHON=/tmp/vdl-feature68-venv/bin/python` unless the
selection check deliberately disables installed packages. Container commands use
`CONTAINER_ENGINE=podman`.

| Criteria | Result | Evidence |
| --- | --- | --- |
| AC-01 | passed | `python3.12 tests/run-area.py --check`: 49 areas own 65 Python files, 18 Node files, 54 browser specs, one media file, and four fixed container checks. Repository-inventory regression confirms no orphans. |
| AC-02 | passed | Exact rename plan/argv regression plus real `rename --layer python`, `rename --layer node`, and `rename --layer browser` execution: 31, 18, and 19 cases passed respectively. |
| AC-03 | passed | Rename has no expansion; mutation-core regression requires all 12 adapters and coordinator membership. Fresh-agent Node plan contained 13 deduplicated files. |
| AC-04 | passed | `test_shared_profiles_preserve_reviewed_consumer_sets` asserts independently written consumer sets for authentication, database, file ownership, playback, assets, client state, and test support. Membership review also checked multi-area history, duration, media, and UI files. |
| AC-05 | passed | Chain/diamond selection regressions preserve all directed edge reasons and owners, deduplicate files and repeated inputs, and reject self-edges/cycles. |
| AC-06 | passed | Selection regressions verify default Python/Node, explicit layer replacement, union filtering, empty selections/layers, omissions, and zero launches on invalid requests. |
| AC-07 | passed | Schema, version, duplicate-key, malformed-field, missing-reference, traversal, symlink, Python-module ambiguity, and wrong-layer regression cases return selection errors before launching tests. |
| AC-08 | passed | Inventory regressions add nested orphan Python/Node/browser/media files, remove/move mapped files, and orphan fixed checks. Explicit support/dependency/generated exclusions retain detection of new functional directories. |
| AC-09 | passed | Isolated CLI regression runs `--list`, `--check`, and rename JSON planning under Python `-I -S -B`, empty PATH, and an unrelated working directory. Import/process/network spies protect planning boundaries. |
| AC-10 | passed | Adapter regressions capture exact batched argv/environment, a repository path containing spaces, regex metacharacters, and similar unselected browser names. Real Python/Node/browser smoke checks ran only selected files. Browser argv uses escaped absolute anchored regexes because relative suffix matching could select a same-named nested file. |
| AC-11 | passed | Mocked prerequisite/runtime failures stop execution and mark later commands `not_run`. Independent native synthetic reproduction confirmed that an interrupt removes a SIGINT-ignoring descendant after its parent exits. Cleanup regression protects signal escalation after leader exit. |
| AC-12 | passed | Exact media flags and all fixed container argv are asserted. Real nine-case media module, shipping smoke, preview-maintenance, companion-states, and dependency-lock checks passed. |
| AC-13 | passed | A fresh agent read root instructions, followed README/map pointers, and selected rename without scanning tests. The agent ran rename dry-run and mutation-core Node JSON planning and explained directional expansion through admission/fingerprints/receipts/revisions/quotas/ordering. |
| AC-14 | passed | Five warmed Python 3.12.14 `-I -S -B` rename dry runs took 0.0884, 0.0776, 0.0853, 0.0831, and 0.0794 seconds; median 0.0831 seconds. Planning uses no discovery subprocess or coverage instrumentation. |
| AC-15 | passed | Sequential Python/Node focused/full comparisons on the same environment are recorded below. Native full Python ran 945 cases with nine deliberate media skips; the separate media run exercised those nine cases. |
| AC-16 | passed | `./tests/run-all.sh --unit` exited 0: 945 cases, nine media skips, and 92.7% `vdl.py` line coverage (7954/8582; required 90%). Map validation, 45 runner regressions, focused adapter checks, 307-case full Node suite, media, and all fixed container checks passed. CI retains every existing check and adds map validation before dependency installation. |

The focused tooling command is
`python3.12 tests/run-area.py test-tooling workflow-validation`. Its Python
command passed 45 runner regressions; its two selected Node files passed.
`node --test tests/*.test.cjs` passed all 307 cases across 18 files in 2.319
seconds, measured with a Python monotonic timer around the command.

| Selection | Selected file count | Observed elapsed time | Result |
| --- | --- | --- | --- |
| Rename Python | 2 of 65 | 8.275 seconds including runner/preflight | passed, 31 cases |
| Rename Node | 1 of 18 | 0.557 seconds including runner/preflight | passed, 18 cases |
| Rename browser | 1 of 54 | 97.007 seconds for the fixture command | passed, 19 cases |
| Rename media | 1 of 1 | 122.099 seconds including runner/preflight | passed, nine cases |
| Full Python native discovery | 65 Python files plus skipped integration cases | 271.917 seconds including process startup | passed, 945 cases with nine media skips |
| Full Python completion gate | 65 Python files plus skipped integration cases | 404.434 seconds including process startup | passed, 945 cases with nine media skips; 92.7% coverage |
| Full Node | 18 of 18 | 2.319 seconds | passed, 307 cases |

Final focused/full Python and Node comparisons run sequentially on the same
interpreter/environment with the same executable tmpfs for temporary fixtures.
Browser/media timings came from earlier smoke checks overlapping other
validation work. These are observed timings; there is no required speedup ratio.
The full Python completion command additionally includes coverage tracing.
Selecting rename media runs the entire multi-area
module, including download, playback, and preview cases. File selection does
not isolate individual cases.

The first standalone rename browser run passed 18 of 19 cases and failed the
existing access-loss receipt-recovery check while waiting for an intercepted
request. The complete focused rerun passed all 19 cases without application or
browser-test changes. Initial coverage attempts were interrupted to separate
the coverage gate from browser/media work, to relocate temporary data from
the slow workspace filesystem, and to validate the final argument-parser
change. Those attempts are not completion evidence.
The final coverage command exited 0 on the final implementation. All AC-01
through AC-16 checks passed on the environment recorded above. The temporary
test filesystem was removed after validation.
