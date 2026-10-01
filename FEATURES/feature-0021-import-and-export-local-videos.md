# Import local videos by drag-and-drop and export library files

**Source:** User-requested feature  
**Status:** Implemented  
**Last refined:** 2026-10-01

## Decision summary

Allow a user to drag one or more video files from the desktop onto any point in
the application. As soon as a file drag enters the page, show a full-viewport
overlay that makes the entire page an unambiguous drop target, including when
another application dialog is open. Dropping registers each file, copies it
into the configured VDL library, validates it with `ffprobe`, and then presents
it in Download History like media obtained through yt-dlp.

Treat the browser-to-VDL copy as visible work. Register an upload before its
body is transferred so it appears in Current downloads with byte progress and
a `Stop` action. A stopped upload becomes `cancelled` and remains in Current
until the user deletes it. Do not offer Continue for an upload because browser
file access cannot be reconstructed after the original request ends.

Do not invent a requested quality for a local file. Derive safe defaults from
the file itself: use its filename stem as the title, preserve its basename,
record its byte size, and use `ffprobe` to record the resulting video's vertical
resolution when available. Keep `requested_format` and extractor format data
unset because no yt-dlp format was requested.

Give every finished library item a `Download file` action in its three-dot
menu. This is the reverse transfer: it sends the stored media from the VDL
server or container to the user's browser device as an attachment. Reuse the
existing protected playback endpoint and path allowlist so playback and file
download cannot diverge in which stored paths they authorize.

## Terminology and boundaries

- **Import/upload** means copying a file selected through browser drag-and-drop
  from the user's device into VDL's configured server-side download directory.
- **Library** means finished entries shown in Download History and their stored
  media files. In a container deployment, those files live in the mounted
  `/downloads` volume.
- **Download file/export** means sending an already stored library file from
  VDL to the browser as an attachment. It does not run yt-dlp again.
- **URL download** means the existing yt-dlp workflow and remains distinct from
  a local upload through the persisted `source_type` field.

## User experience

### Discovering the drop target

- Listen for file drags at document level rather than on a small dedicated
  drop zone. A video may be dropped anywhere over the application page.
- On file `dragenter`, present a native modal dialog in the browser's top layer
  and size it to the complete viewport. It must cover the page even when the
  New download, Current downloads, or Settings dialog is already open.
- Tell the user `Drop video to add it` and explain that the original file will
  be copied into the library.
- Keep the overlay visible while the pointer moves between descendants inside
  the page. Hide it only when the complete file drag leaves the page or is
  dropped.
- Ignore non-file drags. Do not intercept ordinary text, link, selection, or
  internal element dragging.
- Advertise a copy drop effect while registration is available.
- Respect reduced-motion preferences by disabling the upload pulse animation.

### Dropping and monitoring files

- Accept every file in the drop's `FileList`; register multiple dropped files
  individually and report a filename-specific failure without discarding
  successfully registered siblings.
- Show a short preparing state while registrations are created, then tell the
  user that the uploads can be tracked or stopped from Current downloads.
- Return interaction to the application after registration. The full-screen
  overlay must not remain in front of the UI for the complete transfer.
- Insert each registered file into Current immediately in `starting` state.
- Change it to `downloading` when its body begins arriving and update
  `downloaded_bytes`, `total_bytes`, and the displayed percentage as chunks are
  persisted.
- Use the existing SSE change notifications and `/api/history`
  reconciliation. Do not add frontend polling for uploads.
- Label the byte summary `Uploaded` for local files, rather than `Downloaded`.
- Do not show Pause, Open URL, Copy URL, Reload, or Continue for a local upload.
  Those actions either depend on yt-dlp or imply a source URL that does not
  exist.

### Stopping and removing an upload

- Keep the existing icon-only `Stop` control as the active upload's primary
  action.
- Send the normal `/api/stop/<id>` request first. After the server accepts the
  cancellation, abort the browser's active transfer request for that ID.
- Make cancellation cooperative on the server: check for it before transfer,
  between body chunks, after validation, and before final registration.
- If cancellation arrives while `ffprobe` is running, finish that bounded
  inspection and observe cancellation before committing the library entry.
- Delete any temporary or just-moved file that belongs to the cancelled
  transfer.
- Persist `cancelled`, retain the bytes received so far, and keep the row in
  Current with its existing progress presentation.
- Offer Delete for the cancelled row. Removal deletes its temporary artifacts
  and database row using the existing inactive-row removal path.
- Treat an upload left active by process termination as `interrupted` during
  normal startup recovery. It may be deleted but cannot be continued because
  the browser no longer owns an active request for the original `File` object.

### Completion and History

- After exact byte receipt and successful video validation, move the temporary
  file atomically to a collision-safe final path in the output directory that
  was captured when the upload was registered.
- Mark the row `finished`, set progress to `100%`, and move it from Current to
  Download History through normal reconciliation.
- Display `Source: Local upload` instead of an empty URL.
- Display the event time as `Added`; do not present upload duration as yt-dlp
  download duration.
- Preserve playback, thumbnails, rename, tags, favorites, deletion, history
  pagination, and search for uploaded entries.
- Never overwrite an existing library file. If the basename already exists,
  append ` (1)`, ` (2)`, and so on before the extension.

### Exporting a finished file

- Add `Download file` with the shared download icon to the three-dot menu of
  every finished History item that has a stored filename.
- Support both yt-dlp downloads and local uploads. The action is based on the
  finished stored file, not on `source_type` or the existence of a source URL.
- Start a normal browser download without navigating away from the application.
- Use the current stored basename as the suggested filename. A rename completed
  inside VDL must therefore also change the later browser-download filename.
- Do not show the action for starting, downloading, paused, cancelled,
  interrupted, or error entries.
- A missing file, unknown row, unfinished row, or disallowed path must retain
  the existing 404/403 behavior rather than exposing another filesystem path.

## Persistence and metadata defaults

Add `source_type` through the `init_db()` migration list:

```text
source_type TEXT NOT NULL DEFAULT 'download'
```

Do not modify the initial `CREATE TABLE`; existing databases must upgrade
through the project's normal migration path. Legacy and URL-created rows use
`download`. Locally registered files use `upload`.

An upload starts with the following persisted defaults:

| Field | Value |
|---|---|
| `url` | Empty string |
| `status` | `starting` |
| `progress` | `0%` |
| `title` | Original basename without its final extension |
| `requested_filename` | Validated original basename |
| `filesize` | Size reported by the browser |
| `downloaded_bytes` | `0` |
| `total_bytes` | Size reported by the browser |
| `output_dir` | Absolute configured download directory at registration time |
| `requested_format` | Unset |
| `formats` | Unset |
| `source_type` | `upload` |

On success, replace `filesize` and `total_bytes` with the exact received byte
count, set `downloaded_bytes` to that count, store the final path, and store
`resolution` as `<height>p` when `ffprobe` exposes a positive first-video-stream
height. A valid video without height metadata remains valid with resolution
unset. Quality is never guessed from the filename, extension, browser MIME
type, or a fixed default such as `720p`.

## Upload API contract

Use two requests so Current can display the item before its potentially long
body transfer begins.

### Register an upload

`POST /api/upload` accepts JSON:

```json
{
  "filename": "desktop-video.mp4",
  "filesize": 12345678
}
```

- Require a string filename that reduces to a valid basename and a positive
  integer byte size. A boolean is not an integer size for this contract.
- Strip both slash styles from client paths, including a legacy
  `C:\\fakepath\\` prefix, normalize the basename to Unicode NFC, and reject an
  empty name, `.` or `..`, NUL/control characters, and names too long for the
  collision suffix.
- Validate and create the configured output directory before inserting the
  row. Reject unusable preferences with HTTP 400.
- Return HTTP 202 with the generated upload ID after the database row exists
  and its SSE insert event has been published.

Example response:

```json
{
  "message": "Video upload registered",
  "id": "12ab34cd"
}
```

### Transfer the body

`PUT /api/upload/<id>` accepts the raw file bytes as the request body.

- Return HTTP 404 for an unknown ID.
- Return HTTP 409 when the row is not a local upload, is no longer `starting`,
  is already active, or was cancelled.
- Stream to a uniquely named `.upload.part` file inside the captured output
  directory in bounded chunks. Do not buffer the complete video in memory.
- Reject more bytes than declared immediately and reject an early end after
  the request body finishes. A size mismatch becomes a terminal error and
  leaves no media or partial file behind.
- Publish database and SSE progress after persisted chunks.
- Run `ffprobe` only after all declared bytes arrive. Require at least one
  video stream.
- Return HTTP 415 when the content is not a supported video and HTTP 503 when
  `ffprobe` is unavailable. Persist both as error rows with a useful message.
- Return HTTP 200 only after the collision-safe final move and finished-row
  update succeed.
- Clean temporary and unregistered final paths in every cancellation and error
  path, and release all in-memory worker/cancel state in `finally` behavior.

Uploads use the application's existing same-origin mutation policy. No upload
route may weaken request-origin checks.

## Stored-file response contract

Continue to use:

```text
GET /api/file/<download_id>
```

for inline playback and HTTP Range responses. Add attachment semantics through:

```text
GET /api/file/<download_id>?download=1
```

- Resolve the row only by ID and require `status == finished`.
- Use the row's stored `filename`; never reconstruct it from the current
  download-directory preference.
- Require an existing regular file and apply the existing real-path download
  allowlist before serving it.
- Preserve the stable explicit media MIME map and conditional/range handling.
- With `download=1`, set `Content-Disposition: attachment` and use the stored
  basename as `download_name`.
- Without that exact query value, retain inline player behavior.

The frontend initiates this request from a delegated, data-attribute-based menu
action. It must encode the ID and must not place stored data inside executable
inline JavaScript.

## Container requirements

- The shipping image must contain both `ffmpeg` and `ffprobe`. Installing the
  Debian `ffmpeg` package supplies both binaries.
- Keep the image's existing non-root user, dropped capabilities,
  `no-new-privileges`, read-only application files, and persistent `/data` and
  `/downloads` volumes.
- Container smoke coverage must execute `ffprobe -version`, create a small real
  video with `ffmpeg`, upload it through both API stages, and assert that the
  resulting History row is finished, has `source_type == upload`, and contains
  the probed resolution.
- Native installations continue to require the system `ffmpeg` package so
  `ffprobe` is available outside the container as well.

## Accessibility and responsive behavior

- Implement the drop overlay as a native dialog in the top layer with a polite
  status region. Its title and detail must be text, not icon-only instruction.
- Keep the shared upload SVG decorative.
- Make the overlay exactly viewport-sized at desktop and compact browser
  dimensions without page gaps or horizontal scrolling.
- Ensure light and dark themes use custom properties for the backdrop, border,
  panel, and text colors.
- Disable nonessential pulsing when `prefers-reduced-motion: reduce` applies.
- Render `Download file` as a native button in the existing keyboard-accessible
  menu and retain visible text alongside its icon.
- Closing the menu to start a browser download must not disturb the current
  History card or navigate the application document.

## Security and integrity requirements

- Treat the client filename, MIME type, declared size, upload ID, and stored
  database path as untrusted inputs.
- A browser MIME type or filename extension is not proof of video content;
  successful `ffprobe` video-stream detection is authoritative.
- Reserve final names atomically and serialize the reserve-and-move step so
  concurrent uploads cannot overwrite each other.
- Keep partial files hidden and scoped to the generated upload ID so existing
  cleanup ownership rules can recognize them.
- Never expose an arbitrary request path through upload, playback, download,
  thumbnail, rename, or removal routes.
- Preserve symlink and tampered-row protection for both inline and attachment
  file responses.
- An attachment response must not bypass finished-state, file-existence, or
  allowlist checks already required for playback.

## Acceptance criteria

- Dragging a desktop file over any point on the application displays a
  full-screen `Drop video to add it` overlay.
- The overlay remains the topmost modal layer when New download is already
  open, and its bounds equal the viewport bounds.
- Leaving the page without dropping hides the overlay; dragging text or a link
  does not show it.
- Dropping a valid video creates a Current row before the transfer completes,
  updates uploaded byte progress, and provides a working `Stop` action.
- Stopping an upload changes it to `cancelled`, removes all partial/final media
  owned by that attempt, and allows the row to be deleted from Current.
- A successful upload leaves Current, appears in Download History, plays from
  the stored file endpoint, and can be renamed, tagged, favorited, searched,
  downloaded to the browser, or deleted.
- A local upload shows `Source: Local upload`, uses the filename stem as its
  title, records its actual byte size, and has no requested-format display.
- A video with a known first-stream height shows that probed resolution; a
  valid stream with no height succeeds without fabricated quality metadata.
- Dropping a non-video produces an error row, an actionable validation message,
  and no retained file.
- A missing `ffprobe` produces a clear terminal error rather than accepting
  unvalidated content.
- Uploading a basename that already exists creates a numbered sibling and does
  not alter the existing file.
- Multiple files dropped together are registered separately; failure of one
  does not cancel successful siblings.
- A finished URL download and a finished local upload both show `Download file`
  in their three-dot menu.
- Activating `Download file` triggers a browser download with the current stored
  basename, leaves the app page open, and transfers the stored bytes.
- Inline playback continues to support Range responses and does not receive an
  attachment disposition unless `download=1` is present.
- Unknown, unfinished, missing, symlink-escaped, and tampered external paths
  remain unavailable through both playback and browser download.
- Existing URL download, pause, resume, stop, continue, SSE, history, playback,
  thumbnail, rename, tag, favorite, clear-history, and preference behavior
  remains unchanged.

## Verification

Backend coverage should exercise:

- upload registration defaults and `source_type` migration behavior;
- safe basename reduction and collision handling;
- exact, oversized, undersized, empty, non-video, and missing-`ffprobe`
  transfers;
- byte progress, cancellation, cleanup, removal, and invalid transfer states;
- `ffprobe` JSON parsing with known, absent, and invalid stream metadata;
- attachment disposition, stored basename, Range playback, missing files,
  symlink escape, and tampered paths.

Browser coverage should exercise:

- the viewport-sized top-layer overlay above an existing modal;
- a complete drop-to-History upload with default metadata;
- a held upload in Current, Stop, cancelled state, and Delete;
- the three-dot `Download file` action and its suggested filename.

Container coverage should verify the installed binaries and perform a real
ffmpeg-generated upload/ffprobe round trip.

Run the deterministic suites with:

```bash
./tests/run-all.sh --unit
./tests/run-all.sh --browser
./tests/container/smoke.sh --build
```

## Non-goals

- Do not add a file-picker button, permanent drop zone, frontend framework,
  multipart-upload library, bundler, or polling loop.
- Do not upload directories, remote URLs from a drag payload, subtitles,
  thumbnails, or arbitrary non-video files.
- Do not transcode, remux, normalize, or change the quality of an uploaded
  video. `ffprobe` inspects it; `ffmpeg` does not rewrite it.
- Do not fabricate yt-dlp format metadata or a requested-quality value for a
  local upload.
- Do not support pause or cross-session resume for browser uploads. Stop and
  Delete are the recovery controls.
- Do not overwrite existing library files or infer that equal names contain
  equal media.
- Do not copy a browser-downloaded attachment into another server directory;
  exporting leaves the server-side library file unchanged.
- Do not expose a direct filesystem path, relax the stored-path allowlist, or
  serve unfinished entries to make browser download easier.
