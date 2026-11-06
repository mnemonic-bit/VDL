## 78. [Resolved] Obsolete thumbnail and preview caches accumulate across upgrades

**Severity:** Medium — unused generated files retain disk space and make the
media directory increasingly difficult to inspect. Retained preview MP4s can
cost substantially more space than static JPEGs; wasted bytes have not been
measured in the reported installation.

**Status:** Fixed in version `0.51.3` on 2026-11-06. Originally investigated
against commit `fd91eaf`, version `0.51.2`, with obsolete JPEG retention
reproduced twice in isolated fixtures. The implementation and verification
are recorded below. The reported installation's full file count remains
unverified; its media directories are unavailable in this workspace.

**Related:** [Feature 0042](../FEATURES/feature-0042-use-two-thirds-frame-for-library-thumbnails.md)
introduced versioned static thumbnails;
[Bug 0075](bug-0075-hover-preview-sampling-count-does-not-scale-with-duration.md)
changed the montage recipe;
[Feature 0048](../FEATURES/feature-0048-upgrade-preview-caches-gradually-and-add-system-logs.md)
introduced provenance-backed montage upgrades and retirement.

### Reported and expected behavior

The reporter found approximately four to five thumbnail files per video in
the directory containing media and suspected that changes to thumbnail
generation left obsolete files behind.

A fully generated video normally needs **one current static JPEG and one
current hover-preview MP4**. Old montages may also remain temporarily while
their replacement is unavailable or readers still hold a lease. Multiple
historical cache generations are not all useful current thumbnails.

Confirmed: generating and serving `.vdl_<id>.thumbnail-v2.jpg` leaves
`.vdl_<id>.thumbnail.jpg` beside it, even after maintenance cleanup runs.
The old JPEG is not served as a fallback. Thus one video can permanently
retain two static thumbnails until explicit media removal.

The confirmed JPEG case alone does **not** establish four to five JPEGs per
video. Historical hover-preview MP4s are another plausible contributor if
the reported count includes moving previews. An inventory of that directory
must separate JPEGs, montage MP4s, temporary files, and caches whose download
rows no longer exist before attributing the whole ratio to this bug.

### Evidence and cause

| File family | Current behavior |
| --- | --- |
| `.vdl_<id>.thumbnail.jpg` | Legacy static JPEG; retained after successful v2 replacement. |
| `.vdl_<id>.thumbnail-v2.jpg` | Current static JPEG selected by the thumbnail endpoint. |
| `.vdl_<id>.preview.mp4`, `.preview-v3.mp4`, `.preview-v4.mp4` | Historical montage names found in Git history. Retirement depends on known provenance and a valid replacement; unrecorded files are retained. |
| `.vdl_<id>.preview-v5.mp4` | Current hover-preview montage. |
| Generation temporary files | Normal failure cleanup and recovery exist; not demonstrated as the cause of the reported ratio. |

- [`_thumbnail_path()`](../vdl.py#L5006) selects a version-specific filename.
  [`AssetQueue.register()`](../asset_generation.py#L195) retires obsolete
  `generated_assets` records, but only montage records are transferred into
  the delivery/retirement lifecycle. Old thumbnail files are not removed.
- [`AssetQueue._finish()`](../asset_generation.py#L474) atomically publishes
  the new JPEG and marks its task ready without retiring older JPEG versions.
- [`PreviewMaintenance.cleanup()`](../preview_maintenance.py#L304) operates
  on recorded `preview_deliveries` and montage paths. It does not scan or
  retire legacy JPEGs. Advancing a montage lease deadline cannot fix this
  JPEG case because no JPEG cleanup record exists.
- Existing
  [`test_old_sidecar_is_queued_and_never_served_as_the_new_image`](../tests/test_thumbnails.py#L168)
  explicitly asserts that the old JPEG remains after the new one is served.
  This retention was established behavior, not a random failed unlink.
- [`delete_download_artifacts()`](../vdl.py#L1352) removes both known JPEG
  versions when the media is explicitly deleted. Its row-ID scan also finds
  historical sidecars in the row's known directories. That path does not run
  when a retained video's thumbnail is upgraded.
- The montage lifecycle already removes verified obsolete montages after
  replacement and lease expiry. However,
  [`test_missing_provenance_never_adopts_an_old_named_file`](../tests/test_preview_maintenance_queue.py#L75)
  explicitly retains an old montage when ownership cannot be established.
  Earlier upgrades could discard old queue records before this newer
  lifecycle existed, leaving files outside automatic retirement. Feature
  0048's “Current behavior and the gap” section documents that historical
  limitation. Filename matching alone must not override its ownership guard.

Git history confirms the static cache change in `d67276d` and montage naming
changes in `9def4d4`, `f98e4df`, and `06541f8`. Repeated generation at the same
current path replaces that file; version changes, rather than every normal
generation, explain this demonstrated accumulation mechanism.

### Deterministic reproduction

Run from the repository root with native Python dependencies installed. The
command isolates the import-time database and test media in temporary
directories, mocks frame extraction, and exercises the real HTTP endpoint,
queue publication, and maintenance cleanup. It requires no downloads or
ffmpeg execution and does not access the installation's media database.

```bash
.venv/bin/python - <<'PY'
import os
import tempfile
import unittest
from unittest import mock

with tempfile.TemporaryDirectory(prefix='vdl-obsolete-thumbnail-') as bootstrap:
    os.environ['DOWNLOADS_DB'] = os.path.join(bootstrap, 'bootstrap.db')
    os.environ['DOWNLOADS_DIR'] = bootstrap
    import vdl
    from tests.support.app_case import AppCase

    class ObsoleteThumbnailRepro(AppCase):
        def test_successful_replacement_retires_legacy_jpeg(self):
            self.finished_file()
            entry = vdl.db_get_download('test0001')
            old_path = vdl._thumbnail_path(entry, version=1)
            current_path = vdl._thumbnail_path(entry)
            with open(old_path, 'wb') as image:
                image.write(b'old-frame')

            def generate(_source, destination):
                with open(destination, 'wb') as image:
                    image.write(b'new-frame')
                return True

            with mock.patch.object(vdl, 'generate_video_thumbnail', side_effect=generate):
                self.assertEqual(self.client.get('/api/thumbnail/test0001').status_code, 202)
                self.assertTrue(vdl._get_asset_queue().step())
                response = self.client.get('/api/thumbnail/test0001')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, b'new-frame')
                response.close()
            vdl._get_asset_queue().maintenance.cleanup()
            print('After publication and maintenance:', sorted(
                name for name in os.listdir(self.download_dir) if name.endswith('.jpg')))
            self.assertTrue(os.path.exists(current_path))
            self.assertFalse(os.path.exists(old_path), 'obsolete v1 JPEG remains after v2 publication and maintenance')

    suite = unittest.TestSuite([
        ObsoleteThumbnailRepro('test_successful_replacement_retires_legacy_jpeg')
        for _ in range(2)
    ])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(not result.wasSuccessful())
PY
```

Before the fix: exit status **1**, **2 tests, 2 failures**, in **0.531 seconds**:

```text
After publication and maintenance: ['.vdl_test0001.thumbnail-v2.jpg', '.vdl_test0001.thumbnail.jpg']
AssertionError: True is not false : obsolete v1 JPEG remains after v2 publication and maintenance
```

Both runs use one video, one legacy JPEG, and one successful replacement.
The final assertion expresses the desired retirement behavior and should
turn green when fixed; there is no production-code mutation.

### Controls and limits

Five existing focused tests passed in an isolated run: legacy JPEG retention,
explicit removal of both JPEG versions, failed-generation temporary cleanup,
verified montage retirement after lease expiry, and retention of a montage
without provenance. These distinguish a missing JPEG-upgrade cleanup policy
from generally broken deletion or montage retirement. Abrupt termination and
untracked temporary-file accumulation were not reproduced in this investigation.

The local `media/` directory contained six MP4 files, one partial file, and no
JPEGs or `.vdl_` sidecars. `podman ps` listed no running containers. Therefore
the reporter's actual four-to-five ratio, obsolete-file ownership, and wasted
bytes could not be independently measured here.

### Acceptance criteria

1. Inventory the affected installation read-only, counting current and old
   JPEGs, montage versions, temporary files, and files without matching live
   rows; report counts and bytes separately. Establish how much of the
   reported ratio is expected current assets versus obsolete caches.
2. After successful current-JPEG publication, retire verified obsolete JPEGs
   for that video without requiring media deletion. Failed publication must
   preserve usable existing assets. Repeated requests must not accumulate
   additional files.
3. Provide a bounded, restart-safe way to address pre-existing leftovers,
   including files whose queue metadata was retired by older versions.
   Report files that cannot be safely attributed; do not blindly unlink every
   old-looking filename. Preserve source media, current assets, unrelated
   images, symlink targets, and files outside authorized output directories.
4. Preserve montage fallbacks until valid replacement and reader-lease expiry.
   Keep provenance checks, cleanup retries, source-change protection, and
   rename/removal behavior intact. Distinguish retained fallbacks and blocked
   cleanup from completed retirement.
5. Replace the existing unconditional old-JPEG-retention assertion with
   regression coverage at the publication/cleanup seam. Cover successful and
   failed upgrades, existing leftovers, restart, and unrelated-file retention.
   Before completing a code fix, give it its own version bump and run
   `./tests/run-all.sh --unit`, verifying at least **90% `vdl.py` line coverage**
   under the repository's Python-version guidance.

### Implementation

Version `0.51.3` adds a durable `thumbnail_retirements` journal. Registration
snapshots exact legacy JPEG paths and file identities; successful publication
permits retirement only while the current image is ready and the live source
still matches. Failed publication preserves the old file. Cleanup runs in
bounded batches, persists retry deadlines and blocked reasons, and resumes
after restart without re-encoding. Startup reconciliation also discovers
pre-existing JPEGs whose earlier queue metadata was discarded.

Retirement checks output confinement, the expected sidecar path, source and
cache identities, invalidation, and replacement availability. Symlinks,
source-file hardlinks, changed files, and unrelated images remain intact.
Montage provenance, fallback selection, publication recovery, and reader
leases continue through the existing preview lifecycle. Unrecorded old
montages remain retained rather than being adopted from their names.

`cache_inventory.py` provides a standalone read-only inventory against an
explicit database and output directories. Its bounded JSON pages separate
counts and bytes by cache family and disposition, including fallbacks,
leases, blocked retirement, temporary files, orphans, and unattributable
files. See the README for the command and continuation cursor.

A fresh read-only check of the accessible local installation found nine
database rows, six source MP4s totaling **252,922,086 bytes**, and one partial
download totaling **20,538,319 bytes**. It found **zero JPEG sidecars, montage
sidecars, cache temporary files, or orphan caches** in the accessible media
directory. Other stored media paths point to an unavailable installation;
there are no running Podman containers here. Consequently the reporter's
four-to-five-files ratio and wasted cache bytes remain unverified. No
installation media or caches were deleted during this implementation.

### Verification

The original reproduction now exits **0** with **2 tests passing**. Both runs
retain only `.vdl_test0001.thumbnail-v2.jpg` after publication and cleanup.
The unconditional legacy-retention assertion has been replaced with the
publication/cleanup regression. Additional coverage exercises failed
generation and publication, source changes, filename reuse, restart,
unrelated images, symlinks, source hardlinks, revoked output authorization,
directory swaps during unlink, bounded retry fairness, read-only inventory
pagination, and fallback/lease reporting. Existing montage lifecycle tests
remain unchanged and pass.

Final required run:

```bash
VDL_PYTHON=/tmp/vdl-bug0078-venv/bin/python ./tests/run-all.sh --unit
```

Python **3.12.14**: **456 tests, 7 skipped, all passing**; `vdl.py` line
coverage **92.1% (5244/5692)**, above the **90%** minimum. The skipped tests
belong to the separately enabled real-media suite. Runtime packaging and the
companion build fixture both include the two new cache modules.
