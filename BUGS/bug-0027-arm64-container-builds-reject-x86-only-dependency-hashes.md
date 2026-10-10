## 27. [Resolved] ARM64 container builds reject x86-only dependency hashes

**Severity:** High

**Status:** Resolved in version `0.4.1` on 2026-09-19.

The first GitHub Actions publication run failed while Buildx was building the
`linux/arm64` image. The failure occurred at the Dockerfile's hashed Python
dependency installation, before any image was published to GHCR:

```text
#27 [linux/arm64 stage-1 6/10] RUN python -m pip install --no-cache-dir --require-hashes -r requirements-container.txt
ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE.
```

`requirements-container.txt` was generated only for CPython 3.12 on
`x86_64-manylinux_2_17`, but the publication workflow builds both
`linux/amd64` and `linux/arm64`. Platform-specific wheels have different
contents and therefore different SHA-256 hashes. Pip selects the ARM64 wheel
inside the ARM64 image and correctly rejects it because the lock contains only
the AMD64 wheel's hash.

A deterministic host-side reproduction asks pip to resolve the locked
requirements for CPython 3.12 on ARM64 without needing a complete emulated
container build:

```bash
python3 -m pip download \
    --dest /tmp/vdl-arm64-lock \
    --only-binary=:all: \
    --platform manylinux_2_17_aarch64 \
    --implementation cp \
    --python-version 3.12 \
    --abi cp312 \
    --require-hashes \
    -r requirements-container.txt
```

The first mismatch is Brotli 1.2.0:

```text
Expected sha256 072e7624b1fc4d601036ab3f4f27942ef772887e876beff0301d261210bca97f
     Got        acec55bb7c90f1dfc476126f9711a8e81c9af7fb617409a9ee2953115343f08d
```

The downloaded file is the ARM64 Brotli wheel from `files.pythonhosted.org`;
the mismatch is caused by the incomplete architecture coverage of the lock,
not by a GHCR permission problem or a transient publication failure. Adding
only the displayed Brotli hash is insufficient because other compiled
dependencies may also select architecture-specific wheels.

**Expected:** Generate and review hashes for every supported container
architecture, either in a combined lock that admits the approved AMD64 and
ARM64 artifacts or in architecture-specific locks selected from Docker's
`TARGETARCH`. Add a deterministic check that resolves the complete hashed
dependency set for both platforms so an architecture-incomplete lock fails
before the publication workflow. The resulting multi-platform build must pass
for both `linux/amd64` and `linux/arm64` before either image is pushed.

**Resolution:** `requirements-container.txt` now combines the reviewed wheel
hashes selected for CPython 3.12 on both `manylinux_2_17_x86_64` and
`manylinux_2_17_aarch64`. The lock also admits websockets' universal wheel,
which pip may prefer over its platform wheel. `tests/container/check-lock.sh`
resolves the full hash-checked dependency graph for both publishing targets,
and the validation workflow runs that check before the publish job can start.
