# Use a two-thirds frame for library thumbnails

**Source:** User-requested feature  
**Status:** Implemented
**Last refined:** 2026-10-20  
**Updates:** Feature 0017, Make download history the primary thumbnail library

## Decision summary

Use a frame at approximately two thirds of a video's duration for its static
thumbnail in the main Library view. For a 90-second video, target about 60
seconds. This replaces Feature 0017's one-second target. Keep thumbnail
generation automatic and keep the existing unavailable artwork when no frame
can be extracted.

The same JPEG is currently served through `/api/thumbnail/<download_id>` to
other places that show a thumbnail, such as playlist pickers and queue rows.
Those places should show the new frame too. This change does not affect hover
preview clips, video playback, or the media file itself.

## Frame selection

- Probe the **stored, finished video file** for a finite positive duration.
  Calculate the seek position as `duration * 2 / 3`, using media time from the
  beginning of that file. Do not use the source website's remote thumbnail,
  the browser player's current position, or a possibly stale duration saved
  in the database.
- Ask ffmpeg for one video frame at that position and retain the existing JPEG
  size and quality settings: at most 480 pixels wide, original aspect ratio,
  and no audio. The position is approximate to the nearest frame that can be
  decoded; no exact-frame guarantee is needed.
- If duration cannot be determined, or the two-thirds extraction produces no
  usable frame, retry at one second and then at the start. This preserves a
  thumbnail for unusual or very short files when possible. A failed attempt
  must not leave an empty or partial JPEG in the cache.
- If no attempt yields a frame, keep the existing unavailable-thumbnail state.
  Thumbnail failure must not change a completed download into an error or
  prevent playback.

## Cache and existing videos

- Generate the new thumbnail when a URL download completes. Continue
  generating on first thumbnail request for finished uploads, watched-folder
  imports, and older rows whose current-version sidecar is absent.
- Existing one-second JPEG sidecars must not indefinitely keep the old image.
  Use a new cache version for the generated sidecar and have the endpoint look
  for that version. On first request after the change, generate the two-thirds
  version from the stored media file. Do this lazily so upgrading does not
  block startup while scanning the whole library.
- Change thumbnail image URLs in the UI to carry the new cache version, so a
  browser with a previously cached `/api/thumbnail/<download_id>` response
  fetches the replacement on reload. Keep the endpoint route and its access
  checks unchanged. If a new image cannot be generated, show the unavailable
  state; do not silently serve the old one-second image as the new version.
- When a video or its library row is removed, delete both the current and
  legacy thumbnail sidecars. Keep sidecars beside the stored media path, even
  if the configured download directory has changed since that video was added.

## Acceptance criteria

1. A finished 90-second video receives a static thumbnail from about 60
   seconds. The thumbnail shown on its main Library card matches the image
   returned by the thumbnail endpoint.
2. A previously cached one-second thumbnail is replaced on first request
   after upgrade; refreshing the Library displays the new image without a
   manual cache clear. Subsequent requests reuse the new sidecar.
3. A missing or invalid duration, a failed two-thirds seek, and a video too
   short for the one-second fallback each follow the fallback sequence and
   either yield a usable frame or show the existing unavailable artwork.
4. Download, upload, and watched-folder import success do not depend on
   thumbnail extraction. Playback and hover previews are unchanged.
5. Thumbnail requests retain the existing finished-entry, visibility, and
   allowed-path checks. Deleting a video removes its legacy and new JPEGs.

## Verification

Add backend tests for two-thirds seek calculation, fallback order, atomic
generation, old-cache replacement, new-cache reuse, cleanup, and path/access
checks. Check the Library card in a browser with an old cached thumbnail and
verify that it fetches the new image after a reload. Run
`./tests/run-all.sh --unit` and confirm `vdl.py` line coverage meets the
required 90% minimum before marking implementation complete.
