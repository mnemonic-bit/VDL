## 44. [Resolved] GitHub Actions had intermittent theme and image-digest failures

**Severity:** Medium

**Status:** Resolved and verified locally in version `0.29.1` on 2026-10-01.
The next image-publication run must confirm the registry-facing workflow change
on GitHub-hosted infrastructure.

Two GitHub Actions runs failed at unrelated timing-sensitive points, making the
overall build appear sporadic. The run associated with the `fix 0041` commit
failed the complete deterministic gate because the Preferences theme test
selected **Dark** but observed **Light**. The run associated with `fix 0043`
published the multi-platform image, then exited with status 255 while resolving
its published digests without printing a useful diagnostic.

### Failure 1: a late Preferences response restored the previous theme

The browser failure reported:

```text
Expected: "dark"
Received: "light"
<html lang="en" data-theme="light" data-theme-pref="system">
```

#### Reproduction

1. Delay a `GET /api/preferences` response.
2. Open **Preferences** while that request remains in flight.
3. Select **Dark** immediately after the form becomes available.
4. Release the delayed response containing the saved `system` preference.

Before the fix, the delayed response populated the form and called
`applyTheme('system')` after the user's selection. The effective theme changed
back to Light on a runner whose emulated system theme was light.

**Actual:** The Settings page accepted edits while one or more preference
requests could still overwrite its controls and active theme.

**Expected:** The form must contain the latest server values before it accepts
edits, and an older overlapping response must never replace a newer response.

#### Diagnosis and resolution

`openSettings()` revealed the page before its asynchronous `loadPreferences()`
call completed. A separate preference load also runs during application
startup, so slow or differently ordered responses widened the race.

Settings now remains hidden until the preference and user requests settle.
Preference loads also carry a monotonically increasing generation; only the
newest request may populate controls or apply the stored theme. A deterministic
browser regression holds the API response, verifies that Settings remains
unavailable, releases it, and then verifies that selecting Dark remains Dark.

### Failure 2: digest parsing could terminate Buildx's output pipe early

The publication step used this pipeline under `set -euo pipefail`:

```bash
docker buildx imagetools inspect "$IMAGE:$GITHUB_SHA" |
    awk '$1 == "Digest:" { print $2; exit }'
```

#### Reproduction

Run a producer that writes a matching `Digest:` line followed by more output,
pipe it through the same early-exiting `awk` expression, and enable
`pipefail`. Once `awk` finds the digest and exits, it closes the read end while
the producer is still writing. The producer can then fail with a broken pipe,
causing the otherwise successful command substitution to fail. In the hosted
run, the step ended with status 255 before reaching its explicit digest
validation message.

Registry propagation presented a second timing boundary: immediately after a
multi-platform push, a registry edge can temporarily return no manifest or an
incomplete index. The former implementation attempted each lookup only once.

**Actual:** Digest resolution depended on two separate registry inspections,
one of which deliberately closed its output stream early. A transient missing
or incomplete manifest also failed the job immediately.

**Expected:** One structured inspection should return the index and platform
digests without an early-closing pipeline. Short-lived registry propagation
must be retried, while a persistent failure must retain a useful diagnostic.

#### Diagnosis and resolution

The workflow now requests Buildx's structured `Manifest` JSON once per attempt
and extracts the index, `linux/amd64`, and `linux/arm64` digests with `jq`.
There is no human-readable output pipeline and no early consumer exit. The
step retries up to six times with five seconds between attempts, validates all
three SHA-256 values, preserves Buildx's standard error, and prints that error
if the bounded retry window is exhausted.

### Verification

- The delayed-preferences regression failed against the old Settings behavior
  and passes with the request-ordering guard.
- The complete browser suite passes all 86 tests.
- The backend coverage gate passes 146 tests with 5 skips and 91.4% line
  coverage.
- The workflow parses as valid YAML, its shell fragment passes syntax checking,
  and its `jq` selectors resolve representative OCI index, AMD64, and ARM64
  digests.
- The complete hosted image-publication path cannot be reproduced locally;
  the next GitHub Actions publication is the final acceptance check for the
  registry-facing portion.
