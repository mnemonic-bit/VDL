# Immediate feedback for server-backed interactions

**Source:** User-requested design specification\
**Status:** Foundation, tags, and Features 0052–0062 favorites, rename, preferences, playlist editor saves, playlist add/delete, download commands, new-download acceptance, uploads, entry removal, bulk clear, and visibility changes implemented; remaining actions staged\
**Last refined:** 2026-11-14\
**Architecture:** [Module responsibilities and implementation design](../ARCHITECTURE/immediate-feedback-for-server-backed-interactions.md)\
**Extends:** [Feature 0001, Tags](feature-0001-add-tags-to-entries.md)\
**Applies to:** Tags, favorites, rename, settings, playlists, download controls,
uploads, deletion, and other interactions whose result depends on the server.

Implementation scope and remaining action adapters are recorded in the
[rollout inventory](../ARCHITECTURE/feature-0051-rollout.md). The observed behavior
section below describes the baseline before this implementation.

## Decision summary

Every user action must receive immediate, local feedback. Reversible metadata
edits should also display the requested result immediately, with a visible
pending state. Server commands should immediately display that the request is
being sent, without claiming that the command has succeeded or completed.

For tags, Enter immediately turns the draft into a chip. A small spinner
occupies the chip's existing remove-button position until the server confirms
the save. The input remains ready for the next tag. A collection refresh,
another edit, or closing and reopening Info must not make that chip disappear.

Implement this through a shared mutation coordinator and a shared client state
store. Keep confirmed server state, pending user intent, and editor drafts
separate. Render their combined presentation instead of changing server
snapshots in place or saving a whole-object backup for rollback.

Use canonical mutation responses to confirm edits immediately. SSE remains a
reconciliation hint for other clients and background changes; an SSE connection
is not required for a successful save to become visible. Add server revisions
and durable mutation receipts for endpoints that adopt the protocol. These
solve different problems: revisions prevent stale writes and stale rendering;
receipts identify the outcome of a particular request after a lost response.

This is a design and rollout specification, not a claim that all interactions
can safely predict their final result. The acceptance tests below define the
required guarantees under explicit failure and race scenarios.

## Observed behavior and cause

The inspected baseline is the current repository, not the older line counts in
the generated project overview. Relevant implementation points are:

| Area | Current behavior and source |
| --- | --- |
| Tag submission | `static/app.js`: `bindTagEditors()` calls `tagCommit()`, which clears the draft and live input before sending the request. There is no pending chip. |
| Tag response | `vdl.py`: `download_tags()` returns `tags`, `available_tags`, and `changed`; `mutateDownloadTag()` discards that data and returns a boolean. |
| Tag persistence | `db_add_download_tag()` validates and normalizes the name, writes under `_db_lock`, and publishes a `change` hint after commit. |
| Reconciliation | `connectEventStream()` calls `scheduleFetch()`, which batches changes for 150 ms. `fetchHistory()` reads Library and Current Downloads. The save callback also calls it. |
| Collection coordination | `coordinateRefresh()` coalesces concurrent reads and waits 150 ms before a dirty follow-up read. This reduces load but is unsuitable as the acknowledgement path for a local action. |
| Other edits | Favorites and visibility also depend on a later refresh; rename disables the editor until the request completes. Starting or stopping tag and rename editing can itself cause collection reads. |
| Existing precedents | Probe generations and download-dialog session checks already protect newer drafts from old callbacks. Playlist replacement already checks `expected_revision`. |
| Pending visual | `templates/index.html` and `static/styles.css` provide `.options-spinner` for metadata loading, with theme variables and reduced-motion support. |
| Security | `reject_cross_origin_api_mutation()`, authenticated sessions, `_visible_download()`, and operation-specific permission checks already exist. They must remain authoritative. |

The disappearance was reproduced by executing the real `tagCommit()` code with
the mutation response held pending: the input and draft are both empty while
the POST is unresolved. This establishes the local feedback defect. It does
not measure production database, network, or rendering latency.

The current clearing comment addresses a real race: reconciliation can otherwise
restore text that was submitted. Keep that protection by transferring the draft
to a pending intent atomically, rather than clearing it without a replacement.
Preserve the event-handling fixes documented in
[Bug 0046](../BUGS/bug-0046-info-tag-selection-closed-popover-and-escape-exited-fullscreen.md).

## Scope and action policies

One shared lifecycle does not mean one visual policy for all actions. Each
registered action must declare its policy, conflict domain, affected views,
permission requirements, and recovery contract before conversion.

| Interaction | Immediate presentation | Server acknowledgement and limits |
| --- | --- | --- |
| Add tag | Chip appears with spinner in remove slot. | Canonical spelling and identity replace provisional presentation; spinner becomes remove button. |
| Remove tag | Chip remains in place with pending-removal styling and spinner; it is immediately excluded from the effective tag set. | Remove the chip after confirmation; restore ordinary styling on rejection. This keeps its status and failure location visible. |
| Favorite | Star changes immediately and shows adjacent pending feedback. | Confirm the explicit boolean; failure removes only this intent. Preserve card order. |
| Rename | Show requested display name with pending feedback; preserve the current playback and file identity. | Only the server can supply the final filename/path. Filesystem recovery is required before receipt-based retries are enabled. |
| Settings | Keep edited controls responsive; mark the submitted values as saving and retain newer drafts. | Do not announce saved settings or apply sensitive/server-wide effects before acknowledgement. A theme preview may remain local. |
| Playlist edits | Retain the user's locally edited list and show saving state. | Use the existing revision conflict semantics; never silently overwrite a concurrent playlist edit. |
| Pause, resume, stop, retry | Show “Pausing…”, “Resuming…”, “Stopping…”, or “Starting…” immediately at the initiating control. | Request acceptance and worker transition are separate. Preserve the server's download status vocabulary. |
| New download, upload, background job | Show a local pending request or transfer immediately. | Map any temporary presentation ID to the server ID. Do not claim completion, invent usable files, or start playback from a placeholder. |
| Remove entry, clear history/library, delete user | Retain a marked pending row or confirmation surface; prevent duplicate submission. | Do not claim that files, accounts, or rows have been deleted before confirmation. Existing confirmations remain. |
| Visibility, roles, suspension, credentials, connection revocation | Show the requested change as pending beside the last confirmed security state. | Do not announce “private”, “revoked”, or “permissions changed”, or enable newly permitted actions, until confirmed. |
| Copy, open/close editor, menu, search, local playback controls | Perform immediately using local state. | Do not add a server dependency to a local interaction. |
| View counting, playback progress, asset demand/leases | Preserve existing batching, sequences, and lease semantics. | Use the shared error/epoch rules where applicable; do not add a spinner or one request per playback tick. |

Initial delivery includes the shared foundation and complete tag behavior.
The remaining actions are a staged migration, not assumed complete when tags
ship. Unsupported actions retain their existing server contract and get truthful
pending feedback; they must not inherit automatic retries from the new system.
This feature does not introduce offline editing or an offline write queue.

## User-visible contract for tags

### Add and confirm

1. Enter, comma, or selecting a suggestion validates the draft locally where
   possible and creates one pending intent. Blank input does nothing.
2. In the same synchronous state transition, clear the submitted draft and
   insert its chip. Render before awaiting network activity. Starting and
   stopping editing also render locally rather than calling `fetchHistory()`.
3. Use the metadata spinner's appearance, scaled to the remove slot. Reserve
   the same slot size for spinner, remove button, and error affordance so the
   chip does not shift horizontally. The chip label remains fully legible.
4. A pending chip has no active remove button. Other settled chips remain
   removable. Typing and submitting another tag remain possible; submissions
   queue rather than being silently dropped by a per-entry pending flag.
5. On an acknowledged save, atomically merge canonical server state, retire
   this intent, and replace its spinner with the remove button. There must be
   no render between removing the intent and accepting the server state.
6. In display mode, ordinary chips still omit removal controls. Pending/error
   status remains visible even after leaving edit mode or reopening Info.

Retain chip positions throughout the active edit session, including when a
provisional chip becomes confirmed. Apply ordinary tag sorting after editing
ends. A server acknowledgement must not move the user's next input or a remove
target that they are about to activate.

Submitting an already attached canonical tag creates no second chip or write.
Repeated Enter for the same pending tag creates no second intent. Choosing a
suggestion does not close Info. Escape discards only the current unsubmitted
draft; it neither cancels an in-flight save nor exits application fullscreen.
Backspace in an empty input targets the immediately preceding chip. If that
chip is pending, announce its pending state and do nothing; do not unexpectedly
remove a different chip farther left.

### Failures and continued typing

- A definite rejection turns the provisional chip into a compact failed-save
  chip with a visible error affordance in the same slot. It is excluded from
  the effective saved/pending tag set. Show an inline explanation and actions
  to edit, retry after correction, or dismiss it. Preserve the submitted text
  until the user resolves it; never replace a newer input draft with old text.
- Editing a failed tag moves it into the input only if the draft is empty.
  Otherwise retain both and ask the user to finish or clear the newer draft.
- A network error, request timeout, malformed success response, or generic
  server error can leave the outcome unknown. Keep the chip visible with
  “Save not confirmed” and a check/recovery action; do not label it unsaved or
  silently roll it back. After five seconds, replace indefinite spinner-only
  feedback with explanatory text. Time passing is not evidence of failure.
- A known committed save followed by a failed collection refresh stays saved.
  Report refresh failure separately. Do not restore its submitted draft.
- Closing Info does not abort or forget an intent. Reopening shows its current
  state. A callback must not reopen a closed dialog or steal focus from another
  field. Focus restoration requires a still-current view token.

For removals, retain the chip while pending so a failed or unknown removal has
a stable place to report its state. Queued additions and removals are projected
in order. A failed removal restores membership from the current confirmed
state; it does not restore a historical copy of the whole tag list.

### Consistent views and accessibility

All views of the same entry use the same projected tag state: Info, Current,
Library cards, relevant playlist displays, and local search. Pending additions
and removals affect local matching immediately. Preserve the actively edited
card and its current position until its edit session ends, even if its updated
tags would filter it out. Then apply current filter criteria once. Do not pin
an entry after authoritative deletion or access loss.

Pending tags may appear in this client's suggestions as pending. They must not
appear as confirmed global vocabulary, change other clients' filters, reorder
Library rotation, or alter server playback selection before confirmation.

Provide accessible status text such as “Saving tag Music” and “Could not save
tag Music”. Decorative spinners are hidden from assistive technology. Use a
small status region outside busy content, deduplicate announcements, and avoid
announcing every animation frame or blocking the entire editor with `aria-busy`.
Honor reduced motion, light/dark themes, keyboard focus, and touch targets.
Make retry/error actions available without relying on hover, tooltip, or color.

## State model and invariants

The following are client coordination terms, not new download statuses:

| Term | Meaning |
| --- | --- |
| Confirmed state | Last accepted, authorized server representation for a resource domain and its revision. |
| Intent | A user's requested operation, with a stable local identity and submission order. |
| Mutation attempt | One immutable HTTP request for an intent, identified by a mutation ID. A deliberate conflict retry uses a new attempt. |
| Draft | Unsubmitted text or form values, owned by an editor session and draft generation. |
| Projection | Confirmed state with eligible pending intents applied in submission order, plus presentation status. |
| Conflict domain | Smallest resource whose operations must be serialized and version-checked together, such as an entry's tag set. |
| Receipt | Server record of a specific mutation attempt's committed or rejected outcome. |
| View token | Editor/dialog identity and generation used to decide whether a callback may affect focus or drafts. |

Required invariants:

1. Confirmed snapshots never contain provisional client edits.
2. A pending intent survives collection refreshes and is applied exactly once
   in a projection. Repeated renders do not repeat a mutation.
3. State and revision always describe the same server snapshot. Lower revisions
   cannot replace higher ones, regardless of response arrival order.
4. Retiring a successful intent and merging its acknowledgement is atomic. A
   later, already accepted revision remains authoritative over an older receipt.
5. Rejecting one intent removes only its contribution. It cannot undo a later
   intent, another field's change, or another client's confirmed edit.
6. Neither an uncorrelated SSE event nor matching snapshot contents proves that
   a particular request committed. Only an acknowledgement/receipt does that.
7. Access loss or deletion overrides optimistic state. A pending intent never
   creates authority, restores an inaccessible entry, or supplies a file path.
8. Each resource domain has at most one transmitted, unsettled mutation attempt
   from this client. Unrelated domains and entries remain responsive.
9. New drafts and newer editor sessions are never overwritten by old callbacks.
10. A success response for request acceptance does not mean a background task
    has completed. Pending communication and task progress remain distinct.

Do not implement rollback by assigning `previousEntry`, `previousTags`, or an
entire previous collection. Always recompute projection from current confirmed
state and the remaining intents.

### Mutation lifecycle

| State | Meaning and permitted transition |
| --- | --- |
| `queued` | Intent is visible but not transmitted. It may become `sending` or be discarded locally. |
| `sending` | One immutable attempt is in flight. It may become `confirmed`, `rejected`, `conflicted`, or `unconfirmed`. |
| `unconfirmed` | The response does not establish an outcome. Keep its presentation and pause its domain; receipt recovery may establish a terminal outcome or replay the identical attempt. |
| `conflicted` | The server definitely declined the expected revision. Show current authorized state; explicit retry makes a new attempt. |
| `rejected` | The server definitely declined the edit, for example invalid input. Preserve recoverable text; correction creates a new intent/attempt. |
| `confirmed` | A valid acknowledgement or receipt establishes commitment. Remove pending presentation atomically with the versioned merge. |
| `resolved` | User discarded an unsent/failed intent or explicitly accepted current state after checking an uncertain result. This does not manufacture a committed receipt. |

Permission denial and unavailability also fence the resource and suppress its
private projection. Classify an error as definite only when the endpoint's
documented response guarantees that this attempt did not commit. HTTP status
alone, especially a proxy-generated 5xx, does not provide that guarantee.

For scalar actions such as favorite changes, capture an explicit desired value
from projected state when the user acts. Never queue a bare “toggle” to be
evaluated later against whatever value the server then holds. Initially preserve
FIFO intent order rather than silently coalescing opposite submitted actions.

## Shared modules and integration seam

Use two deep modules with a small interface: a client state store and a mutation
coordinator. They can be plain JavaScript IIFEs in separately loaded scripts,
with browser globals and no bundler, framework, import/export, or transpiler.
Load them before `app.js`; inject transport, clock, and render notification
dependencies so deterministic tests exercise the same interface as the app.

Illustrative caller interface:

```javascript
const submission = mutations.submit({
    kind: 'tag.add',
    targetId: downloadId,
    value: draft,
    viewToken: currentEditorToken,
});

const model = clientState.selectDownload(downloadId);
const status = submission.accepted ? mutations.status(submission.intentId) : null;
```

`submit()` synchronously returns an admission result, recording accepted intent
and scheduling local presentation. A declined submission retains the draft;
admission does not claim persistence. Action descriptors inside the coordinator
own validation, projection, serialization domain, endpoint construction,
response decoding, version merging, and recovery. Callers must not provide
arbitrary endpoints, executable server data, or custom rollback callbacks.

Collection adapters pass authorized snapshots into the store. UI renderers read
the projected model rather than reading and mutating `collectionSnapshots`
directly. Draft editing and focus remain UI concerns keyed by view tokens.
The coordinator publishes affected-resource notifications; it does not own DOM
nodes. Use stable keys for tag/editor nodes and patch the relevant controls.
Pending state must not live in a button's `disabled` property or a detached DOM
node. Existing retained-node reconciliation can remain behind this seam.

Keep action-specific semantics in descriptors rather than growing a universal
“optimistically set any property” helper. Tags, favorites, and server commands
are real distinct uses of the shared lifecycle and test seam.

## Queueing and conflict behavior

Use `(entry ID, tags)` as the tag conflict domain. Serialize all tag writes for
that entry, while projecting every queued intent immediately. Other entries
and unrelated metadata domains may proceed concurrently. Queueing must have a
finite limit: initially 32 unresolved intents per domain and 128 per page.
On reaching a limit, keep new text in the input and explain why submission is
temporarily unavailable. Do not silently drop or overwrite it.

When an intent reaches the queue head, capture the latest confirmed domain
revision and freeze its mutation attempt. Do not send an unsent successor until
the head is acknowledged, definitively rejected, or explicitly resolved.

For a definite validation rejection, retain the failed chip, remove that
intent's projection, and continue independent tag intents. For revision conflict
or unknown outcome, pause that domain's transmitted queue. Later submitted
chips stay visible as queued, and the user can discard unsent intents. An
in-flight attempt cannot be canceled by deleting its local record.

On a revision conflict, read the latest authorized domain state and present
the conflict with retry/dismiss controls. An explicit retry creates a new
attempt using the new revision and the user's still-current intent. Never
silently resend a whole stale list. For initial delivery, do not automatically
rebase conflicts, even for seemingly disjoint tag changes. A future adapter may
opt into a proven commutative operation contract with its own tests.

If another client has already achieved the requested result, the user may
resolve the intent as satisfied by current server state. That is convergence,
not a fabricated receipt for this client's failed or unconfirmed attempt.

An unconfirmed attempt needs an additional safety check before such resolution
unblocks its domain. A matching read alone cannot rule out a request still in
transit. Unblock only after a receipt establishes the outcome, a newer domain
revision makes the original expected revision unusable, or the replay window
has expired and a server recovery check serialized behind admitted writes
establishes that no original attempt can still commit. Otherwise keep the
attempt tracked and the domain paused, even if its detailed error is dismissed.
Explicit resolution never means that a transmitted request was canceled.

## Server protocol

### Canonical domain snapshots and revisions

Add persistent, monotonically increasing revisions for each adopted conflict
domain. Tags and favorite state need independent revisions; download progress
must not invalidate tag edits. Playlist editing retains its existing revision.
Allocate additional domains only when an action is migrated. Add columns using
`init_db()` migrations, never by changing the original `CREATE TABLE`.

Every writer, including legacy routes, cleanup, imports, background work, and
administrative paths, must advance the relevant domain revision when it changes
that domain. No-op set operations return the current revision. Reads return
domain values and revisions in one explicit, consistent read transaction;
several unrelated SELECTs without a shared snapshot are insufficient.

Expose revisions as decimal strings for new domains; comparison is numeric
inside the store, never lexical or based on client timestamps. A receipt
includes the revision of its result, even if a newer revision now exists.
Persist revisions across process restarts. Never reuse a deleted resource ID.

New clients send an `expected_revision` for the affected domain. Check it and
write within the same transaction, returning a structured 409 conflict if it
does not match. This follows the existing playlist convention. HTTP `If-Match`
is a valid future alternative, but do not use both independently for one action.
Conditional updates address lost writes; they do not by themselves prevent
old reads from being rendered. See [HTTP conditional request semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1).

Provide an authorized targeted read at
`GET /api/downloads/<id>/editable-state`, returning only registered editable
domains, their revisions, and presentation permissions. It must distinguish an
authorized entry from an unavailable entry without exposing private existence.
It does not return unrestricted filesystem or credential data.

Library, Current, and relevant item responses must include the adopted domain
revisions, using the same serializer. Keep existing response fields for older
clients. Capability negotiation determines whether the new coordinator may use
an endpoint; absent capabilities use conservative pending feedback. Never
invent a revision or fake the new guarantees against an old server.

### Example tag request and acknowledgement

Retain `POST /api/tags/<id>` and `DELETE /api/tags/<id>`, adding the new fields
for clients that opt into the mutation protocol:

```json
{
  "tag": "Music Videos",
  "client_mutation_id": "<time-and-randomness operation identifier>",
  "expected_revision": "42"
}
```

Successful response, with existing fields retained:

```json
{
  "id": "video-id",
  "tags": ["Music Videos"],
  "available_tags": ["Music Videos", "Tutorial"],
  "changed": true,
  "mutation": {
    "id": "<same identifier>",
    "outcome": "committed",
    "domain": "tags",
    "revision": "43"
  },
  "tag_items": [{"key": "music videos", "name": "Music Videos"}],
  "submitted_tag": {"key": "music videos", "name": "Music Videos"},
  "tag_identity_version": "<server identity rules version>"
}
```

The returned tag set and revision are the committed result. Only merge the tags
domain; a tag response must not overwrite unrelated download progress, favorite
state, or visibility. `submitted_tag` correlates provisional presentation with
canonical identity even when spelling changes or no new attachment was needed.
The coordinator validates the echoed mutation ID, target, domain, shape, and
revision before consuming a response. An inconsistent 2xx response is an
unknown outcome requiring recovery, not permission to discard pending state.

`available_tags` is an authorized convenience snapshot. It has no independent
ordering guarantee in the current API. Do not allow a delayed tag acknowledgement
to overwrite a newer vocabulary snapshot. Initially invalidate vocabulary and
rebuild it from accepted authorized entry data, retaining pending suggestions
separately. If a complete vocabulary endpoint is added, give it its own snapshot
version and permission filtering rather than using any entry's tag revision.

### Tag identity and validation

Retain whitespace normalization, Unicode control-character rejection, the
64-character limit, comma rejection, case-insensitive identity, and the first
created spelling. The server remains authoritative. Escape provisional labels
just as carefully as server-supplied labels; saving them first is not a security
boundary.

Do not use `toLocaleLowerCase()` as a substitute for Python `casefold()` when
deduplicating intents or merging pending chips with server state. For current
clients, provide a versioned tag-identity helper with parity against the
server's normalization rules, including Unicode whitespace, code-point length,
and case folding. A checked-in generated data/helper asset is acceptable; it
must not add a frontend build step. Known tags also carry their server identity
keys. Version the helper against the server's Unicode/identity rules and test
non-ASCII cases. A mismatched client must use compatibility feedback until it
refreshes; it must not guess identities and falsely confirm or remove a tag.
Input limits must use the same character-count rule as the server; native HTML
`maxlength` must not inadvertently reject an otherwise valid non-BMP tag.

Canonical keys reconcile duplicate spellings to one chip. Retain stable intent
and DOM identities through that merge so neither SSE-before-response ordering
nor normalization briefly displays two copies of the same tag.

### Durable receipts and safe recovery

For adopted database edits, persist a receipt in SQLite in the same transaction
as the mutation and its revision. Key it by authenticated actor and mutation ID;
bind it to the method, registered action, target, normalized request payload,
and expected revision using a deterministic fingerprint. Keep transaction and
lock ordering consistent with existing database code.

- Repeating an identical attempt returns its recorded outcome without applying
  it again. Check for a matching receipt before checking the now-old revision.
- Reusing an ID with a different fingerprint returns a conflict without a write.
- Concurrent duplicates cannot execute twice. The receipt and data commit or
  roll back together. A post-commit SSE publishing failure must not undo or hide
  the receipt.
- Definitive validation/conflict outcomes may also have receipts; transport or
  infrastructure errors must not fabricate a definite rejection.
- Add `GET /api/mutations/<mutation-id>` for the current actor's outcome. Check
  current session and target authorization before returning any resource data.
  Unknown/foreign IDs have indistinguishable unavailable responses. A missing
  receipt is not evidence that the original request never reached the server.

Bound replay and storage explicitly. The identifier includes a creation time
and at least 128 bits from `crypto.getRandomValues()`; this is correlation, not
an authorization credential. The server accepts new attempts at most 24 hours
old and at most five minutes in the future. Retain terminal receipts at least
48 hours after recording; never expire an active job's acceptance record while
the job still needs it. Validate age when admitting a new attempt inside the
serialized write transaction. Use server time to correct client clock skew.
An expired attempt cannot be recreated by replaying its old identifier after
receipt cleanup. Bound request sizes, admission rates, and per-actor outstanding
work; reject new work rather than evicting unexpired receipts.

On unknown outcome, perform a bounded receipt lookup. If unresolved and within
the replay window, offer recovery of the exact same immutable attempt and ID;
recovery must pass through the receipt contract. Do not create a new mutation
ID for a transport retry. Default to no automatic mutation replay; a descriptor
may opt in only after its receipt behavior is tested. Never apply the GET retry
loop in `apiFetch()` to mutations. HTTP cautions against retrying non-idempotent
requests without a way to establish safe repetition; see
[HTTP retry semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2).

After the replay window, offer an authorized state check and explicit resolution
of the retained intent, not replay of an expired attempt. Never issue a fresh
destructive command merely because its earlier acknowledgement was lost.
No continuous polling is introduced: use one bounded recovery check on a lost
response/reconnect, with further checks or replay initiated by the user.

Database receipts alone cannot atomically cover a filesystem rename or an
external process launch. Such descriptors require a durable acceptance/job
record and operation-specific crash recovery before replay is enabled. The
coordinator does not promise exactly-once external side effects. An accepted
job returns a job ID and “accepted” outcome; job progress and terminal status
remain server-owned and reconcile independently.

The expired-attempt recovery check must share the write serialization seam:
wait behind any attempt already admitted, check its receipt, and only then
report that an absent expired attempt can no longer be admitted. Ordinary
unlocked GETs cannot establish that finality. If a receipt says a job was
accepted, report the job's current status instead of treating its request
expiry as job cancellation.

## Reconciliation and response ordering

The normal tag path becomes:

```mermaid
sequenceDiagram
    participant U as User
    participant C as Coordinator and state store
    participant S as Server
    participant D as SQLite
    U->>C: Commit draft
    C->>C: Record intent and render chip with spinner
    C->>S: Submit queue head with ID and expected revision
    S->>D: Authorize, check receipt/revision, mutate, record receipt
    D-->>S: Atomic commit
    S-->>C: Canonical domain result and receipt
    C->>C: Merge result and retire intent atomically
    C-->>U: Chip stays visible; remove button replaces spinner
    S-->>C: SSE invalidation hint, possibly arriving earlier
    C->>S: Coalesced reconciliation read
    S-->>C: Authorized snapshot with revisions
    C->>C: Merge newer state and reapply remaining intents
```

The diagram shows one possible arrival order. The contract must support all of
these without visual rollback:

| Ordering/failure | Required handling |
| --- | --- |
| Old GET completes after local submission | Merge its eligible confirmed values; retain the pending projection. |
| Old GET completes after save acknowledgement | Reject lower domain revisions. No disappearance or rollback. |
| SSE/read observes committed tag before POST response | Merge confirmed state, coalesce the chip by canonical key, retain its unconfirmed status until the receipt arrives. |
| A newer remote edit is known before an older successful acknowledgement | Retire the acknowledged intent, preserve the newer state, and explain any conflicting remote change. Do not restore the old receipt's data. |
| A succeeds, B remains queued | Confirm A while keeping B visible as pending; dispatch B against the latest confirmed revision. |
| A fails while B is queued | Remove only A's projection. Retain A's recoverable text and B's intent. Continue B only if the failure is definite and independent. |
| SSE is lost, duplicated, coalesced, or disconnected | POST acknowledgement still confirms locally; later focus/reconnect reconciliation converges. |
| Acknowledgement received, later GET fails | Keep acknowledged state; show a collection refresh error separately. |
| Target deleted or access revoked during save | Purge the target's pending projection and private presentation; stop further writes. Old callbacks cannot resurrect it. |

Collection membership is a separate concern from field values. An item absent
from a page, a filter result, or a rotation is not necessarily deleted or
inaccessible. Use collection request generations for membership and ordering,
and use domain revisions for item fields. Mutation responses do not insert an
entry into a rotation or rewrite its order. Resolve ambiguous absence through
the targeted authorized read, rather than retaining optimistic ghosts forever
or dropping valid pending edits.

Invalidate in-flight collection membership reads when a confirmed local action
changes membership. During a pending destructive action, its explicit pending
row/tombstone prevents a stale GET from reviving ordinary controls. Known
unavailability creates a local removal fence: responses launched before that
fence cannot restore the entry. A later authorized targeted read may restore it
if access legitimately returns. Do not confuse this presentation rule with a
guarantee that already delivered data can be remotely erased.

Keep the 150 ms batching for background hints; local presentation and valid
acknowledgement merging bypass it. Prefer affected-resource reconciliation to
fetching every collection, playlists, and storage usage for each tag edit. A
single post-batch reconciliation remains acceptable for derived views.

## Security requirements

Immediate presentation changes must never weaken server checks. The design
follows [OWASP's requirement to authorize every request](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html#validate-the-permissions-on-every-request):

1. Authenticate and authorize original writes, conflict reads, receipt lookups,
   and receipt replays. A mutation ID, cached permission, or pending chip grants
   no access. A replay after revocation must not return cached private payloads.
2. For each adopted database mutation, recheck target visibility and applicable
   edit permission inside the serialized transaction before writing. Resolve
   current actor suspension, session version, and roles for that check rather
   than relying on an earlier cached `g.current_user` value. An earlier
   route-level `_visible_download()` check alone must not authorize a write
   after a concurrent visibility change. Preserve existing product permissions:
   this feature does not silently introduce owner-only tagging or broaden edits.
3. Preserve existing Origin/Fetch Metadata protection, authenticated cookies,
   JSON validation, and narrow companion-origin handling. New mutation routes
   must pass the same guards; do not add permissive CORS for the coordinator.
   These remain separate from presentation logic; see
   [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
4. Treat all draft, tag, filename, status, and error strings as untrusted text.
   Prefer `textContent`; where existing templates remain, use the appropriate
   HTML/attribute escaping. Do not interpolate user strings into executable
   inline handlers or CSS selectors. Server-provided action names cannot select
   arbitrary client functions. See [OWASP frontend output guidance](https://cheatsheetseries.owasp.org/cheatsheets/Web_Frontend_Security_Cheat_Sheet.html#use-safe-functions).
5. Keep pending edits and recoverable text in memory, scoped to the current
   authenticated page. Do not store them, private entry payloads, or receipts
   in localStorage, IndexedDB, URLs, analytics, or service-worker write queues.
   On 401/logout/account change, clear state and queued work, advance the client
   authentication epoch, and ignore callbacks from the previous epoch. Do not
   replay one account's operations after another account signs in.
6. Permission changes have conservative presentation. A pending “make private”
   request still shows that server-confirmed visibility is public. A pending
   grant cannot enable privileged controls. Every resulting server operation
   independently checks current authorization.
7. SSE hints must not disclose unauthorized IDs, tag text, mutation IDs, or
   receipt contents. Existing tag changes publish a broadly distributed ID
   hint; do not expand that into broadcast data-bearing acknowledgements.
   For the converted tag path use a generic collection invalidation hint, or
   filter recipients using current authorization. A client losing visibility
   can receive a generic invalidation without private entity data. Keep receipts
   and canonical acknowledgements on authenticated request/response paths.
8. Recoverable errors must not expose SQL, raw filesystem paths, credentials,
   cookies, or other users' records. Log action kind, outcome, timings, and an
   appropriately scoped correlation ID; omit raw draft and tag values.

The client's projections improve usability; they are neither a security
boundary nor a substitute for permission checks. Revisions and receipt IDs
also confer no authority.

## Lifecycle, limits, and operational behavior

- A queued intent may be discarded before transmission. Once sent, aborting a
  fetch only stops waiting; it does not prove that the server canceled the edit.
- Page reload does not persist or replay intents. Fetch authoritative state on
  the new page. An already submitted server request can still finish. Offer the
  browser's ordinary unsaved-work warning while unresolved edits or drafts
  exist, where supported, rather than promising cancellation on navigation.
- Reconnect/focus uses existing reconciliation hooks plus at most one receipt
  recovery check per unresolved attempt. Bound recovery concurrency and reads;
  deduplicate repeated hints. No polling loop or reconnection write storm.
- Unknown outcomes pause their conflict domain, with visible resolution actions;
  they do not freeze the application. Closing an error message does not mark an
  unresolved request successful. Keep a compact pending/error summary when
  its originating surface is closed.
- Clean settled coordinator entries and subscriptions when no view/recovery
  record needs them. Enforce queue/receipt quotas without dropping active work.
- Reuse theme properties and the spinner animation. Limit rendering to affected
  nodes and status announcements. Local input must not wait for a collection
  read, animation timeout, or a minimum spinner duration.

## Alternatives considered

| Alternative | Reason not chosen |
| --- | --- |
| Add spinner but leave a blank input until SSE | Communicates waiting but does not meet immediate tag visibility. |
| Retain submitted text in the input until save | Avoids disappearance but blocks continued typing or needs draft-race handling anyway. |
| Insert/remove DOM chips directly in each event handler | Reconciliation can remove them; multiple views and failure behavior diverge. |
| Update `collectionSnapshots` and restore a saved copy on failure | A failed older edit can overwrite newer local or remote changes. |
| Use only the existing tag response | Useful improvement, but still requires pending projection and ordering protection against old reads. |
| Put full mutation results in every SSE event | Raises authorization, payload, loss, ordering, and reconnect complexity; direct acknowledgements already serve the initiating client. |
| Retry every failed POST | Can repeat jobs, counts, file operations, or destructive changes after lost responses. |
| One global queue/revision | Unrelated operations stall or conflict with each other, especially progress updates. |
| New frontend framework or offline synchronization engine | Unnecessary for the required lifecycle and incompatible with this project's frontend constraints. |

## Delivery plan

1. **Foundation and tag protocol:** implement the store/coordinator seam, domain
   revisions, identity parity, targeted reads, and tag receipts. Cover every tag
   writer and response serializer. Add capability negotiation and migrations
   that work with existing databases and older clients.
2. **Complete tag UX:** immediate editor transitions and pending chips, queueing,
   canonical acknowledgement merging, removal and failure UX, preserved focus,
   consistent projections, and reduced-motion/accessibility behavior. Remove
   tag save's dependency on full collection refresh for its visible result.
3. **Reversible metadata:** migrate favorites, playlist saves, and eligible
   settings through registered descriptors. Preserve playlist conflict handling
   and rotation rules. Rename gets immediate pending feedback, with replay
   enabled only after its filesystem recovery design is implemented and tested.
4. **Commands and sensitive operations:** inventory remaining callers of
   `apiAction`, `apiFetch`, raw `fetch`, and upload transports. Assign each a
   documented policy from the matrix, including receipt/job support where safe.
   Include account/connection actions, playback-specific sequences, destructive
   operations, and lost acknowledgements. Do not replace working domain-specific
   sequencing with a generic queue without equivalent guarantees.
5. **Completion audit:** list every mutating control, its descriptor or explicit
   domain-specific mechanism, immediate feedback, duplicate-submission behavior,
   recovery behavior, and tests. The app-wide objective is complete only when
   this inventory has no unexplained gaps, not when tags alone are implemented.

No code or VERSION change is part of writing this specification. Implementation
must receive the feature version bump required by the repository instructions.
Each separately requested code change gets its own appropriate bump.

## Acceptance and verification

### Deterministic coordinator and server tests

Exercise the public module seam using a controlled transport and clock. Cover
both response orders for every overlapping GET/write/SSE boundary, including:

- Immediate projection before any network promise resolves; repeated renders
  send no extra requests; two tags queue and remain visible independently.
- Stale pre-write GET, SSE-before-acknowledgement, duplicate hints, and older
  acknowledgements after a newer remote revision. No duplicate canonical chip,
  missing-frame chip, or confirmed-state regression.
- Independent field changes; failed A with pending B; conflict at the queue
  head; discarded unsent work; repeated Enter; domain/page queue limits.
- Canonical whitespace and casing, Unicode case folding and code-point length,
  existing tags, no-op attaches, last-attachment removal, and identity-version
  mismatch. Confirm that malicious labels remain text.
- Atomic value/revision reads; concurrent compare-and-write; writes through
  legacy routes; revision persistence after restart; cleanup writers; no
  revision increment from unrelated download progress.
- Receipt replay, simultaneous duplicates, mismatched fingerprints, wrong actor,
  lost response after commit, crash before commit, post-commit publish failure,
  clock skew, expired IDs, receipt cleanup and quotas. No duplicate write.
- Generic 5xx and malformed 2xx treated as potentially unknown; no mutation
  retry through the GET recovery loop; successful save plus failed refresh.
- Authorization revocation between route lookup and transaction, receipt replay
  after access loss, private-ID probing, cross-origin writes, and session expiry.
  Denial fences and auth epochs prevent stale callbacks from restoring UI data.
- Collection membership versus field revisions, filtered/rotated absence,
  actual deletion, temporary presentation IDs, and stable server-ID mapping.

### Browser tests through the real UI

Use controlled Playwright request gates rather than arbitrary sleeps. Open a
finished video's Info dialog, submit a tag, and hold its POST response:

1. The submitted tag is visible before the request is released, within the next
   available render frame. Under an otherwise idle test browser, local feedback
   should appear within 50 ms; network latency is excluded from this budget.
2. Its spinner occupies the remove slot, has stable dimensions, and is present
   in the accessible status. The input is empty, focused, and accepts a second
   tag whose queued chip also appears immediately.
3. Inject old collection responses and SSE hints while the POST is held. Chips,
   draft, focus, open Info state, and ordering remain correct.
4. Release a canonical success response with SSE blocked. The chip stays and
   the spinner becomes the remove control without waiting for another GET.
5. Reject one save while newer text and another intent exist. The failed text
   remains recoverable; neither newer text nor independent work is lost.
6. Commit on the server but drop the response. Show unconfirmed state, recover
   through the same mutation receipt, and verify only one write occurred.
7. Close/reopen Info, move focus, switch views, change a filter, trigger rotation,
   use Backspace/Escape, and test mouse/touch suggestion clicks during pending
   work. No unintended closure, focus theft, fullscreen exit, or card jump.
8. Exercise pending removal, unknown outcome, timeout copy, conflict resolution,
   revocation/deletion, logout, and account switch. No inaccessible or deleted
   item is restored by a pending chip or a late response.
9. Verify light/dark themes, reduced motion, keyboard-only use, status
   announcements, layout stability, and Chromium/Firefox behavior.

Run the existing focused tag, live-refresh, database contention, playlist,
authorization, request-security, rename, and migration regressions as relevant
to each delivery stage. For every implemented feature or fix, run
`./tests/run-all.sh --unit` and verify the enforced minimum **90% `vdl.py` line
coverage**, using Python 3.12 when close to the threshold. Complete relevant
browser checks before claiming the UX is delivered.

Record local feedback latency, acknowledgement latency, pending/unknown/conflict
counts, and reconciliation request counts without user content. A tag save
must not require a full collection read to display or confirm its result. This
reduces perceived delay; any remaining server latency needs separate measured
diagnosis rather than being hidden behind optimism.
