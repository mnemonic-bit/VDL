# Immediate feedback for playlist editor saves

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0031, Playlists](feature-0031-add-personal-video-playlists.md), [Feature 0032, Advanced playlists](feature-0032-expand-playlists-with-import-sharing-and-advanced-playback.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Make `savePlaylistEditor` immediately show **Creating playlist…** or
**Saving playlist…** while retaining the locally edited list. Preserve existing
playlist revision and conflict semantics. A submitted draft is never evidence
that membership, sharing, or playback selection changed on the server.

## User-visible behavior

- Capture a submission generation and show saving at the editor's Save control.
  Suppress duplicate submission of that generation. Keep edits made afterward
  as a separate unsaved draft; do not silently queue whole-list replacements.
- Retain requested title, order, members, and options in the editor while the
  request is pending. Keep the confirmed playlist usable elsewhere. Any shelf
  placeholder for creation is clearly pending, has stable local identity, and
  cannot launch playback or confer sharing access.
- Confirm from the canonical response with SSE unavailable. Map a created
  playlist's local presentation identity to its server ID once. Only clear or
  close the originating editor if its view token and draft generation match.
- On definite rejection, preserve the submitted draft and field errors. On
  conflict, show the current authorized playlist and retain the user's draft
  for comparison. Offer **Use current version** or explicit review/resubmit;
  never automatically overwrite or merge ordered membership.

## State and server contract

Replacement remains serialized per playlist and carries the existing
`expected_revision` with its existing type. Do not convert that revision to the
decimal-string type used by new domains. Creation uses a local editor identity
until the server assigns a stable playlist ID.

Add actor-bound receipts covering canonical creation/replacement in the same
transaction as the write. Bind ordered membership and every submitted option
to the fingerprint. A repeated creation attempt must return the same playlist,
not create a duplicate. A repeated replacement must return its original result
before considering the attempt's now-old expected revision.

All playlist writers, including quick-add and deletion in
[Feature 0056](feature-0056-immediate-feedback-for-playlist-add-and-delete.md),
must preserve the existing revision/conflict boundary. Apply current edit and
member-visibility rules in the transaction. A pending sharing grant enables no
authority. Responses merge only the affected playlist, preserving newer
revisions, shelf ordering, Library rotation, and playback-session ownership.

## Recovery and compatibility

Unknown results retain **Save not confirmed** and block another transmitted
write to that playlist until the parent's recovery rules establish safety.
Offer receipt lookup and deliberate identical-attempt replay once supported.
Receipt absence or a matching list from a GET alone does not prove the outcome.
Conflict resubmission uses a new attempt against the reviewed current revision.

Without receipt capability, retain the existing conflict response and truthful
pending state; do not retry creation after a lost response. Authentication reset
or loss of access clears private editor and recovery presentation.

## Acceptance criteria

1. Held creation/replacement requests show saving immediately. Newer edits,
   reordered members, focus, and closed/reopened editors survive old callbacks.
2. Acknowledgement with SSE blocked confirms once, maps a creation ID once,
   and leaves newer drafts unsaved. Refresh failure cannot undo confirmation.
3. Two clients replacing the same revision produce an explicit conflict with
   recoverable draft and preserved existing revision type, without data loss.
4. A response lost after create or replace, simultaneous duplicate replay, and
   mismatched fingerprints cannot duplicate a playlist or apply a save twice.
5. Race editor save with quick-add, deletion, visibility changes, and logout.
   Old responses cannot resurrect a playlist or enable access or playback.
6. Test ordered membership, imported/shared playlists, keyboard errors, both
   themes, and relevant playback regressions; complete shared verification.
