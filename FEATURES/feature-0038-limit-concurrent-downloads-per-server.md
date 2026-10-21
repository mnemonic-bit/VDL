# Limit concurrent downloads globally and per source server

**Source:** User-requested feature  
**Status:** Implemented\
**Implemented:** 2026-10-21 · Version `0.44.0`\
**Last refined:** 2026-10-16

## Decision summary

Let users add URL downloads to the queue without an application-level queue
length limit. Keep the existing maximum concurrent downloads setting as one
global limit across all URL download workers, regardless of user or source.
Add a second setting that limits how many of those workers may run at once for
the same source server. A job starts only when it fits both limits.

The global default remains **3**. The new per-server default is **2**. For
example, with those defaults, two downloads from `video.example` and one from
`other.example` may run together; a third `video.example` download waits.
Users can change both values in Settings.

## Scope and terminology

- A **URL download worker** is a yt-dlp job accepted through the normal URL
  download flow, including companion and playlist URL jobs and resumed jobs.
  Count its initial metadata probe, transfer, and final processing within its
  slot lifetime. A paused worker continues to hold its slots because it stays
  alive with its connection open.
- **Global active count** is the number of URL download workers holding slots
  across all users and source servers. Browser uploads, mounted-file imports,
  thumbnail generation, and the dialog's `/api/probe` request are separate
  work and do not consume these download slots.
- **Source server** means the hostname of the URL submitted for that job. Use
  a case-insensitive, IDNA-normalized hostname without a trailing dot; use a
  canonical address for IP literals. Ignore scheme and port, so HTTP and
  HTTPS URLs for the same hostname share a limit. Different subdomains are
  separate servers. Redirect and CDN hosts discovered later by yt-dlp do not
  change the job's source-server key.
- For an accepted URL that has no usable hostname, use one shared
  `unknown-source` bucket. The existing worker remains responsible for
  reporting whether that URL can be downloaded. An unparseable URL must not
  bypass the per-server limit or break the scheduler.

## Settings

Place two numeric controls together in Settings:

| Label | Preference key | Default | Help text |
|---|---|---:|---|
| Max concurrent downloads (total) | `max_concurrent` | 3 | Maximum URL downloads running across all servers. Additional URLs wait in the queue. |
| Max concurrent downloads per server | `max_concurrent_per_host` | 2 | Maximum URL downloads running from the same source hostname. Additional URLs from that server wait. |

- Both controls accept positive whole numbers starting at 1. Validate on the
  server as well as in the browser; reject zero, negatives, fractions, booleans,
  empty strings, and nonnumeric values with a clear 400 response. A rejected
  save changes neither preference.
- Allow the per-server value to exceed the global value. The effective count
  for one server is then limited by the smaller of the two; saving either
  control must not silently rewrite the other.
- Persist the new preference in the existing preferences table and expose it
  through `GET` and `POST /api/preferences`. Seed the default only when the
  key is absent, so upgrades preserve the existing global value and later
  changes survive restarts.
- Changing either setting takes effect for admissions immediately. Raising a
  limit wakes eligible queued jobs. Lowering a limit does not stop a worker
  already running; it blocks new starts until both active counts fall below
  the new values.

## Queue and scheduling behavior

1. Accept each valid download request and show it in Current downloads even
   when no slot is free. Return the usual accepted response; reaching either
   concurrency limit does not reject the URL or discard its selected format.
2. Before entering yt-dlp, acquire a global slot and the job's source-server
   slot atomically under the scheduler lock. Never briefly exceed either
   configured count, including when several requests arrive together.
3. Keep queued jobs in arrival order. Admit the oldest job that currently fits
   both limits. If the oldest job is blocked by its server limit, another
   server's eligible job may use a free global slot. Preserve FIFO order among
   jobs for the same server.
4. Release both slots exactly once on success, error, cancellation, or setup
   failure, then reconsider waiting jobs. Cancelling a queued job removes it
   before yt-dlp starts. Resuming a cancelled or interrupted job joins the
   queue again with a new arrival position; it cannot jump ahead of waiting
   work from its server.
5. A queued item may continue to use the existing `starting` status, but the
   Current downloads row should say **Waiting for a download slot** rather
   than implying transfer has begun. Keep pause behavior for active workers
   and the existing crash-recovery rule for workers lost on restart.
6. Queue length has no user-facing cap. Accepted waiting jobs must not each
   consume a long-lived blocked worker thread; store their work and dispatch
   it when a slot opens so a large queue does not exhaust process threads.

The limits apply to jobs, not the number of media fragments, HTTP connections,
or extractor requests within one yt-dlp job. They are process-wide settings,
not per-user quotas.

## Implementation touchpoints

- `vdl.py`: add the preference default and API validation; derive and retain
  a source-server key for each queued job; extend the worker scheduler to track
  global and per-server active counts and admit the oldest eligible job.
  Ensure all exit paths release both counts and preference updates wake the
  scheduler.
- `templates/index.html` and `static/app.js`: relabel the existing global
  control, add the per-server control and help text, and load/save its value.
  Show a clear waiting message for queued Current downloads.
- `tests/test_max_concurrent.py`, `tests/test_preferences.py`, and
  `tests/browser/preferences.spec.cjs`: cover admission, fairness, live setting
  changes, cancellation, persistence, validation, and the Settings UI.

## Acceptance criteria

- With global **3** and per-server **2**, submitting three URLs from
  `video.example` and one from `other.example` starts the first two
  `video.example` jobs and the `other.example` job. The third
  `video.example` job waits until one of its server's slots is released.
- With global **2** and per-server **3**, no more than two jobs run in total,
  even when they use different hosts.
- A blocked job for host A does not prevent a later host B job from starting
  when a global slot is free. Jobs for host A keep their arrival order.
- Host matching is case-insensitive, ignores trailing dots, scheme, and port,
  and treats different subdomains separately. A malformed accepted URL uses
  the shared unknown-source bucket.
- Pause retains both occupied slots; queued cancellation uses neither slot;
  completion, error, and active cancellation each free both slots exactly
  once. Resumed jobs obey both limits.
- Increasing either limit can start eligible queued jobs without restarting
  the app. Decreasing a limit allows running jobs to finish and admits no new
  job until the new counts permit it.
- Settings shows and persists both values. Invalid saves return a clear error
  and preserve both prior values. An existing database retains its saved
  global limit and receives the new per-server default.
- A burst of queued URLs remains accepted and visible without creating one
  blocked thread per queued item.

## Verification

Use deterministic blocking yt-dlp fixtures to observe overlap and order for
the two limits, distinct hosts, same-host normalization, preference changes,
pause, cancellation, resume, and every slot-release path. Test the preferences
API and Settings controls. Run `./tests/run-all.sh --unit` and check that
`vdl.py` line coverage meets the required 90% threshold; run the browser tier
for the Settings and queued-row behavior before marking the feature complete.

## Implementation outcome

Implemented a process-wide queue of stored jobs. The scheduler reserves both
slots atomically before starting a worker, skips blocked source hosts, and
retains FIFO order within each normalized hostname. Stop removes queued work;
Continue joins the queue again. Live preference changes reconsider waiting
jobs, while lower limits let current workers drain. Settings persists the
total and per-server limits, and queued rows show their waiting state.

Validation: Python 3.12 unit coverage gate passed with `vdl.py` at 91.1%
(required 90.0%); the full Chromium browser tier passed all 206 tests.
