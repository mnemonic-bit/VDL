## 54. [Resolved] Live refresh overload stalls the download UI

**Severity:** High — ordinary progress events can accumulate expensive requests,
hide accepted downloads, replace thumbnails repeatedly, and leave a failed
initial load looking like an empty library.

**Status:** Resolved in version `0.46.2` on 2026-10-23. The application
amplification defects are fixed and covered by deterministic backend and browser
regressions. The initiating condition and minute-long request timings in the
reporter's deployment remain unverified. Database contention was addressed
separately in [bug 0053](bug-0053-database-locks-fail-authenticated-api-requests.md).

### Implemented repair

- Every collection has one outstanding refresh and one dirty follow-up, shared
  by SSE, manual refreshes, and action callbacks. Progress is coalesced over
  150 ms and known Current updates refresh Current alone; a row leaving Current
  also refreshes Library and Playlists. Attempt-history page/filter changes
  invalidate older intent without starving refreshes under sustained events.
- Library and Current render independently. Initial loading, confirmed-empty,
  and failed refreshes have distinct states; failed reads preserve existing
  cards. Transient collection failures retry twice with bounded delays. Each
  collection retains its own failure until it recovers, and unrelated successes
  cannot clear a failed health check.
- Cards reconcile by stable id and changed generated markup, preserving healthy
  thumbnail elements, hover videos, focus, menus, and pressed-action protection.
  Retained tag editors use delegated handlers; favorite and visibility controls
  explicitly re-enable after their mutation completes.
- Trusted directories are snapshotted once per request or background batch,
  using deterministically closed connections. Realpath confinement, historical
  worker output directories, and per-user visibility remain enforced. Library
  and Current filter statuses and associated tags in SQL.
- Thumbnail cache misses share per-file generation, with at most two concurrent
  request-triggered decoders and a 30-second failure cooldown. Busy requests
  return immediately. Image retries distinguish temporary capacity responses
  from failures, back off and spread capacity retries, and bound repeated
  decode/network failures without replacing healthy images.

The backend regression checks query and connection counts at different library
sizes. A local 2,000-item authenticated request now uses **one allowlist scan
and three closed connections**, versus 2,000 scans and 4,002 connections in the
original investigation; the traced request took approximately **101 ms**.
These fixture measurements do not predict deployment latency.

The Python 3.12 unit gate passes with **91.4%** `vdl.py` line coverage
(4,882/5,342 executable lines; required minimum 90%). Permanent regressions live
in `tests/test_live_refresh.py` and
`tests/browser/live-refresh-overload.spec.cjs`; existing interaction suites
cover the preserved controls and menus. The final related browser run passes
all 58 checks, including ten new overload regressions; all 20 standalone
JavaScript checks also pass.

Library still returns its full visible collection and stored format metadata;
backend pagination/projection, progress persistence sampling, and overall probe
extraction budgets remain possible future scaling work. None is required to
bound the repaired refresh pipeline. Production timing correlation is still
needed to identify the deployment's original slowdown.

### Historical investigation

The sections below record the diagnosis against `acc531f`, version `0.46.0`,
before this repair. Their source line references and expected failing outcomes
refer to that revision.

### Report and conclusion

The reporter sees an initially responsive page degrade over time. Loading video
properties in New download becomes slow, accepted downloads do not appear in
Current Downloads, thumbnails flash together, and some fetch requests exceed a
minute. Reopening the page can leave it showing "No downloads yet" without
thumbnails. During the investigation the reporter confirmed approximately
2,000 Library videos, matching the largest measured fixture below.

There is a confirmed feedback mechanism that fits much of this sequence:

```text
download progress / import / other change event
  -> Library + Current Downloads + Playlists fetches
  -> Library repeatedly scans the database and opens connections per video
  -> slow responses overlap with the next event's fetches
  -> more work and longer waits
  -> each completed refresh rebuilds the visible cards and thumbnails
```

Current Downloads is rendered only when both its own request and Library have
succeeded. A fast, successful Current response therefore cannot update the UI
while Library is delayed. A failed initial request leaves the default empty
state visible. These behaviors are reproduced in Chromium with the real UI.

This establishes application defects and a credible amplification chain. It
does not establish which condition first slowed this particular deployment:
library size, storage latency, SQLite contention, extraction/network delay,
background import, or another source of resource contention.

### Confirmed findings

#### 1. The refresh scheduler does not bound outstanding requests

[`scheduleFetch()`](../static/app.js#L5941) schedules a zero-delay timer and
clears `pendingFetch` before `fetchHistory()` or `fetchPlaylists()` finishes.
This coalesces events arriving before that timer runs; it does not wait for
network requests. Every later event can start another set of requests.

Controlled browser experiment: hold collection responses, then update one
existing download twelve times through the fixture API, waiting for each real
SSE-driven refresh to start. Before releasing any response, the frontend has:

```text
Library: 12 unresolved requests
Current Downloads: 12 unresolved requests
Playlists: 12 unresolved requests
```

These are frontend requests held by Playwright routing, not measurements of
36 simultaneous server executions or browser connection slots. They prove
that the application keeps requesting work while earlier work is unresolved.
An open attempt-history or duplicates view adds another refresh per scheduled
cycle. Multiple connected users/tabs can multiply the load.

[`progress_hook()`](../vdl.py#L3632) writes every downloading callback through
[`db_update_download()`](../vdl.py#L944), which updates the attempt snapshot and
publishes a change event after the transaction. There is no application-level
sampling of those callbacks. The bounded server SSE queue does not bound work
already requested by the frontend. The browser ignores the change reason/id
when deciding which collections to fetch.

#### 2. Library performs a database scan and opens two connections per video

The relevant path is:

```text
GET /api/library
  get_library()
    db_list_downloads()
    for every finished file that exists:
      _playable_library_entry()
        _is_allowed_download_path()
          db_get_preferences()                 # connection + SELECT
          SELECT DISTINCT output_dir ...       # another connection + scan
```

See [`get_library()`](../vdl.py#L5836),
[`_playable_library_entry()`](../vdl.py#L1846), and
[`_is_allowed_download_path()`](../vdl.py#L6695).
The directory allowlist is reconstructed for every entry. The query plan is:

```text
SCAN downloads
USE TEMP B-TREE FOR DISTINCT
```

For N existing finished files among M downloads, that means N full scans of M
rows, plus path checks and connection creation. With predominantly finished
rows, the scan component grows quadratically. Even if every video belongs to
the same output directory, the database still scans the download rows each time.

Measurements below use disposable SQLite databases, Python 3.11.2, SQLite
3.40.1, and the real authenticated Flask endpoint. All rows reference the same
small existing fixture file in one allowed directory. Thus these measurements
exclude real media decoding, internet extraction, and slow remote storage.
Times are medians of three requests with SQL tracing enabled; connection counts
include the authentication lookup.

| Finished rows | Library time | SQLite connections | Allowlist scans | Response bytes | Current time, no active rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 | 71 ms | 202 | 100 | 59,982 | 2.5 ms |
| 500 | 392 ms | 1,002 | 500 | 300,782 | 7.6 ms |
| 1,000 | 859 ms | 2,002 | 1,000 | 601,782 | 14.7 ms |
| 2,000 | 2,089 ms | 4,002 | 2,000 | 1,205,782 | 28.7 ms |

As an isolated comparison, substitute a directory predicate using the known
fixture directory snapshot, retaining realpath/commonpath containment checks.
The 2,000-row response is byte-for-byte identical, takes 81 ms, and opens two
connections. This demonstrates the cost of repeated allowlist construction;
it is not a complete implementation or a security review of a future cache.

In a separate experiment without SQL tracing, 500 rows take 0.392 seconds for
one request. Four concurrent authenticated requests against the same fixture
database take 1.905–1.991 seconds each. Parallelizing this existing work does
not make it cheap.

[`db_list_downloads()`](../vdl.py#L1433) also retrieves the entire visible
collection, including stored formats, and all tag associations. Both Library
and Current call it and filter statuses afterward in Python. The visible page
size/endless-scroll limit is applied in the browser; it does not limit backend
Library work or its response size. A paginated `/api/history` route exists for
attempt history, but the main Library refresh does not use it.

#### 3. Current Downloads depends on Library, and old responses can erase new state

[`fetchHistory()`](../static/app.js#L3197) combines Library and Current through
`Promise.all()` before rendering either collection. It does not maintain a
request generation or reject an older collection snapshot.

Two independent browser reproductions establish the impact:

- Hold Library responses, submit a real `/api/download` using the fake media
  worker, and verify HTTP success with a returned id. A separate Current API
  request returns that id, while the UI badge remains at its initial zero and
  the Current button stays hidden.
- Feed an older refresh an empty Current snapshot after a newer refresh has
  rendered an active row. The older completion clears the active list and
  hides the Current button. The badge's text remains `1` because the empty
  branch hides it rather than resetting its text; badge text alone is not a
  valid check for this race. This second reproduction controls response
  ordering at `apiFetch()` while exercising the real rendering function.

[`startDownload()`](../static/app.js#L453) closes the dialog after the successful
POST and then requests another complete refresh; it does not render the
accepted id immediately. [`add_download()`](../vdl.py#L5350) registers a row
and enqueues it before returning. Therefore a successful POST means the job
was accepted into the scheduler; it does not mean bytes are already arriving.
The job may be waiting for a global or per-host slot. An invisible row cannot
be used to infer that submission failed. A pending POST remains ambiguous,
and multiple persistence/enqueue steps mean a failed response does not by
itself prove that no row was inserted.

#### 4. Every completed refresh replaces the thumbnails together

[`fetchHistory()`](../static/app.js#L3306) calls `stopHoverPreview()` and assigns
new `innerHTML` to both lists, even if only one active download's progress
changed. Playlist rendering also rebuilds its shelf.

A browser test saves an existing Library image element, updates an unrelated
active download, and refreshes. The original image is detached and a different
element takes its place. That directly establishes synchronized thumbnail
replacement and a mechanism for flashing/restarted loading states. It also
interrupts an active hover preview. Cached valid thumbnails may reuse image
bytes: replacing the elements does not prove that every image is redownloaded
from the server on every update. Actual paint flashing with production images
was not captured.

#### 5. Failed initial requests can look like a genuinely empty library

[`apiFetch()`](../static/app.js#L139) clears the server-error indicator for any
HTTP response before callers validate its status or parse JSON. Collection
refreshes do not check `res.ok`, and their scheduled/initial callers do not
handle their rejected promises. HTTP errors resolve a fetch promise normally;
see the [Fetch documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch).

The page shell starts with
[`No downloads yet`](../templates/index.html#L305). There is no separate
initial loading/error state for these collections.

Controlled browser experiment: seed a finished Library item, make Current
return an HTTP 500 HTML response, and reload. The Library API succeeds, but
JSON parsing of Current rejects the combined refresh. The page still says
"No downloads yet", the server-error indicator is hidden, and unhandled page
errors are recorded. The normal periodic health check only updates health and
uptime; it does not retry the failed collection load. A later change or SSE
reconnect can trigger another refresh, but a healthy connection does not imply
that either collection rendered successfully.

#### 6. Missing thumbnails can trigger duplicate synchronous generation

[`stream_thumbnail()`](../vdl.py#L6770) generates a missing thumbnail in the
request thread. It has no per-item generation lock or failure cooldown.
Imported videos are published without pre-generating their thumbnails, so
their first visible image request normally enters this path.

Four concurrent authenticated thumbnail requests for one missing sidecar all
entered a gated generation stub before any completed. All four returned 404
when generation failed, and the next request invoked generation again. This
confirms duplicate generation dispatch and repeated failed attempts. The test
did not run four real ffmpeg processes or measure decoder CPU consumption.

The real generator can call ffprobe with a 10-second timeout, then try up to
three frame extractions with 30-second timeouts each. Those are per-subprocess
limits, not an overall request deadline. A thumbnail request can therefore be
slow independently of collection fetches. This is a conditional contributor,
particularly for uncached/imported or unsupported media; cached thumbnails do
not run generation. Thumbnail `<img>` requests and collection `fetch` requests
must be distinguished in a production network capture.

### Additional contributors and limits of the evidence

- **Database contention:** a separate connection holding `BEGIN EXCLUSIVE`
  against the disposable database reproduced `database is locked` in the
  authenticated Current path after 5.01 seconds. Releasing it restored HTTP
  200. Bug 0053 documents realistic rollback-journal reader/writer conflicts
  as well. This is an additional confirmed failure mode, not proof that every
  slow request is waiting on SQLite or that one five-second busy timeout
  explains a one-minute request. A Library request performs many database
  operations; Python lock waits and other work have different limits.
- **Connection lifetime:** `_is_allowed_download_path()` uses
  `with sqlite3.connect(...)` without an explicit close. That context manager
  commits/rolls back but does not close the connection, as documented by
  [Python](https://docs.python.org/3.12/library/sqlite3.html#how-to-use-the-connection-context-manager).
  A subclass probe recorded 100 direct context exits and only 100 explicit
  closes across 100 allowlist calls: those closes belong to the separate
  preferences connections. File descriptors changed from 4 to 55 and returned
  to 4 after `gc.collect()`. This is delayed resource release, not evidence
  of a permanent unbounded leak or a persistent transaction deadlock.
- **Video probing:** [`probe_url()`](../vdl.py#L5592) runs yt-dlp extraction
  synchronously without an application-level overall deadline or probe
  concurrency limit. The browser discards obsolete results by generation but
  does not abort obsolete probe requests. The download worker probes again
  after submission. External extraction delay remains independently possible;
  no real source URL was timed in this investigation.
- **Import/backfill:** copying, hashing, and probing are outside the ingest
  write transaction. They can still compete for disk/CPU and publish changes.
  Import-start events themselves trigger complete collection refreshes.
  Background duplicate backfill also calls the expensive path guard while
  checking file identities and wakes periodically. Closing the page does not
  stop background imports or backfills. Their load was not profiled in the
  reporter's deployment.
- **Transport:** one long-lived `/api/events` request is intentional. Other
  minute-long collection fetches require investigation. HTTP/1.x connection
  limits can cause browser queueing when slow work occupies connections; SSE
  shares the origin's connection budget. The relevant constraints differ
  under HTTP/2; see [MDN's SSE transport note](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#listening_for_custom_events).
  The reporter's protocol, proxy configuration, and request Timing breakdown
  were not available, so browser connection exhaustion is not established.

### Recommended repair order

1. Bound collection refreshes to one outstanding refresh per collection,
   retaining a dirty flag for one follow-up after changes arrive. Coalesce
   progress updates over a short interval and ignore obsolete responses.
   Manual refreshes and action callbacks must share the same coordinator.
2. Build the trusted directory snapshot once per request/batch and close
   every SQLite connection deterministically. Preserve realpath confinement,
   stored output-directory authorization, and per-user visibility. Do not
   authorize a filename by treating its own directory as trusted.
3. Fetch and render Current independently, display accepted jobs promptly,
   and distinguish loading, stale/error, and confirmed-empty states. Check
   HTTP status before JSON parsing and recover failed collections with bounded
   retries. A successful health response must not erase a collection failure.
4. Reconcile cards by stable id and changed fields. Preserve unchanged images,
   previews, focus, menus, and the existing pressed-action protections. Route
   progress events to the affected collections rather than rebuilding all UI.
5. Move status filtering and Library pagination/projection into bounded backend
   queries. Keep stored format metadata out of routine list responses when
   callers do not need it. UI pagination alone does not reduce server load.
6. Address bug 0053 with measured transaction/lock diagnostics and appropriate
   journal/timeout policy. WAL alone does not repair refresh amplification,
   repeated scans, missing UI error states, or multiple-writer serialization.
7. Deduplicate/bound thumbnail and probe work; add a retry policy for failed
   thumbnails and explicit extraction budgets. Any probe cancellation design
   must consider server-side work as well as aborting the browser request.

Regression criteria should cover slow and failed responses, out-of-order
completions, accepted-but-queued jobs, bounded request counts under sustained
events, stable image nodes, and request query/connection counts as the library
grows. Validate improvements with the same fixtures and full project coverage
gate when implementing a fix.

### What is still needed from the running deployment

Record the deployed version, approximate Library size, active downloads/import
state, storage location/type, and whether access is direct or proxied. Capture
one slow request's URL, status, protocol, and Timing split between queued/stalled,
waiting for the first byte, and transfer. Correlate its timestamp with server
logs and CPU, thread count, file descriptors, disk activity, and SQLite errors.
Avoid recording session cookies, signed media URLs, or authorization headers.

A successful `/api/download` response with its id plus a successful Current
response containing the same id distinguishes accepted work from display lag.
Slow time before the request is sent suggests transport queueing; slow waiting
after send suggests server/proxy work; a slow `/api/probe` alone suggests the
extraction path. The label `fetch` alone cannot distinguish these cases.

### Reproduction artifacts

Temporary browser checks exercised the actual UI against the existing isolated
Flask fixture with fake yt-dlp. All five desired-behavior assertions failed on
the unmodified application in the final run. Those failures are diagnostic
evidence, not failed fixes or a claim that the normal project suite fails.
Three existing live-update checks (SSE reconciliation, Stop during refresh,
and deferred menu reconciliation) passed separately in 5.0 seconds. The full
unit coverage gate was not run because this change documents a diagnosis and
does not modify application or permanent test code. No real downloads
or existing database rows were changed. The temporary test source is preserved
below for reproduction, rather than installed as a failing permanent suite.


Save the following JavaScript as
`tests/browser/performance-diagnosis.spec.cjs` and run:

```bash
VDL_PYTHON="$PWD/.venv/bin/python" tests/browser/run.py performance-diagnosis.spec.cjs
```

Expected on this revision: **5 failed**, each asserting a missing behavior.
Remove the temporary spec after diagnosis. The runner creates and cleans its
own fixture database/media tree; do not run alongside another browser-fixture
process using the same fixture files.

```javascript
const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');
test.beforeEach(async ({ page }) => reset(page));

test('slow library response must not hide a newly accepted Current download', async ({ page }) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/library', async route => {
        await gate;
        await route.continue();
    });
    try {
        await page.request.post('/__test__/hold-downloads');
        const response = await page.request.post('/api/download', { data: { url: 'https://fixture.invalid/accepted' } });
        expect(response.ok()).toBe(true);
        const accepted = await response.json();
        expect(accepted.id).toBeTruthy();
        const current = await page.request.get('/api/current-downloads');
        expect((await current.json()).some(row => row.id === accepted.id)).toBe(true);
        await expect(page.locator('#currentBadge')).toHaveText('1', { timeout: 700 });
    } finally {
        release();
        await page.request.post('/__test__/release-downloads');
    }
});

test('unrelated progress must preserve existing thumbnail nodes', async ({ page }) => {
    await seed(page, { id: 'perf-thumb', status: 'finished', file: true });
    await refresh(page);
    await page.evaluate(() => { window.originalImage = document.querySelector('#historyList img'); });
    await seed(page, { id: 'perf-progress', status: 'downloading', progress: '20%' });
    await refresh(page);
    expect(await page.evaluate(() => document.querySelector('#historyList img') === window.originalImage)).toBe(true);
});

test('progress events must bound concurrent collection refreshes', async ({ page }) => {
    await seed(page, { id: 'perf-events', status: 'downloading' });
    await refresh(page);
    await page.waitForTimeout(100);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const starts = { library: 0, 'current-downloads': 0, playlists: 0 };
    for (const name of Object.keys(starts)) {
        await page.route(`**/api/${name}`, async route => {
            starts[name]++;
            await gate;
            await route.continue();
        });
    }
    try {
        for (let i = 1; i <= 12; i++) {
            await seed(page, { id: 'perf-events', status: 'downloading', progress: `${i}%` });
            await expect.poll(() => starts.library).toBeGreaterThanOrEqual(i);
        }
        console.log('unresolved collection requests after 12 progress events:', starts);
        expect(starts.library).toBeLessThanOrEqual(1);
    } finally { release(); }
});

test('failed initial refresh must not claim the library is empty', async ({ page }) => {
    await seed(page, { id: 'perf-existing', status: 'finished', file: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/current-downloads', route => route.fulfill({ status: 500, contentType: 'text/html', body: '<html>database is locked</html>' }));
    await page.reload();
    await expect.poll(() => errors.length).toBeGreaterThan(0);
    console.log('failed initial refresh:', await page.locator('#historyEmpty').textContent(), 'server error visible:', await page.locator('#serverStatus').isVisible(), 'page errors:', errors.length);
    await expect(page.locator('#historyEmptyTitle')).not.toHaveText('No downloads yet', { timeout: 700 });
});

test('older refresh must not replace a newer Current snapshot', async ({ page }) => {
    await page.addInitScript(() => { window.EventSource = class extends EventTarget {}; });
    await page.reload();
    await refresh(page);
    await page.waitForTimeout(200);
    const newer = await seed(page, { id: 'perf-later', status: 'downloading' });
    const result = await page.evaluate(async newer => {
        const originalFetch = window.apiFetch;
        let release;
        let currentCalls = 0;
        window.apiFetch = url => {
            if (url === '/api/library') return Promise.resolve({ json: async () => [] });
            if (url === '/api/current-downloads') {
                if (++currentCalls === 1) return new Promise(resolve => {
                    release = () => resolve({ json: async () => [] });
                });
                return Promise.resolve({ json: async () => [newer] });
            }
            return originalFetch(url);
        };
        try {
            const older = fetchHistory();
            await fetchHistory();
            const before = document.getElementById('currentBadge').textContent;
            release();
            await older;
            return { before, after: document.getElementById('currentBadge').textContent,
                list: document.getElementById('activeList').textContent,
                hidden: document.getElementById('currentDownloadsButton').hidden };
        } finally { window.apiFetch = originalFetch; }
    }, newer);
    console.log('out-of-order refresh:', result);
    expect(result.hidden).toBe(false);
});
```

The principal backend timing/count experiment can be repeated by saving this
Python block outside the repository and running `.venv/bin/python` on it from
the repository root. It creates and removes its own temporary database.

```python
import os, sys, tempfile, time, statistics, sqlite3, collections, gc
from unittest.mock import patch
sys.path.insert(0, os.getcwd())
with tempfile.TemporaryDirectory(prefix='vdl-perf-') as directory:
    os.environ['DOWNLOADS_DB'] = os.path.join(directory, 'state.db')
    os.environ['DOWNLOADS_DIR'] = directory
    import vdl
    admin = vdl.db_get_initial_admin()
    with vdl.db() as conn:
        conn.execute('UPDATE users SET password_hash=? WHERE id=?', ('fixture-only',admin['id']))
    vdl.app.config['TESTING'] = True
    client = vdl.app.test_client()
    with client.session_transaction() as session:
        session['user_id'] = admin['id']
        session['session_version'] = admin['session_version']
    media = os.path.join(directory, 'fixture.mp4')
    open(media,'wb').write(b'fixture-media')
    real_connect = sqlite3.connect
    counts = collections.Counter()
    def traced_connect(*args, **kwargs):
        counts['connections'] += 1
        conn = real_connect(*args, **kwargs)
        def trace(sql):
            counts['statements'] += 1
            if 'SELECT DISTINCT output_dir' in sql: counts['allowlist_scans'] += 1
        conn.set_trace_callback(trace)
        return conn
    print('python',sys.version.split()[0], 'sqlite',sqlite3.sqlite_version)
    for size in [100,500,1000,2000]:
        with vdl.db() as conn:
            conn.execute('DELETE FROM downloads')
            conn.executemany('INSERT INTO downloads (id,url,status,progress,created_at,filename,output_dir,title,owner_user_id) VALUES (?,?,?,?,?,?,?,?,?)',
                [(f'item{i}', 'https://fixture.invalid/video','finished','100%',i,media,directory,'Fixture',admin['id']) for i in range(size)])
        for endpoint in ['/api/library','/api/current-downloads']:
            elapsed=[]
            for _ in range(3):
                counts.clear()
                with patch.object(vdl.sqlite3,'connect',traced_connect):
                    start=time.perf_counter(); response=client.get(endpoint); elapsed.append(time.perf_counter()-start)
                assert response.status_code == 200
            print(size, endpoint, 'median_ms',round(statistics.median(elapsed)*1000,2), 'bytes',len(response.data), dict(counts),flush=True)
        if size == 2000:
            def snapshot_guard(path):
                real=os.path.realpath(path)
                return os.path.commonpath([real,directory]) == directory
            counts.clear()
            with patch.object(vdl.sqlite3,'connect',traced_connect), patch.object(vdl,'_is_allowed_download_path',snapshot_guard):
                start=time.perf_counter(); compared=client.get('/api/library'); elapsed=time.perf_counter()-start
            original=client.get('/api/library')
            assert compared.data == original.data
            print('2000 request-local allowlist equivalent',round(elapsed*1000,2),'ms',dict(counts),flush=True)
    blocker=real_connect(vdl.DB_PATH)
    blocker.execute('BEGIN EXCLUSIVE')
    start=time.perf_counter()
    try: client.get('/api/current-downloads')
    except sqlite3.OperationalError as exc: print('exclusive_lock', str(exc),'elapsed_s',round(time.perf_counter()-start,2),flush=True)
    finally: blocker.rollback();blocker.close()
    print('post_lock_recovery',client.get('/api/current-downloads').status_code)
    print('health',client.get('/api/health').status_code)
    gc.collect()
```
