# Endless-playback display continuity

**Research status:** source-checked 2026-10-04

**Scope:** browser behavior and implementation guidance for advancing one VDL video to the next while retaining fullscreen or original-size presentation. This is a research note, not the feature specification or the server-side temporary-playlist design.

## Reading key

- **Verified** means the statement is directly supported by a linked standard or first-party browser source.
- **Standards-derived** means the conclusion follows from multiple normative rules but is not stated as a single explicit guarantee.
- **Recommendation** is proposed VDL behavior based on those facts.
- **Risk** identifies behavior that is browser-controlled or lacks a cross-browser guarantee.

## Executive findings

1. **Verified:** The standard handoff point is the media element's `ended` event. Forward playback fires `ended` after reaching the resource end, unless the element has `loop`; the event is not an error/recovery signal. [WHATWG media playback and `ended`](https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource)
2. **Verified:** Reuse the existing `<video>` element. Changing its `src` invokes the media load algorithm; using `<source>` children requires an explicit `load()` to make the element select them. `load()` resets resource state and aborts the previous selection. [WHATWG media-resource location](https://html.spec.whatwg.org/multipage/media.html#location-of-the-media-resource) · [WHATWG `load()`](https://html.spec.whatwg.org/multipage/media.html#dom-media-load)
3. **Standards-derived:** Standard Fullscreen API state belongs to the DOM element, not its media URL. Replacing the source on the same connected `<video>` does not itself unset that element's fullscreen flag. Removing/replacing the element does exit fullscreen, and the browser may end any fullscreen session when it considers that necessary. Therefore same-element source replacement is the only standards-aligned route to continuity, but browser/OS exit remains possible. [Fullscreen model and removal steps](https://fullscreen.spec.whatwg.org/#model) · [Fullscreen UI latitude](https://fullscreen.spec.whatwg.org/#ui)
4. **Verified:** Do not plan to leave fullscreen and call `requestFullscreen()` for every item. A successful request requires and consumes transient user activation; an `ended`, `loadedmetadata`, or timer callback is not a new activation. [Fullscreen `requestFullscreen()` algorithm](https://fullscreen.spec.whatwg.org/#dom-element-requestfullscreen)
5. **Verified:** `play()` returns a promise and may reject with `NotAllowedError` when browser or system policy disallows scripted playback. WebKit grants autoplay decisions per media element and explicitly recommends changing the source of one element for back-to-back videos. VDL must still handle rejection and offer a user-operated resume action. [WHATWG `play()`](https://html.spec.whatwg.org/multipage/media.html#dom-media-play) · [WebKit autoplay guidance](https://webkit.org/blog/7734/auto-play-policy-changes-for-macos/)
6. **Verified:** Natural dimensions are unavailable during `HAVE_NOTHING`: `videoWidth` and `videoHeight` are then `0`. Reapply an explicit original-size policy at `loadedmetadata`, and also handle `resize` if the selected track later changes dimensions. [WHATWG video dimensions](https://html.spec.whatwg.org/multipage/media.html#dom-video-videowidth) · [WHATWG media events](https://html.spec.whatwg.org/multipage/media.html#mediaevents)
7. **Risk:** Safari/iOS native video fullscreen (`webkitEnterFullscreen`) is distinct from standard element fullscreen and reports `webkitbeginfullscreen`/`webkitendfullscreen`. Apple requires a user action to enter it. Apple's sequential-source example says the same-element `load()`/`play()` pattern works on iOS after initial playback, but does not guarantee that native fullscreen remains presented across the source change. This needs device testing and a tap-to-restore fallback. [Apple sequential playback](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/ControllingMediaWithJavaScript/ControllingMediaWithJavaScript.html#//apple_ref/doc/uid/TP40009523-CH3-SW5) · [Apple fullscreen events and gesture rule](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/ControllingMediaWithJavaScript/ControllingMediaWithJavaScript.html#//apple_ref/doc/uid/TP40009523-CH3-SW13)

## Current VDL baseline

VDL already reuses one persistent video node, replaces its `<source>` child, and calls `load()` in [`playVideo()`](../static/app.js#L2497). The overlay markup contains that single node in [`templates/index.html`](../templates/index.html#L599). Standard `fullscreenchange` and Safari's `webkitendfullscreen` currently close an initially-fullscreen player session in [`static/app.js`](../static/app.js#L2560).

There is no explicit original-size mode or presentation-mode state today. The overlay video has viewport maximums but no fixed width/height in [`static/styles.css`](../static/styles.css#L955), so it normally follows its intrinsic size up to those caps. A feature specification should introduce a durable named mode rather than assume that the current incidental CSS behavior is already an original-size feature.

## 1. Advancing the media resource

### End detection

**Verified:** At normal forward completion, the HTML algorithm sets the element paused, fires `pause`, then fires `ended`. If `loop` is present, it seeks back instead and does not take the `ended` path. [WHATWG end-of-media steps](https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource)

**Recommendation:** Register one long-lived `ended` listener on `#playerVideo`. It should ask the playback-session controller for the next item, not recursively call today's `playVideo()`: that function initializes a new presentation, resets fullscreen bookkeeping, and may open a new tab.

**Recommendation:** Do not set the media element's `loop` attribute for endless playback. Queue wrapping belongs to the playlist/session layer; otherwise `ended` cannot advance the queue.

### Reusing the element and loading the next item

**Verified:** Assigning or changing the media element's `src` attribute invokes the media element load algorithm. Calling `load()` explicitly resets the element and starts resource selection from scratch; it aborts an existing selection and discards pending media tasks associated with the old resource. [WHATWG media-resource location](https://html.spec.whatwg.org/multipage/media.html#location-of-the-media-resource) · [WHATWG media element load algorithm](https://html.spec.whatwg.org/multipage/media.html#media-element-load-algorithm)

**Verified:** Apple documents the playlist pattern as: listen for `ended`, change the existing element's source, call `load()`, then call `play()`. Its Safari guide says this works on desktop and iOS once the user has started the first media element. [Apple “Replacing a Media Source Sequentially”](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/ControllingMediaWithJavaScript/ControllingMediaWithJavaScript.html#//apple_ref/doc/uid/TP40009523-CH3-SW5)

**Recommendation for VDL:** Retain the current typed `<source>` approach because it supplies MIME information. For each handoff:

1. Mark the session as `advancing` and allocate a monotonically increasing load-generation token.
2. Pause only if necessary, clear old `<source>` children, append the next typed source, and call `load()` once.
3. Keep the same `<video>`, player container, overlay, and fullscreen element connected throughout.
4. Call `play()` and observe its returned promise; do not infer success from calling it.
5. Ignore asynchronous callbacks whose generation token no longer matches the current item.

The generation token matters because `load()` intentionally produces abort/reset activity for the old resource and cancels queued media work. An old callback must not skip or close the new item. [WHATWG media element load algorithm](https://html.spec.whatwg.org/multipage/media.html#media-element-load-algorithm)

## 2. Playback permission and user activation

**Verified:** Whether a media element is “allowed to play” is explicitly left to the user agent and system. `play()` rejects with `NotAllowedError` when playback is not allowed and with `NotSupportedError` for a known unsupported source; its promise resolves only when playback has actually started. [WHATWG allowed-to-play definition and `play()`](https://html.spec.whatwg.org/multipage/media.html#allowed-to-play)

**Verified browser guidance:** WebKit says autoplay restrictions are granted per element and tells playlist authors to change one element's source rather than create multiple elements. Chromium likewise documents that the `play()` promise can remain pending until actual playback begins, for example while a tab is not visible. [WebKit macOS autoplay policy](https://webkit.org/blog/7734/auto-play-policy-changes-for-macos/) · [Chromium `play()` promise guidance](https://developer.chrome.com/blog/play-returns-promise)

**Recommendation:** The initial “start endless playback” action must be a direct user interaction and must start the same video element later reused by the session. On every handoff, handle both fulfillment and rejection:

- fulfillment: clear the “starting next” state only after playback begins;
- `NotAllowedError`: keep the next item loaded, preserve the queue position and presentation preference, and show a focused **Continue playback** control;
- unsupported/decode/network failure: apply the skip policy below;
- any other rejection: show a recoverable error and allow retry or skip.

Do not silently mute the next video to evade policy: that changes user-visible playback semantics.

## 3. Standard fullscreen continuity

### What the platform guarantees

**Verified:** Fullscreen is modeled by a flag on an element; the document's `fullscreenElement` is the topmost flagged element. Removing that node (or an ancestor containing it) runs exit-fullscreen steps. The media load algorithm does not replace or remove the element. [Fullscreen model](https://fullscreen.spec.whatwg.org/#model)

**Standards-derived:** If VDL changes only descendants/source state and keeps `#playerVideo` connected, the Fullscreen API has no source-change step that clears its fullscreen flag. In conforming standard-fullscreen behavior, the same video element therefore remains fullscreen while its media resource changes.

This is not an unconditional platform promise: the standard expressly permits a user agent to end any fullscreen session whenever it deems necessary. [Fullscreen UI](https://fullscreen.spec.whatwg.org/#ui)

### Why re-entry is not a viable continuity mechanism

**Verified:** `requestFullscreen()` requires transient activation (apart from a user-generated orientation-change exception) and consumes user activation when accepted. The fullscreen request is also subject to document activity, permissions policy, and platform support. [Fullscreen request algorithm](https://fullscreen.spec.whatwg.org/#dom-element-requestfullscreen)

**Recommendation:** Request fullscreen only from the user's initial start action or a later explicit **Return to fullscreen** action. Never deliberately exit between items. An `ended` callback cannot be relied on to reacquire fullscreen.

### Detecting state without confusing cause

**Verified:** `fullscreenchange` fires after the fullscreen state changes, bubbles, and can be interpreted using `document.fullscreenElement`. The event does not expose why fullscreen ended. [Fullscreen event dispatch](https://fullscreen.spec.whatwg.org/#run-the-fullscreen-steps) · [`fullscreenElement`](https://fullscreen.spec.whatwg.org/#dom-document-fullscreenelement)

**Recommendation:** Track observed state, not only requested state:

```text
presentationSize: fit | original
fullscreenKind: none | standard | webkit-video
phase: idle | loading | playing | advancing | awaiting-user | failed
loadGeneration: integer
```

Before a source swap, record `document.fullscreenElement === video`. After the swap, leave this value under event control. If `fullscreenchange` reports no fullscreen element during `advancing`, do not destroy the playback session immediately; transition to inline overlay and offer **Return to fullscreen**. If the user exits while `playing`, apply the product's normal exit behavior. Because the event contains no cause, this phase distinction is necessarily application bookkeeping.

## 4. Safari and iOS native video fullscreen

**Verified:** Apple exposes video-native state through `webkitDisplayingFullscreen`, `webkitEnterFullscreen()`, and `webkitExitFullscreen()`. On iOS, native video presentation reports `webkitbeginfullscreen` and `webkitendfullscreen`, whereas standard/element fullscreen reports a fullscreen-change event. [Apple `HTMLVideoElement`](https://developer.apple.com/documentation/webkitjs/htmlvideoelement) · [Apple fullscreen event guidance](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/ControllingMediaWithJavaScript/ControllingMediaWithJavaScript.html#//apple_ref/doc/uid/TP40009523-CH3-SW13)

**Verified:** Apple requires `webkitEnterFullscreen()` to be invoked in response to a user action, and `webkitSupportsFullscreen` is not valid until the media metadata has loaded. [Apple fullscreen programming guidance](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/ControllingMediaWithJavaScript/ControllingMediaWithJavaScript.html#//apple_ref/doc/uid/TP40009523-CH3-SW13)

**Risk:** Apple's documentation verifies sequential same-element playback and documents native fullscreen separately, but does not promise native-controller continuity when `load()` changes the source. Native video fullscreen is not governed solely by the standard element fullscreen flag. VDL cannot promise automatic re-entry if WebKit emits `webkitendfullscreen`, because doing so from a media event lacks the required user action.

**Recommendation:** Treat native WebKit fullscreen as a separate compatibility path:

- Preserve the same `<video>` element and source-swap in place.
- Track `webkitbeginfullscreen`, `webkitendfullscreen`, and (where available) `webkitDisplayingFullscreen` independently of `document.fullscreenElement`.
- During `advancing`, do not let a source-induced `webkitendfullscreen` close and release the temporary playlist. Keep the overlay/session alive and present a one-tap **Continue in fullscreen** control after metadata makes `webkitSupportsFullscreen` meaningful.
- If native fullscreen remains active across the swap, take no action.
- State in the feature specification that uninterrupted native-iOS fullscreen is best effort until the supported-device test matrix confirms it.

Using `playsinline` changes whether iPhone playback automatically enters native fullscreen, but does not remove the user-activation rule for audible scripted playback. [WebKit iOS video policy](https://webkit.org/blog/6784/new-video-policies-for-ios/) · [Apple Safari video delivery](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari)

## 5. Original-size continuity

**Verified:** `videoWidth`/`videoHeight` expose the resource's natural dimensions in CSS pixels, accounting for encoded dimensions, aspect ratio, aperture, and resolution. They return zero while `readyState` is `HAVE_NOTHING`. `loadedmetadata` is queued when ready state first becomes `HAVE_METADATA`, and rendering has already had an opportunity to resize the element. A later change to natural dimensions fires `resize`. [WHATWG video dimension getters](https://html.spec.whatwg.org/multipage/media.html#dom-video-videowidth) · [WHATWG ready-state transitions](https://html.spec.whatwg.org/multipage/media.html#ready-states)

**Verified:** Apple recommends applying native dimensions from `videoWidth` and `videoHeight` in `loadedmetadata`, which fires for each newly loaded movie. [Apple dynamic natural-size example](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/ControllingMediaWithJavaScript/ControllingMediaWithJavaScript.html#//apple_ref/doc/uid/TP40009523-CH3-SW12)

**Recommendation:** Make original size an explicit session preference, independent of the current resource and independent of fullscreen:

- `fit`: existing responsive viewport-constrained presentation;
- `original`: set the playback area's target dimensions from the current item's `videoWidth` and `videoHeight`, while retaining viewport maximums so controls cannot become unreachable.

On every `loadedmetadata`, reapply the active preference using the new resource's dimensions. Do not preserve the previous item's computed pixel width/height. Listen for the video's `resize` event and recompute original size if dimensions change after metadata.

Fullscreen should temporarily override layout through `:fullscreen`; the Fullscreen standard's default stylesheet expands a non-root fullscreen element to the viewport and uses `object-fit: contain`. Keep `presentationSize` unchanged underneath so exiting fullscreen returns to the chosen original/fit mode. [Fullscreen user-agent stylesheet](https://fullscreen.spec.whatwg.org/#user-agent-level-style-sheet-defaults)

## 6. Errors, stalls, timeouts, and safe skipping

**Verified:** A media `error` event accompanies terminal network/decode/source failures, and `video.error.code` distinguishes aborted, network, decode, and unsupported-source categories. By contrast, `waiting` means playable data is temporarily insufficient and `stalled` means fetching is unexpectedly not progressing; neither alone is a terminal failure. [WHATWG `MediaError`](https://html.spec.whatwg.org/multipage/media.html#mediaerror) · [WHATWG media events](https://html.spec.whatwg.org/multipage/media.html#mediaevents)

**Verified browser risk:** Chromium documents an implementation edge case where `play()` may never reject if all child `<source>` candidates are invalid. VDL currently uses child `<source>` elements, so an `error` listener and a bounded loading watchdog are needed in addition to the play promise. [Chromium `play()` promise “Danger zone”](https://developer.chrome.com/blog/play-returns-promise#danger-zone)

**Recommendation:** Define safe handoff failure as either:

- a matching-generation terminal `error` event;
- a matching-generation `play()` rejection that is not merely autoplay denial; or
- an application watchdog expiring while the page is visible and no qualifying progress has occurred.

The watchdog duration is a product policy, not a web-platform constant. Pause it while the document is hidden because browsers may defer playback in background tabs, and reset it on meaningful progress such as `loadedmetadata`, `canplay`, or `playing`. Do not skip immediately on `waiting` or `stalled`.

On failure, retain fullscreen/presentation state, mark the item skipped with a visible reason, request the next queue position, and use a new load generation. Bound consecutive automatic skips and stop with user controls after a complete cycle or configured maximum so a library of unplayable files cannot create an infinite request loop. A user close must cancel the watchdog and invalidate the current generation before releasing the temporary server playlist.

## 7. Recommended acceptance and test boundary

The feature specification can make these guarantees:

- The same `<video>` DOM node is used for all items in one endless-playback session.
- A normally ended item advances exactly once; stale events cannot advance a later item.
- Standard element fullscreen is not intentionally exited during source replacement.
- Original-size/fit preference is session state and is applied to each item's own metadata.
- Every `play()` promise rejection and terminal media error has visible retry/skip behavior.
- Closing playback cancels in-flight transitions and releases the server playlist.

It should qualify this behavior:

- Browsers and operating systems retain final control over autoplay and fullscreen.
- Native Safari/iOS video fullscreen continuity across a `load()` source swap is best effort; if it exits, one fresh user action is required to return.

Minimum manual coverage should include current desktop Chrome/Chromium, Firefox, and Safari; iPhone Safari native video fullscreen; iPadOS Safari element/native behavior; mixed resolutions and portrait/landscape videos; unsupported codecs; missing/deleted files; slow/stalled range requests; hidden-tab handoff; user Escape/fullscreen exit during `advancing`; and close during an outstanding `play()` promise.
