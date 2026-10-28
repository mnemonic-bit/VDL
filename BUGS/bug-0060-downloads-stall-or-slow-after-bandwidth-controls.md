## 60. [Resolved] Downloads stall or slow down after bandwidth controls were added

**Severity:** High

**Status:** The reproduced progress-overhead and Unlimited transport-selection
regressions are fixed locally in version `0.49.2` on 2026-10-28. The reporter's
exact source-specific startup failure has not been reproduced; confirmation
in the affected deployment remains outstanding.

Since the download-speed setting was introduced, URL downloads sometimes do
not start and otherwise progress much more slowly than before. The reporter
tried **50 Mbps**, **10 Mbps**, and **0 (Unlimited)** and observed the same
behavior at all three values. This is not adequately explained by choosing a
low bandwidth limit, and changing the setting to Unlimited is not a confirmed
workaround.

The total-bandwidth feature (Feature 0039) and per-server concurrency controls
(Feature 0038) landed together in commit `e6fa7a6`, version `0.44.0`. The
reporter's deployed version, example source URLs, transfer protocols, saved
concurrency limits, and exact waiting/error messages have not been captured.
The timing of the report alone does not establish which change caused it.

### Repair and local verification

`_MediaResponse.read(size)` now combines small, individually accounted
allowances before returning a buffer to yt-dlp. Each allowance still obtains
its FIFO turn, checks Stop/Pause, observes live bandwidth changes, and refunds
unused bytes. Aggregation stops at the requested size, a short underlying
read/EOF, or 100 ms of elapsed time so low-rate downloads retain live progress.
This removes the database transaction and SSE callback per 16 KiB without
changing the shared token bucket or bypassing accounting.

Native transport overrides now apply only under a positive cap. The governor
preserves the original yt-dlp options and rechecks the current setting before
`process_info()` and `dl()` select a downloader. Fresh Unlimited jobs retain
their previous downloader choices, and switching a capped job to Unlimited
restores those choices for subsequent transfers. An already-selected native
transfer stops throttling immediately without restarting. Existing external
transfer guards still reject an unsupported transfer under a cap and stop an
external child if a cap is enabled while it runs.

The controlled 8 MiB reproduction below failed before the fix with 517 capped
progress callbacks and passed afterward with 15. With the same 5 ms callback
delay, the measured capped transfer changed from 3.95 s to 0.17 s; Unlimited
measured 0.21 s before and 0.20 s afterward. Neither run waited for tokens.
These are local fixture measurements, not production throughput claims.

Six new regressions cover concurrent real HTTP transfers with costly
application progress, useful throughput and upper bounds at 50/10/0 Mbps,
unchanged Unlimited options and selection, live selection changes, Stop/Pause
inside an aggregated read, and bounded aggregation latency. All 52 focused
bandwidth, concurrency, and download-lifecycle tests pass on Python 3.12.
An additional real-media HLS regression verifies decodable audio/video at
0/10/50 Mbps, exercising the restored external path and the capped native path.
All six media integration tests pass, including DASH merging, audio extraction,
and HTTP Stop/Continue with range requests. The required
`./tests/run-all.sh --unit` gate passes on Python 3.12.14: 380 tests, five
optional skips, and `vdl.py` coverage of 91.6% (90% required).

The historical findings below explain the verified defects. They do not
establish the original deployment's exact stall trigger. An affected URL and
deployed version are still needed to confirm that symptom after the fix.

### Reproduction to confirm in the affected environment

1. Save **Maximum total download speed** as **50 Mbps** in Settings. Reopen
   Settings to verify the saved value.
2. Submit a supported URL and observe whether it starts, when the first media
   bytes arrive, and whether its downloaded-byte count continues increasing.
3. Repeat with **10 Mbps** and **0 (Unlimited)**, using the same source and
   comparable conditions. Record the settings save responses and actual
   transfer speed; account for partial-file resume when comparing runs.
4. Test a single newly submitted job with no other active or paused jobs,
   then multiple jobs from the same and different source servers. Distinguish
   **Waiting for a download slot**, **Preparing download**, metadata
   extraction, media transfer, and post-processing.
5. Compare an existing transfer after a live setting change with a new
   transfer created after saving 0. This distinguishes retained downloader
   state from settings persistence or startup problems.

**Reported actual:** Downloads sometimes fail to begin; downloads that do
begin take longer than before. Values 50, 10, and 0 behave the same.

**Expected:** Eligible downloads start and continue transferring without
unexplained stalls. Positive limits restrict combined sustained media intake
to the selected rate without substantial additional overhead. At 0,
Unlimited restores the previous unrestricted behavior. Legitimately queued
jobs remain distinguishable from extraction or transfer failures.

### Before the fix: capped reads amplified synchronous progress work

The local reproduction uses the installed Python **3.11.2** and yt-dlp
**2026.08.19**, an isolated temporary SQLite database, a local HTTP fixture,
and the real `vdl.progress_hook()`.

With a nonzero rate, `SharedBandwidth.take()` grants at most **16,384 bytes**
per read (less at low rates). `_MediaResponse.read(size)` returns that one
grant, even when yt-dlp requested a much larger buffer. The installed
`HttpFD` invokes its progress hook after each returned buffer.
`progress_hook()` synchronously calls `db_update_download()`, which acquires
the shared database lock, opens a connection, updates the row and attempt
history, commits, and publishes an SSE change event.

For an **8 MiB** local HTTP payload:

| Mode | Progress-hook calls | Elapsed, no injected delay |
|---|---:|---:|
| Without the bandwidth adapter | 15 | 0.116 s |
| Adapter with 0 (Unlimited) | 15 | 0.076 s |
| Adapter with 128 Mbps | 517 | 0.540 s |

The 128 Mbps bucket begins with **16,000,000 bytes** of credit, so this whole
payload fits within its initial allowance. Instrumenting the controller's
condition confirmed **zero bandwidth waits** for this case. The extra time
therefore is not a required wait for bandwidth tokens.

Adding a controlled **5 ms delay per progress callback**, equally in every
mode, exposes the storage/update sensitivity:

| Mode | First run | Second run | Hook calls | Bandwidth waits |
|---|---:|---:|---:|---:|
| Without adapter | 0.191 s | 0.190 s | 15 | 0 |
| Adapter, Unlimited | 0.169 s | 0.170 s | 15 | 0 |
| Adapter, 128 Mbps | 3.857 s | 3.482 s | 517 | 0 |

The capped result is approximately **2.2–2.4 MB/s**, far below the selected
**16 MB/s**, despite available tokens. This demonstrates a performance defect
when synchronous progress work is costly. The injected latency models that
cost; it is not a measurement of the reporter's production storage.

**Important limit:** This mechanism requires a nonzero cap. The local
Unlimited HTTP case did not reproduce the slowdown. It cannot explain the
reporter's unchanged behavior at 0 by itself, and no local transfer failed
to start.

### Before the fix: Unlimited changed transport selection

`govern_download()` runs for new and resumed URL workers, including at 0.
It wraps media responses and unconditionally sets:

```python
ydl.params['hls_prefer_native'] = True
ydl.params['external_downloader'] = {'default': 'native'}
```

Using the installed yt-dlp selector with a non-live format whose protocol is
`m3u8` selects **FFmpegFD** without the adapter and **HlsFD** after applying
the adapter configured as Unlimited. This confirms that 0 does not fully
restore the earlier transport-selection behavior. It does **not** establish
that the changed selection causes the reporter's stalls or affects all URLs.

Reproduce that selection difference without contacting a remote server:

```bash
.venv/bin/python - <<'PY'
import yt_dlp
from yt_dlp.downloader import get_suitable_downloader
from download_bandwidth import SharedBandwidth, govern_download

controller = SharedBandwidth()
controller.configure('0')
info = {'url': 'https://fixture.invalid/video.m3u8',
        'protocol': 'm3u8', 'ext': 'mp4', 'is_live': False}
with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
    print(get_suitable_downloader(dict(info), ydl.params).__name__)
    govern_download(ydl, controller, 'fixture')
    print(get_suitable_downloader(dict(info), ydl.params).__name__)
PY
```

Observed before the fix: `FFmpegFD`, then `HlsFD`. After the fix both selections
are `FFmpegFD` while the setting is Unlimited.

### Controlled HTTP slowdown reproduction

This command creates its own database and payload, exercises real yt-dlp HTTP
reads and application progress persistence, and adds the same 5 ms callback
cost to both settings. It leaves the application's runtime database alone.
The final assertion fails on the original implementation and passes after the
fix.

```bash
.venv/bin/python - <<'PY'
import os
import tempfile
import time
from unittest import mock

with tempfile.TemporaryDirectory() as root:
    os.environ['DOWNLOADS_DB'] = os.path.join(root, 'downloads.db')
    os.environ['DOWNLOADS_DIR'] = root
    import vdl
    import yt_dlp
    from download_bandwidth import govern_download
    from tests.support.fixture_server import fixture_server

    with open(os.path.join(root, 'source.mp4'), 'wb') as output:
        output.write(b'x' * (8 * 1024 * 1024))
    elapsed = []
    with fixture_server(root) as server:
        for rate in ('0', '128'):
            url = server.base_url + '/source.mp4'
            vdl.db_insert_download(rate, url)
            vdl.db_set_preferences({'max_total_download_mbps': rate})
            calls = []
            def hook(data):
                time.sleep(0.005)
                vdl.progress_hook(data, rate)
                calls.append(1)
            started = time.monotonic()
            with mock.patch.object(vdl._bandwidth.condition, 'wait',
                                   wraps=vdl._bandwidth.condition.wait) as waits:
                with yt_dlp.YoutubeDL({'quiet': True, 'noprogress': True,
                                      'progress_hooks': [hook]}) as ydl:
                    govern_download(ydl, vdl._bandwidth, rate)
                    success, _ = ydl.dl(os.path.join(root, rate + '.mp4'), {
                        'url': url, 'protocol': 'http', 'ext': 'mp4',
                        'id': rate, 'title': 'fixture'})
                elapsed.append(time.monotonic() - started)
                print(rate, success, len(calls), waits.call_count, elapsed[-1])
                assert success and waits.call_count == 0
    assert elapsed[1] < 3 * elapsed[0], 'Excessive capped-mode progress overhead'
PY
```

### Historical coverage and remaining deployment confirmation

- All **14 bandwidth tests** passed, including native HTTP/HLS/DASH,
  cancellation, pause, live updates, retries, and external-transfer guards.
  Their throughput checks enforce an upper bound; they do not exercise the
  costly application progress hook under a high cap or assert useful
  throughput under that load.
- All **14 concurrency tests** passed. The scheduler admits jobs according
  to both global and per-source limits, independently of bandwidth. This
  does not rule out an interaction in the affected deployment.
- Capture one affected URL's stage timings and redacted yt-dlp diagnostic
  output, selected downloader/protocol, saved and effective bandwidth values,
  active/queued worker counts, byte progression, and database wait durations
  at 50, 10, and 0. Compare a fresh job at 0 with the pre-feature transport
  options before attributing the Unlimited failure to the capped-mode defect.
- No production network trace or affected-environment reproduction was
  available. The source-specific startup cause remains unconfirmed; remote-source throttling,
  extractor delay, scheduler occupancy, and database contention have not
  been established as causes.

### Acceptance criteria

- Reproduce and explain the reporter's unchanged behavior at **50, 10, and
  0**, including the cases where a job never begins transferring.
- Unlimited preserves unrestricted throughput and compatible downloader
  behavior for affected HTTP and fragmented-media sources, for newly
  submitted jobs and live changes on existing jobs.
- Capped transfers can approach the configured shared rate when the source
  supplies data. Small internal allowance grants must not require a
  synchronous database transaction and SSE publication for every tiny read.
- Keep one shared accounting budget, bounded bursts, fair access,
  interruptible Stop, Pause/Resume, and prompt live changes. Reducing progress
  overhead must not bypass byte accounting or delay cancellation checks.
- Queued work has a clear waiting state; eligible jobs start once slots are
  free, and a stalled or failed job does not retain slots after it exits.
- Add regressions at the real transport/application-progress boundary with
  controlled update latency and concurrent workers, plus a reproduction of
  the Unlimited startup failure once its trigger is known. Check both upper
  rate limits and useful throughput, rather than only the maximum allowed.
