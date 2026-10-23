## 53. [Open] Database locks fail authenticated API requests

**Severity:** Medium — authenticated requests can fail and leave the UI stale.

**Status:** Open; reported and investigated on 2026-10-23. The exact traceback
is reproduced against an isolated database. The operation holding the lock in
the reported deployment remains unknown; concurrent ingest is a user-reported
possibility, not a confirmed cause. No application fix has been applied.

### Reported behavior

The user observed `sqlite3.OperationalError: database is locked` in the server
log for `/api/current-downloads`, with frames at `vdl.py` lines 318, 2549, and
2526. The user later suggested an ingest-directory import might have been
running, but could not confirm it because filesystem imports have poor UI
visibility. The deployed version, incident timestamp, full surrounding logs,
and whether the errors recover without restarting were not established.

**Actual:** A database read in the authentication hook raises an unhandled
exception. With normal Flask exception handling, the request returns HTTP 500;
the local test client with `TESTING=True` propagates the exception instead.

**Expected:** Background database activity should allow ordinary authenticated
reads to proceed. Exceptional lock contention should have bounded handling and
diagnostics that identify the operation involved. Authentication must continue
to enforce account suspension and session invalidation.

### Confirmed request path and impact

The failure precedes the endpoint handler:

```text
GET /api/current-downloads
  require_authenticated_user()       vdl.py:318
    db_get_user_by_id(user_id)       vdl.py:2549
      _db_user(conn, "id = ?", ...)  vdl.py:2526
        SELECT ... FROM users ...
sqlite3.OperationalError: database is locked
```

The failing SQL is the signed-in user lookup, not the download-list query.
Other authenticated routes using this hook are exposed to the same failure.
The frontend's `fetchHistory()` fetches Library and Current Downloads together
with `Promise.all()`. A failed request can therefore prevent the combined UI
refresh even if the other collection request succeeds. This is a source-based
impact finding; the browser behavior was not independently reproduced.

### Database configuration and locking mechanism

- Investigation used checkout `acc531f`, version `0.46.0`, Python `3.11.2`,
  and SQLite `3.40.1` from the existing `.venv`. Reproductions used temporary
  databases and did not download media or modify the existing database.
- A read-only metadata query of this workspace's `downloads.db` reported
  `journal_mode=delete`, `locking_mode=normal`, 63 pages, and 4096 bytes per
  page. These are local observations, not measurements of the deployment.
- `db()` opens a new `sqlite3.connect(DB_PATH)` connection for each call,
  enables foreign keys, commits on clean exit, and closes in `finally`.
  It does not configure WAL, an explicit lock timeout, or a retry policy.
  Connections consequently use Python's default five-second busy timeout.
- `_db_lock` serializes cooperating writers within one process. The
  authentication lookup does not take that lock and reads through another
  connection. The Python lock does not coordinate other processes.
- In rollback-journal mode, a small uncommitted write can coexist with
  readers. A writer spilling its cache to disk needs an exclusive lock; a
  writer waiting to commit can hold a pending lock that prevents new readers
  while existing readers finish. A write transaction does not necessarily
  block all reads for its whole lifetime.

The observed exception is consistent with lock contention. It does not by
itself establish a leaked connection, database corruption, or a deadlock.

### Experiments already performed

All cases exercised the real Flask authentication path against temporary
databases. The exact-traceback reproduction used the application's unmodified
connection timeout. The comparison probes shortened the timeout to 0.15
seconds so that blocked cases completed quickly.

| Controlled condition | Observed result |
| --- | --- |
| Authenticated request without a competing lock | HTTP 200 |
| Separate connection holds `BEGIN EXCLUSIVE` in DELETE mode | Exact three reported frames; `OperationalError: database is locked` after 5.01 seconds |
| Real `db_update_download()` paused after a small 32-byte `formats` update, before commit | HTTP 200 in approximately 0.002 seconds |
| Same write path with a 4 MiB `formats` value, paused before commit, in DELETE mode | `OperationalError: database is locked` after approximately 0.153 seconds |
| Same 4 MiB write experiment with WAL enabled on the temporary database | HTTP 200 in approximately 0.043 seconds |
| Existing explicit read transaction plus an ordinary `progress='25%'` update waiting to commit in DELETE mode | New authenticated request raises `OperationalError: database is locked` |

The write-size comparison paused `download_history.record()` using events
after the real download update had executed, preserving the application's
write lock and open transaction. The 4 MiB value and forced pause are synthetic
stress conditions; they do not establish that production metadata is that
large or that ordinary writes take that long.

The pending-commit experiment kept an existing reader open, ran the real
`db_update_download()` on another thread, and confirmed that a third connection
could no longer read before issuing the authenticated request. Releasing the
old reader allowed the writer to commit and the endpoint immediately recovered.
Requests also recovered after the other controlled writers committed.

These experiments establish two ways to reach the reported read failure.
They do not identify which occurred in the deployment. WAL removed the
large-write reader conflict in the controlled comparison; it has not been
validated as a complete production fix.

### Minimal reproduction

Run from the repository root after installing dependencies into `.venv`.
The command uses a disposable database. It deliberately exits with the
reported exception after roughly five seconds on the current code:

```bash
.venv/bin/python - <<'PY'
import os
import tempfile
import time

with tempfile.TemporaryDirectory(prefix='vdl-lock-repro-') as directory:
    os.environ['DOWNLOADS_DB'] = os.path.join(directory, 'downloads.db')
    os.environ['DOWNLOADS_DIR'] = directory
    import vdl

    vdl.app.config['TESTING'] = True
    admin = vdl.db_get_initial_admin()
    # A non-null test-only value satisfies the signed-session account check.
    # No login password or production credential is used.
    with vdl.db() as conn:
        conn.execute('UPDATE users SET password_hash = ? WHERE id = ?',
                     ('fixture-hash', admin['id']))
    client = vdl.app.test_client()
    with client.session_transaction() as session:
        session['user_id'] = admin['id']
        session['session_version'] = admin['session_version']
    assert client.get('/api/current-downloads').status_code == 200

    blocker = vdl.sqlite3.connect(vdl.DB_PATH)
    try:
        blocker.execute('BEGIN EXCLUSIVE')
        started = time.monotonic()
        try:
            assert client.get('/api/current-downloads').status_code == 200
        except vdl.sqlite3.OperationalError as exc:
            print(f'{type(exc).__name__}: {exc}; '
                  f'elapsed={time.monotonic() - started:.2f}s', flush=True)
            raise
    finally:
        blocker.rollback()
        blocker.close()
PY
```

The exclusive-lock harness forces the blocking condition to verify the exact
failure path. An exclusive lock is stronger than an ordinary small write;
this harness alone does not reproduce normal ingest activity.

### Ingest findings and UI visibility gap

- `IngestStartupImporter` processes one startup snapshot serially. It is not
  a continuous watcher; later new or changed files require another startup.
- `_ingest_watched_file()` briefly writes a `starting` attempt-history record,
  then emits an `import-start` event. Copying, SHA-256 calculation, and media
  probing happen outside that write transaction.
- After validation, `db_insert_ingested_video()` writes the finished download,
  receipt, folder tags, content hash, and attempt outcome in one transaction.
  Error handling can also write a failed attempt and emit `import-error`.
- Duplicate backfill hashes media outside its write transaction. Metadata
  backfill probes media outside its write transaction as well. Expensive
  copying, hashing, or ffprobe work must not be described as holding the
  SQLite write lock throughout those operations.
- Ingest can still overlap with download writes, UI reads, startup backfills,
  and disk activity. Slow commits or a pending writer blocked by an existing
  reader are plausible explanations; neither was observed in the deployment.
  An ordinary import alone has not been reproduced causing this exception.
- During copying and probing there is no active `downloads` row for the
  import. `/api/current-downloads` reads that table, so it cannot show the
  in-progress import. An administrator can find its generic `starting`
  attempt in History, but no intermediate byte count, copy phase, or ETA is
  published. Ownerless system-import attempts are excluded from normal
  users' personal History.
- Batch scan start/completion, enumerated/imported/skipped/failed counts, and
  scan/reconciliation errors are printed to the server log. There is no
  equivalent batch-progress UI. This makes correlating the exception with
  ingestion difficult for the reporter.

### Remaining hypotheses and evidence needed

1. A writer held an exclusive lock long enough for authentication to time
   out, potentially due to transaction size or slow storage. Measure write
   execution and commit durations separately and correlate with ingest logs.
2. A long-lived reader delayed a writer's commit, and the pending writer
   blocked new authentication reads. Capture reader/cursor lifetimes as well
   as writer timings; the ordinary-progress experiment confirms this mechanism.
3. Another process shared the database and bypassed `_db_lock`. Identify
   serving processes, reloaders, containers, and external database clients
   using the deployed path. No running VDL process/container or historical
   incident logs were available in this workspace to establish this.

File cleanup and password hashing inside database context blocks were also
reviewed as possible places to lengthen operations. Being inside a `db()`
block or holding `_db_lock` alone does not prove an exclusive SQLite lock:
the first write, cache spill, and commit boundaries matter. Neither path was
established as the reported lock holder.

### Proposed correction and verification

- Add targeted transaction and commit timing, thread/operation names, busy
  error details, and timestamps that can be correlated with import start,
  publication, and completion. Do not log credentials or signed media URLs.
- Evaluate enabling WAL once during startup for the deployed storage. WAL
  allows normal readers and writers to proceed concurrently, but still has
  one writer at a time and does not eliminate every `SQLITE_BUSY` case. Verify
  local-filesystem/shared-memory suitability and backup handling first.
- Keep write transactions short and define an explicit bounded busy policy.
  Increasing the timeout alone postpones the failure and can make requests
  appear hung; it does not identify or eliminate the lock holder.
- Handle exhausted lock waits deliberately, including failures in the
  authentication hook, without bypassing authentication or silently serving
  stale authorization state. Define client recovery if a retryable response
  is chosen.
- Expose import phase, per-file progress where measurable, and batch counts
  so users can identify ongoing filesystem activity and failures.
- Add permanent concurrency regressions for ordinary writes, a pending commit
  behind an existing reader, and the selected WAL/busy policy. Verify endpoint
  recovery after contention ends and preserve transaction atomicity.
- Exercise ingest alongside authenticated reads and active downloads using
  representative library sizes and storage. A fix must distinguish the forced
  lock reproduction from a representative workload reproduction.

No permanent regression tests or application changes were added during this
investigation. Temporary probes were removed. This report is documentation
only; `VERSION` is unchanged and no fix or coverage-gate pass is claimed.

### Source references

- [`vdl.py`](../vdl.py): `db`, `require_authenticated_user`, `_db_user`,
  `db_get_user_by_id`, `db_update_download`, `get_current_downloads`,
  `_ingest_watched_file`, `db_insert_ingested_video`, `IngestStartupImporter`,
  `_hash_backfill_once`, and `_metadata_backfill`.
- [`download_history.py`](../download_history.py): `start_mounted`, `record`,
  and `page`.
- [`static/app.js`](../static/app.js): `fetchHistory` and `attemptRowHtml`.
- [Python SQLite connection timeout](https://docs.python.org/3/library/sqlite3.html#sqlite3.connect)
- [SQLite rollback-journal locking](https://www.sqlite.org/lockingv3.html)
- [SQLite cache-spill locking](https://www.sqlite.org/pragma.html#pragma_cache_spill)
- [SQLite WAL concurrency and limitations](https://www.sqlite.org/wal.html)
