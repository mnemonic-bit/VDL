## 69. [Fixed] URL downloads remain at zero bytes without recovery

**Severity:** High — an accepted download can remain in Current downloads
without transferring media or offering a working recovery action.

**Status:** Fixed in version `0.50.4` on 2026-10-30. The investigation below
records the behavior at commit `62d525c`, version `0.50.3`; its reproduction
command deliberately expects that affected implementation. The affected
service remains unavailable, so the reporter's precise trigger is unconfirmed.

### Resolution

The URL worker now handles preference reads, preparation messages, directory
setup, and format persistence inside its failure boundary. Transient SQLite
busy/locked failures while publishing a terminal outcome retry every 250 ms
between the existing one-second database attempts. The worker retains its
reservation until the original outcome and diagnostic are durable, then closes
resources and releases ownership. A lock that remains held delays completion;
the application does not report a successful recovery before persistence works.

Stop also reconciles already orphaned active URL rows to `cancelled`, enabling
Continue or Remove without a restart. Live workers, reservations, and queued
jobs remain protected, and the existing atomic Continue claim still prevents
duplicate workers.

Both extraction and media instances use a 15-second socket inactivity timeout
and at most two network/extractor/fragment retries. Cancellation checks surround
requests and response reads, so a pending Stop aborts before the next retry or
download phase. Every opened response is closed before ownership is released.
These are transport inactivity bounds, not an overall job deadline: a source
that keeps returning data or a plugin blocked outside yt-dlp's HTTP transport
can take longer. No live worker is detached or allowed to overlap a replacement.

Current downloads shows preparation, source-information, media-wait, and
stopping messages alongside the downloaded byte count. The stopping message is
derived from the cancellation flag in public API responses and pushed by SSE;
it cannot overwrite a concurrently published terminal outcome.

Regressions exercise real enqueue/worker/API boundaries and SQLite write locks,
including locks held across repeated terminal failures for success, cancellation,
and error. Real yt-dlp/local HTTP cases hold response headers, metadata bodies,
and first media reads at Unlimited and 50 Mbps. They check pending cancellation,
resource ownership, rejected premature Continue/Remove, successor admission,
and automatic errors after silent-source timeouts. Tests shorten the socket
interval while exercising the same timeout and cancellation paths. Browser
coverage checks visible stages, zero/partial byte counts, and escaped text.

Validation results are recorded below after the original investigation.

**Related:** [Bug 0060 — Downloads stall or slow after bandwidth controls](bug-0060-downloads-stall-or-slow-after-bandwidth-controls.md),
[Bug 0067 — Container startup delays previews](bug-0067-container-startup-delays-previews-and-logs-sqlite-warnings.md),
[Bug 0053 — Database contention](bug-0053-database-locks-fail-authenticated-api-requests.md),
and [Bug 0054 — Live-refresh overload](bug-0054-live-refresh-overload-stalls-download-ui.md).

### Reported behavior and evidence limits

The reporter still has a download sitting in the Current downloads bar that
does not download any bytes, and asks whether Bug 0067 is related. The report
does not specify the row's exact status/message, elapsed waiting time, source
URL/protocol, deployed version, effective settings, or response to Stop.
Those details were requested during investigation and remain unconfirmed.

There is no running VDL container in this workspace, and the local health
endpoint does not answer. A read-only query of this workspace's database finds
six finished rows, three error rows, and no active rows. These are development
observations, not observations of the affected deployment. No production
download, database, or container was changed.

The displayed lack of progress alone cannot establish actual network silence.
Before its first progress callback, a URL row can have `downloaded_bytes=NULL`;
metadata traffic may already have occurred. For the reproductions below,
the application records no media bytes and creates no media output before
the failing/held boundary.

**Expected:** An eligible job begins transferring, reports a meaningful waiting
or preparation state, or reaches an actionable failure. A worker that has
already exited must not leave an active row permanently behind. Stop and
recovery actions must accurately reflect worker ownership and resource cleanup.

### Investigation loop and competing explanations

The first controlled loop holds `extract_info()` before any progress callback,
starts a second job with one available slot, requests Stop, and inspects the
real scheduler and database. It reproduces a zero-byte preparation row and a
queued successor. The held call is then released so all workers can clean up.

Four falsifiable explanations were considered before further probes:

| Explanation | Distinguishing prediction | Investigation result |
|---|---|---|
| Extraction or network I/O blocks before callbacks | The worker remains alive and owns a slot; releasing the request lets Stop complete | Reproduced with a held local HTTP response and real yt-dlp |
| A database error kills a worker without a terminal update | After contention ends, the row remains active although worker ownership is gone | Reproduced with a real SQLite write-lock timeout |
| Global/per-source limits or paused jobs occupy slots | The affected entry is queued; releasing an occupying job admits it | Reproduced behind the held probe; existing scheduler tests also cover admission and paused occupancy |
| Browser reconciliation is stale while transfer continues | Backend byte counts or output files increase while the UI stays unchanged | Not tested against the affected browser; backend reproductions show that a UI failure is not required |

These explanations are discriminators, not a probability ranking for an
unobserved production incident. The orphaned-row case below is the strongest
confirmed persistent defect.

### Confirmed defect: a setup database timeout leaves a dead active row

The minimal reproduction reserves a worker normally, then holds an independent
SQLite `BEGIN IMMEDIATE` transaction only while that worker tries to persist
its `output_dir`. It uses the application's WAL database and unmodified
one-second busy timeout. The independent connection is a controlled contention
fixture, not evidence of a second production writer.

Observed sequence:

1. The scheduler accepts the job and persists `Preparing download`.
2. The worker's setup update raises `sqlite3.OperationalError: database is locked`
   after approximately one second. No extractor or media transfer is reached.
3. The fixture releases its transaction. Worker cleanup removes the live ID
   and scheduler reservation, but the database row remains `starting` with
   `progress='Preparing download'`, null byte count, and no finish time.
4. After the database is usable again, Stop returns HTTP 200, but the row
   remains `starting`. Continue (`/api/resume/<id>`) returns 409 and Remove
   (`/api/remove/<id>`) returns 409.

Representative captured output, with variable thread identifiers omitted:

```text
operation=db_update_download phase=execution
execution_seconds=1.002 commit_seconds=0.000 result=SQLITE_BUSY code=5
WORKER_EXCEPTION: ['database is locked']
ROW: {'status': 'starting', 'progress': 'Preparing download',
      'downloaded_bytes': None, 'finished_at': None}
LIVE: False SLOT: False
STOP: 200
AFTER_STOP: starting
RESUME: 409
REMOVE: 409
AssertionError: Dead worker leaves zero-byte row active indefinitely
```

This case was reproduced repeatedly on Python 3.11.2 with yt-dlp 2026.08.19,
and again on Python 3.12.14 with yt-dlp 2026.10.26. The contention fixture is
removed before the recovery requests, so continuing lock contention does not
explain their failure.

The relevant source chain is:

- [`_dispatch_worker_queue()`](../vdl.py#L3715) reserves ownership and updates
  the preparation message before starting the thread.
- [`_background_download()`](../vdl.py#L4112) reads preferences and persists
  `output_dir` at line 4134, then reads the row and persists the requested
  format, **before** entering its broad exception handler at line 4225.
  The reproduced update failure escapes that handler.
- [`background_download()`](../vdl.py#L4082) has a `finally` for resource and
  scheduler cleanup, but no outer exception handler that reconciles the
  remaining active row. Publishing `worker-stopped` does not change its status.
- [`stop_download()`](../vdl.py#L5894) sets a cancellation flag for a URL job.
  Its special handling for an absent worker applies only to uploads. There
  is no URL worker left to observe the flag and publish `cancelled`.
- [`resume_download()`](../vdl.py#L5861) requires `cancelled` or `interrupted`.
  [`db_remove_download_if_inactive()`](../vdl.py#L1466) also rejects active
  status even if no worker exists. These guards expose the stale lifecycle
  state; bypassing ownership checks is not a safe general repair.
- [`init_db()`](../vdl.py#L890) converts leftover active rows to `interrupted`
  at process startup. This supplies restart recovery, not runtime recovery.

The minimal trigger is one failed setup update. Other operations outside the
inner handler, and failures while persisting a terminal outcome, merit similar
lifecycle coverage; they were not individually reproduced in this investigation.

### Reproduce the persistent defect without a remote service

Run from the repository root using a Python environment with the application
dependencies installed. This command uses `AppCase` to create a temporary
database and output directory. It deliberately exits with the final assertion
failure on the affected implementation; the application database is untouched.
The patch synchronizes a real SQLite lock with one setup write; it does not
replace SQLite errors with a fabricated exception.

```bash
.venv/bin/python - <<'PY'
import sqlite3
import threading
from unittest import mock
import vdl
from tests.support.app_case import AppCase

case = AppCase()
case.setUp()
failed = threading.Event()
errors = []
original_update = vdl.db_update_download

def contend(download_id, **changes):
    if set(changes) == {'output_dir'}:
        blocker = sqlite3.connect(vdl.DB_PATH)
        blocker.execute('BEGIN IMMEDIATE')
        try:
            return original_update(download_id, **changes)
        finally:
            blocker.rollback()
            blocker.close()
    return original_update(download_id, **changes)

def capture(args):
    errors.append(str(args.exc_value))
    failed.set()

try:
    case.insert('orphan')
    with mock.patch.object(vdl, 'db_update_download', side_effect=contend), \
            mock.patch.object(threading, 'excepthook', side_effect=capture):
        vdl.enqueue_download('https://fixture.invalid/video', 'orphan')
        assert failed.wait(3), 'expected worker database timeout'
    row = vdl.db_get_download('orphan')
    print('WORKER_EXCEPTION:', errors)
    print('ROW:', {k: row[k] for k in
                  ('status', 'progress', 'downloaded_bytes', 'finished_at')})
    print('LIVE:', 'orphan' in vdl._live_worker_ids,
          'SLOT:', 'orphan' in vdl._worker_hosts)
    print('STOP:', case.client.post('/api/stop/orphan').status_code)
    print('AFTER_STOP:', vdl.db_get_download('orphan')['status'])
    print('RESUME:', case.client.post('/api/resume/orphan').status_code)
    print('REMOVE:', case.client.post('/api/remove/orphan').status_code)
    assert row['status'] in vdl.TERMINAL_STATUSES, \
        'Dead worker leaves zero-byte row active indefinitely'
finally:
    case.tearDown()
PY
```

### Separately reproduced: blocked extraction retains a slot

A local `ThreadingHTTPServer` accepts a request from the real yt-dlp generic
extractor, then holds the response headers on an event. The response is a
repository WebM fixture when released. The real `enqueue_download()` and
authenticated Stop endpoint are used, with isolated application state.

At both **0 (Unlimited)** and **50 Mbps**, the row remains `starting` /
`Preparing download`, with null downloaded-byte count and a live reserved
slot, including 500 ms after Stop returns 200. Releasing the response lets
the worker finish cancellation and release its slot. Both rates reproduce
with the two Python/yt-dlp environments listed above.

The initial controlled-extractor loop additionally verifies that a second job
with a global limit of one remains at `Waiting for a download slot` until the
first worker unwinds; it then finishes normally. Unlike the orphaned-row case,
this case retains a real worker and can delay additional jobs.

[`_background_download()`](../vdl.py#L4239) checks cancellation before its
initial probe, then synchronously calls `extract_info(download=False)`.
Transfer progress hooks cannot interrupt that call while it is waiting on
metadata I/O. The media governor is installed on the later download instance,
after the initial probe. Its token checks therefore do not unblock this probe.
The later download call also performs extraction through yt-dlp; a successful
initial probe is not proof that media intake has begun.

The 500 ms observation demonstrates pending cancellation during a held call;
it does not establish an infinite network hang or a specified cancellation
deadline. VDL does not set an overall extraction deadline in these options;
yt-dlp/transport timeouts and retries may eventually return. Slow sources,
authentication, manifests, DNS, and plugin calls require affected-environment
evidence before any is identified as the reporter's trigger.

### Relationship to Bug 0067 and bandwidth controls

**A connection to Bug 0067 is plausible but unconfirmed.** Asset registration
and download updates share `_db_lock` and the same database. A slow asset
registration can hold that lock while a URL worker waits to publish setup or
progress. The 0067 fix reduces reconciliation work and unnecessary write
transactions, but does not add worker failure recovery or bound the duration
of an individual filesystem/database operation.

There are two distinct lock effects:

- Cooperating writers in one process wait for the Python `_db_lock` before
  opening their write connection. A slow successful asset commit can delay
  download updates. That Python-lock wait is outside `db()`'s timing window
  and is not bounded by its SQLite busy timeout.
- The persistent orphan reproduction requires SQLite to reject a worker
  write. Its independent transaction deliberately bypasses the Python lock.
  It does **not** prove that the same-process asset worker causes `SQLITE_BUSY`.
  Multiple processes or storage failures remain possibilities requiring logs.

The warning level alone cannot distinguish these cases. A 0067-style
`operation=register thread_name=vdl-assets ... result=ok` warning indicates a
slow successful operation. The reproduced orphan instead logs
`operation=db_update_download ... result=SQLITE_BUSY code=5` in the download
worker and has an escaping exception. Capture the full timing/result fields
and traceback before connecting the incidents.

Bug 0060 fixed measured capped-read overhead and Unlimited transport selection,
but explicitly left the reporter's exact startup failure unconfirmed. The
blocked initial probe reproduces even at Unlimited, before media accounting;
the orphan reproduction also occurs before bandwidth control. Changing the
rate to zero is therefore not a confirmed remedy for either case.

### UI visibility and deployment evidence needed

[`renderItem()`](../static/app.js#L3195) explicitly exposes `Waiting for a
download slot`, but the URL summary does not expose `Preparing download`,
extraction stage, elapsed stage time, worker liveness, or the raw downloaded
byte count. Without a total, the displayed downloaded percentage is a dash.
The UI cannot distinguish these backend states from the percentage alone.

For one affected entry, capture before restarting or replacing the container:

1. Image version/digest, incident time, source website or redacted URL, exact
   row message, and whether it is a fresh or continued job.
2. Two authenticated `/api/current-downloads` responses several seconds apart:
   ID, status, progress, downloaded/total bytes, speed, and finish time. Compare
   with that job's partial-file size over the same interval. Redact unrelated
   titles, URLs, session cookies, and tokens from shared artifacts.
3. Timestamped container logs from submission through the stall, particularly
   the complete SQLite diagnostic and any `background_download` traceback.
4. Saved global/per-source limits and bandwidth, other active/paused jobs,
   and whether startup ingestion or asset reconciliation is underway.
5. Stop's HTTP response and the row state afterward. An active row with no
   live worker identifies the reproduced orphan class; a live worker's stack
   in extraction/network I/O identifies the blocked-call class. The public
   current-downloads API does not expose worker ownership, so that distinction
   needs server-side inspection/instrumentation.
6. If backend bytes or files grow, inspect Current downloads refresh requests
   and `/api/events` connection health to isolate a display-only problem.

### Repair scope and acceptance criteria

- Cover the complete worker lifecycle, including preference reads and setup
  writes. When a worker fails, retain its diagnostic and reconcile its active
  row once persistence is possible. A terminal write can itself fail; moving
  a `try` block alone does not establish eventual recovery after contention.
- Reconcile dead active URL rows without requiring a process restart. Preserve
  live-worker/file ownership checks and prevent duplicate resumed workers.
- Make cancellation and preparation observable during extraction. Define and
  test a bounded recovery policy for blocked calls; do not release a live
  worker's reservation or allow overlapping writes to its partial files just
  to make Stop appear successful.
- Keep legitimate global/per-source queueing distinguishable from preparation
  stalls. Preserve paused-job semantics and prompt admission after cleanup.
- Add regressions through the actual enqueue/worker/API boundary for setup
  `SQLITE_BUSY`, recovery after the lock disappears, failure while recording a
  terminal outcome, and Stop/Continue/Remove on an orphaned URL row.
- Add controlled real-HTTP extraction and first-media-read stalls at 0 and a
  positive cap. Verify cancellation behavior, ownership, successor admission,
  and meaningful UI feedback without depending on a public source website.
- Recheck cached-asset startup and slow asset commits alongside downloads;
  measure Python-lock waits separately from SQLite execution/commit time.

### Original investigation validation

The standalone database reproduction fails the terminal-status assertion on
the current code. The local HTTP reproduction confirms held extraction and
pending Stop, then successful cancellation when released. Both use temporary
state and leave no background worker after cleanup. Reproduction scripts were
kept outside the repository; the persistent database command is embedded above.

The initial investigation changed only this report and its ledger entry.
Baseline validation using Python 3.12.14:

```text
VDL_PYTHON=/tmp/vdl-bug0067-venv/bin/python ./tests/run-all.sh --unit
Ran 391 tests in 182.817s
OK (skipped=6)
vdl.py line coverage: 91.6% (5064/5527; minimum 90.0%)
```

The environment path identifies an existing local Python 3.12 virtualenv;
use an equivalent dependency-installed interpreter elsewhere. Passing existing
tests does not resolve the newly reproduced worker-lifecycle defect. Report
and index links were checked, and `git diff --check` passed.

### Fix validation — version 0.50.4

Using Python 3.12.14:

```text
VDL_PYTHON=/tmp/vdl-bug0067-venv/bin/python ./tests/run-all.sh --unit
Ran 397 tests in 219.061s
OK (skipped=6)
vdl.py line coverage: 92.0% (5139/5588; minimum 90.0%)

VDL_PYTHON=/tmp/vdl-bug0067-venv/bin/python python3 tests/browser/run.py worker-recovery.spec.cjs live-updates.spec.cjs preferences.spec.cjs
29 passed

VDL_PYTHON=/tmp/vdl-bug0067-venv/bin/python ./tests/run-all.sh --media
Ran 6 tests
OK
```

The HTTP fixture allows cold extractor initialization before starting the
network recovery assertions; this also passes under coverage instrumentation.
JavaScript/Python syntax checks and `git diff --check` passed. The runtime
application database and deployment were not changed.
