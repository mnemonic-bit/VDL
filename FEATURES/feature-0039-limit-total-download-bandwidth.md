# Limit total URL download bandwidth

**Source:** User-requested feature  
**Status:** Implemented\
**Implemented:** 2026-10-21 · Version `0.44.0`\
**Last refined:** 2026-10-17

## Decision summary

Add a Settings option for the maximum **combined** transfer speed of all URL
downloads running in this VDL process. The limit is one shared budget: a
single download can use the full allowance, while concurrent downloads share
it. It applies independently of the total and per-server concurrency limits
in Feature 0038. Queued URLs do not consume bandwidth until they start.

This is a sustained, application-level cap on URL download payload. Small,
bounded bursts are allowed; the setting is not a guarantee about every packet
on the host's network interface. The default is **Unlimited**, preserving the
current behavior.

## User flow and setting

Add **Maximum total download speed** beside the concurrency controls in
Settings. Show its unit as **Mbps** (megabits per second), with help text:
“Shared by all running URL downloads. Set to 0 for unlimited. 8 Mbps is about
1 MB/s.” The control accepts a positive decimal value with at most two
fractional digits, or `0` for Unlimited. Show the saved value when Settings
reopens and include it in Settings search terms such as bandwidth, speed, rate,
and Mbps.

Store the preference as `max_total_download_mbps` in the existing preferences
table. `GET /api/preferences` returns it as a canonical decimal string; `POST
/api/preferences` accepts a JSON number or decimal string. Seed `"0"` only
when the key is missing, so existing installations start unlimited and later
choices survive restarts. Reject negative values, booleans, non-finite values,
empty strings, units embedded in the value, and more than two fractional
digits. An invalid save returns 400 and changes no preferences in that
request. Convert internally with decimal Mbps: `1 Mbps = 1,000,000 bits/s =
125,000 bytes/s`. The field describes network transfer speed, not a video's
encoded bitrate.

## Scope

- Share the budget across every active URL-based yt-dlp job in the process,
  regardless of user, source hostname, or whether the job was newly submitted
  or resumed. Include video and audio streams, media fragments, retries, and
  media fetched from redirected or CDN URLs by those jobs.
- Count actual media payload bytes received, including bytes fetched again
  after a retry. A paused job uses no bandwidth allowance while paused but
  keeps its concurrency slots as specified in Feature 0038. Queued jobs and
  local post-processing use no allowance.
- Exclude the New download dialog's `/api/probe`, small extractor metadata
  requests, browser uploads, local file imports, thumbnail generation, and
  playback served to users. The setting controls VDL's remote media intake,
  not all traffic on the machine or internet connection.
- Apply the same budget to every media transfer path VDL allows while the
  setting is enabled, including fragment downloads and any yt-dlp transport
  delegated to another process. A path that cannot be governed must not
  silently run unthrottled under an enabled cap; either route it through the
  shared limiter or return a clear unsupported-transfer error for that job.

## Rate behavior

- Use one thread-safe controller for the process, based on a monotonic clock
  and a token bucket or equivalent byte accounting. All active jobs obtain
  allowance from that controller before consuming media bytes. Limit stored
  burst credit to at most one second of the configured rate. The long-run sum
  of bytes across jobs must therefore stay at or below the selected rate,
  apart from the bounded initial credit and normal protocol overhead.
- Divide available bandwidth fairly enough that one busy download cannot
  indefinitely starve another. If only one job can use the connection, it may
  use the full setting; do not statically divide the cap by the configured
  maximum number of concurrent jobs.
- Setting `0` bypasses throttling. Changing the setting while downloads run
  updates the shared controller without restarting, discarding progress, or
  resetting partial files. Lowering the limit takes effect for subsequent
  reads; raising it lets waiting readers proceed. A return to Unlimited
  releases readers waiting only for bandwidth.
- Throttle waits must be interruptible by Stop and must not hold the database
  lock. A paused job must not accumulate a private backlog of unused tokens
  that causes a burst on Resume. Existing progress, speed, and ETA should
  reflect actual throttled transfer, with no new download status or polling.

## Implementation boundaries

`vdl.py` currently creates a separate yt-dlp instance for each download and
uses `progress_hook` after read chunks. Setting yt-dlp's `ratelimit` to the
same value on every instance would multiply the possible aggregate rate;
sleeping only in `progress_hook` would allow a chunk or fragment to arrive
before the sleep. Integrate the shared allowance at the media read boundary
or an equivalent shared transport layer. Keep a single accounting source
across retries and fallback format attempts. Test native HTTP and fragment
paths, then cover any external media downloader path that VDL can select.

The setting may coexist with the existing global concurrency setting now and
with Feature 0038's per-server setting later. Neither concurrency limit
changes the numeric bandwidth allowance. No OS privileges, container network
capabilities, or router changes are required for this application-level
feature. Operators who need a hard cap on all host traffic can use network
shaping outside VDL.

## Acceptance criteria

- With a 16 Mbps setting, one active URL download can approach the full
  2 MB/s payload allowance. Two or three active downloads share the same
  2 MB/s total rather than each receiving 2 MB/s. A download that becomes
  idle makes its unused allowance available to the others.
- In a deterministic clock test, bytes granted to all jobs over any measured
  interval cannot exceed the selected bytes-per-second rate times the
  interval plus at most one second of burst credit. No single job can starve
  while it has data to read and other jobs continue transferring.
- Fragmented video, separate video/audio streams, retries, resumed transfers,
  and fallback format attempts all draw from the same budget. No enabled
  transfer path bypasses it silently.
- Changing the value during a transfer adjusts aggregate throughput without
  restarting work. Stop interrupts a rate wait promptly; Pause/Resume neither
  leaks tokens nor causes an accumulated burst.
- With `0`, transfer behavior matches the existing unlimited mode. Settings
  persists decimal Mbps values across reloads and restarts; invalid saves
  leave the previous value and other preferences unchanged.
- Progress, speed, and ETA remain coherent with actual transfer. The setting
  does not throttle browser playback, uploads, local imports, or other
  processes on the host.

## Verification

Add deterministic unit tests for shared byte accounting, bounded bursts,
fairness, live updates, cancellation, pause, and Unlimited mode. Exercise
simultaneous URL workers with controlled HTTP and fragmented media fixtures
to measure aggregate payload over time; cover any external downloader path
that remains available with the cap enabled. Extend preferences API and
browser Settings tests for validation, persistence, units, and help text.
Run `./tests/run-all.sh --unit` and verify the required `vdl.py` 90% line
coverage, then run `./tests/run-all.sh --browser` before marking the feature
complete.

## Implementation outcome

Implemented `download_bandwidth.py` with one FIFO token bucket shared by all
managed URL workers. Native HTTP, HLS, DASH, and ISM media responses obtain
allowance before reads; short reads refund unused credit. The controller
supports live changes, interruptible waits, pause, and Unlimited mode.
Extractor requests outside the media downloader remain outside the budget.

External media downloaders report an unsupported-transfer error under an
enabled cap, including HLS that delegates to ffmpeg after reading a manifest.
Private process guards also terminate an already-running external transfer
when a cap is enabled. Local ffmpeg post-processing remains available.
Settings stores canonical decimal Mbps values and validates saves atomically.

Validation: Python 3.12 unit coverage gate passed with `vdl.py` at 91.1%
(required 90.0%); the full Chromium browser tier passed all 206 tests.
