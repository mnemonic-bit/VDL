## 67. [Resolved] Container startup delays previews and logs SQLite registration warnings

**Severity:** Medium — Library preview images are missing or slow to appear
after container startup.

**Status:** Fixed in `0.50.2` on 2026-10-30. Startup starvation is reproduced
and covered deterministically with controlled slow registrations. The original
deployment's complete logs and storage conditions remain unavailable, so this
does not establish that every reported missing image had the same cause.

**Related:** [Bug 0053 — Database locks fail authenticated API requests](bug-0053-database-locks-fail-authenticated-api-requests.md)
and [Bug 0054 — Live refresh overload stalls the download UI](bug-0054-live-refresh-overload-stalls-download-ui.md).

### Reported behavior

Starting a new container produces two observations:

- All preview icons fail to appear, or appear only very slowly.
- Container console output contains SQLite warnings associated with the
  `vdl-assets` worker and the `register` operation during the commit phase.

The reporter recalled wording approximately like this; this is not a complete
captured log line:

```text
WARNING in vdl: sqlite timestamp=... operation=register thread=<number> thread_name=vdl-assets phase=commit ...
```

“Preview icons” is interpreted here as the Library's video thumbnail images.
Whether hover-preview montages are also affected has not been confirmed.
The deployed image version/digest, library size, storage layout, warning
frequency, full timing/result fields, and eventual recovery time are unknown.
The repository version at report creation is `0.50.1`; the deployed version
has not been established.

### Reproduction to confirm

1. Start a replacement container using the affected deployment's existing
   database and media volumes. Record the image version/digest and mounts;
   whether the original occurrence reused persistent state is still unknown.
2. Open the Library immediately after startup. Record the visible video IDs,
   time until their first thumbnails appear, and whether images remain absent.
3. Capture timestamped container logs from startup through the delay,
   including complete `sqlite` lines with `execution_seconds`,
   `commit_seconds`, `result`, and `code`. Correlate these with thumbnail
   request timing/status and asset readiness responses in the browser.
4. Check whether existing thumbnail/montage files survived replacement and
   whether their stored asset records are ready, queued, running, or failed.
   Record concurrent ingestion/download activity and any ffmpeg errors.
5. Compare another restart with unchanged media and already-generated assets
   against a controlled disposable library requiring generation. Include a
   large library and controlled slow commits to test the scheduling lead
   below without deleting production data or caches.

**Reported actual:** Preview images are absent or very slow after startup,
while the container emits the described SQLite warnings.

**Expected:** Valid cached previews remain usable across container
replacement. Missing previews generate progressively, with visible cards
receiving prompt service while background reconciliation continues. Startup
work must not cause prolonged unexplained preview starvation or excessive
database transaction overhead. Diagnostics should retain actionable evidence
of genuinely slow or failed operations.

### Source evidence and investigation leads at report creation

- [`db()`](../vdl.py#L527) emits the reported warning format. It logs when
  SQLite reports busy/locked, or when execution or commit takes at least
  **0.25 seconds**. A warning can therefore describe a successful transaction
  (`result=ok`); it does not by itself establish a database-lock exception.
  `phase=commit` identifies the final phase, but either timing field can
  trigger the warning. Both timings and the result/code are needed.
- [`AssetQueue.start()`](../asset_generation.py#L524) names its single worker
  `vdl-assets`. Its [`_run()` loop](../asset_generation.py#L509) calls
  `reconcile_batch()` before each `step()` that can generate an asset.
- [`reconcile_batch()`](../asset_generation.py#L459) reads up to **100**
  finished entries in row order and calls `register()` for each before
  returning. [`register()`](../asset_generation.py#L130) checks both asset
  kinds and enters a separate database transaction under the shared database
  lock for each eligible entry, including entries with existing records.
  Slow registration commits could therefore delay the next generation step
  by an entire batch, even when visible-card work is waiting. This mechanism
  is a source-based hypothesis, not a measured explanation of the deployment.
- Demand-aware selection exists in
  [`_candidate()`](../asset_generation.py#L295), but runs after reconciliation
  returns. Investigate how much startup time is spent registering versus
  generating, whether visible items have been registered yet, and whether
  ready cached files are served while the scan is in progress.
- Check cache persistence and source identity across container replacement,
  storage latency, and generation failures before attributing all missing
  images to SQLite. The supplied warning fragment proves none of these
  causes, and does not establish data loss or corruption.

### Acceptance criteria and regression coverage

- Reproduce the affected startup scenario and identify whether delay comes
  from registration, generation, cache invalidation, serving, or client retry.
  Explain the full SQLite diagnostic rather than inferring failure from its
  warning level alone.
- Cached thumbnails remain available after replacement with persistent
  state. Necessary regeneration does not repeatedly invalidate valid output
  or reset existing failure/retry budgets.
- Under a large startup backlog and controlled slow database operations,
  visible-card generation makes progress without waiting through an entire
  unrelated registration batch. Keep one generation worker and bounded
  background reconciliation, retries, and resource usage.
- Add deterministic coverage for startup with ready caches, missing assets,
  slow registration, and foreground demand arriving during reconciliation.
  Verify eventual visible images and useful timing/log evidence, not merely
  queue insertion. Preserve diagnostics for genuine contention and slowness;
  suppressing warnings alone does not resolve the reported behavior.

### Resolution

A deterministic worker reproduction creates 120 unrelated unregistered videos,
blocks the first startup registration, and submits demand for a visible video
beyond the current scan. Each registration models a successful 300 ms commit.
Before the fix, the visible thumbnail was generated only after 100 registrations
and 30 simulated seconds. After the fix it is generated after the current
registration, at 300 ms. Both assertions include the generated file's ready
state, rather than stopping at enqueueing.

`AssetQueue.reconcile_batch()` now limits a scan slice to 50 ms of monotonic
time as well as 100 entries. It checks the deadline after each registration;
an individual filesystem or database operation may exceed the slice, but the
worker then runs a generation step before registering another unrelated entry.
The cursor advances only after successful registration, so a transient failure
does not permanently skip that row. There is still one generation worker, and
the existing priority, fairness, retry, and batch bounds remain in place.

`register()` reads each kind's existing records once and deletes obsolete
versions only when present. Previously its unconditional version-pruning
`DELETE` opened a write transaction even when no record needed changing.
Unchanged ready, queued, and exhausted entries now require no write transaction;
their files, task identities, attempts, failures, and retry deadlines survive
reconciliation unchanged. Necessary source and version invalidation still runs.

SQLite diagnostics remain enabled. A controlled successful slow registration
produces `operation=register thread_name=vdl-assets phase=commit`, with
`execution_seconds=0.000 commit_seconds=0.300 result=ok code=None`.
This demonstrates that the warning can describe latency without a failed
commit. Real busy/locked failures retain their diagnostic codes and rollback
behavior. The unavailable production warning cannot be classified further.

Regression coverage includes:

- Foreground demand arriving during a slow startup scan, including a visible
  item that was not registered before startup.
- Time-sliced scan continuation, retrying failed registration, and eventual
  generation of both asset kinds.
- Restart reconciliation preserving cached bytes and exhausted/deferred retry
  budgets without opening write transactions.
- A replacement queue using the same database and media serving both cached
  thumbnails and montages over HTTP while background registration is blocked.
- Missing thumbnails progressing from HTTP 202 to HTTP 200 after generation.
- Successful slow-commit warning fields and the existing contention tests.
- The existing 1,500-video unattended test, which verifies all 3,000 assets
  finish with a maximum of one active generator.

Validation: `./tests/run-all.sh --unit` passes on Python 3.12: 390 tests,
six skipped, with `vdl.py` line coverage of **91.6%** (5,064/5,527;
90% required). The successful slow-registration diagnostic regression was
added while that run was in progress and also passes in its focused invocation.

The original report was documentation-only; the code, version bump, and
regressions above were added during resolution. Replacement-container behavior
on the affected deployment still requires operational confirmation.
