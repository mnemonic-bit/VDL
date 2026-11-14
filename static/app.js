// Statuses that count as "in flight" (the worker thread is alive).
const RUNNING_STATUSES = new Set(['starting', 'downloading']);
const ACTIVE_PROGRESS_STATUSES = new Set(['starting', 'downloading', 'paused']);
// Statuses shown under the Current tab. Cancelled and interrupted
// stay here so the user can resume them; everything else terminal
// goes to History.
const CURRENT_TAB_STATUSES = new Set(['starting', 'downloading', 'paused', 'cancelled', 'interrupted']);
const HISTORY_TAB_STATUSES = new Set(['finished']);
const TERMINAL_STATUSES = new Set(['finished', 'error', 'cancelled', 'interrupted']);
const THUMBNAIL_CACHE_VERSION = 2;

function thumbnailUrl(id) {
    return `/api/thumbnail/${encodeURIComponent(id)}?v=${THUMBNAIL_CACHE_VERSION}`;
}

// Each collection owns its request and one dirty bit, including calls from
// actions and manual refreshes. Slow Library reads must not stall Current.
const collectionRefreshes = new Map();
const collectionErrors = new Map();
const collectionSnapshots = { library: [], current: [] };
let libraryOrder = { kind: 'library', generation_id: null, created_at: null, expires_at: null };
let libraryRequestEpoch = 0;
let librarySnapshotVersion = 0;
let allLibraryEntries = [];
let tagSessionEpoch = 0;

function invalidateLibraryOrder() {
    // A hint or save supersedes reads that started before the new server state.
    libraryRequestEpoch += 1;
}

function renderLibraryRotationStatus() {
    const status = document.getElementById('libraryRotationStatus');
    status.hidden = libraryOrder.kind !== 'rotation';
    if (status.hidden) return;
    const date = new Date(Number(libraryOrder.expires_at) * 1000);
    const time = document.getElementById('libraryRotationExpiry');
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleString();
}
let libraryLoaded = false;
let currentLoaded = false;
let requestedFavoriteSort = false;

function coordinateRefresh(key, load) {
    let state = collectionRefreshes.get(key);
    if (!state) {
        state = { dirty: false, promise: null };
        collectionRefreshes.set(key, state);
    }
    state.dirty = true;
    if (state.promise) return state.promise;
    state.promise = (async () => {
        do {
            state.dirty = false;
            await load();
            if (state.dirty) await new Promise(resolve => setTimeout(resolve, 150));
        } while (state.dirty);
    })().finally(() => { state.promise = null; });
    return state.promise;
}

function updateCollectionError(key, message = '') {
    const previous = historyRefreshError;
    if (message) collectionErrors.set(key, message);
    else collectionErrors.delete(key);
    historyRefreshError = [...collectionErrors.values()].join(' ');
    if (previous) {
        for (const id of ['actionError', 'newDownloadError', 'settingsError', 'currentDrawerError']) {
            if (document.getElementById(`${id}Message`).textContent === previous) {
                document.getElementById(id).hidden = true;
            }
        }
    }
    if (historyRefreshError) showActionError(historyRefreshError);
    updateHistoryEmptyState();
}

async function readCollection(url, { ordered = false } = {}) {
    for (let retry = 0; ; retry++) {
        try {
            const response = await apiFetch(url);
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw Object.assign(new Error(data.error || response.statusText || `Request failed (${response.status})`), {
                    retryable: response.status >= 500 && data.code !== 'database_busy',
                });
            }
            const data = await response.json();
            if (ordered ? (!data || !Array.isArray(data.items) || !data.order) : !Array.isArray(data)) {
                throw new Error('Invalid collection response.');
            }
            return data;
        } catch (error) {
            if (error.name === 'AbortError' || error.retryable === false || retry >= 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 500 * (retry + 1)));
        }
    }
}

const renderedTemplates = new WeakMap();

// Compare generated markup with its previous version, rather than the live
// DOM: hover playback, focus, image failures and animations own runtime state.
function patchRenderedNode(node, before, after) {
    if (before.isEqualNode(after)) return;
    if (before.nodeType !== after.nodeType || before.nodeName !== after.nodeName) {
        if (node.contains?.(activeHoverPreview) || node.contains?.(pendingHoverPreview)) stopHoverPreview();
        node.replaceWith(after.cloneNode(true));
        return;
    }
    if (after.nodeType !== Node.ELEMENT_NODE) {
        node.nodeValue = after.nodeValue;
        return;
    }
    for (const attr of before.attributes) {
        if (!after.hasAttribute(attr.name)) node.removeAttribute(attr.name);
    }
    for (const attr of after.attributes) {
        if (before.getAttribute(attr.name) === attr.value) continue;
        if (attr.name === 'class') {
            const oldClasses = new Set(before.classList);
            const newClasses = new Set(after.classList);
            for (const name of oldClasses) if (!newClasses.has(name)) node.classList.remove(name);
            for (const name of newClasses) if (!oldClasses.has(name)) node.classList.add(name);
        } else {
            node.setAttribute(attr.name, attr.value);
        }
    }
    if (after.classList.contains('tag-token-input')) {
        // Tag identity retains both chip and input nodes as queued chips settle.
        const key = child => child.nodeType === Node.ELEMENT_NODE
            ? child.matches('.tag-entry-input') ? 'input' : child.dataset.tagKey
            : null;
        const oldByKey = new Map([...before.children].map(child => [key(child), child]));
        const liveByKey = new Map([...node.children].map(child => [key(child), child]));
        const nextKeys = new Set([...after.children].map(key));
        for (const child of [...node.childNodes]) {
            if (!key(child) || !nextKeys.has(key(child))) child.remove();
        }
        [...after.children].forEach((next, index) => {
            const identity = key(next);
            let live = liveByKey.get(identity);
            const previous = oldByKey.get(identity);
            if (live && previous) patchRenderedNode(live, previous, next);
            else live = next.cloneNode(true);
            if (node.children[index] !== live) node.insertBefore(live, node.children[index] || null);
            liveByKey.delete(identity);
        });
        for (const live of liveByKey.values()) live.remove();
        return;
    }
    const oldChildren = [...before.childNodes];
    const newChildren = [...after.childNodes];
    const liveChildren = [...node.childNodes];
    for (let i = 0; i < Math.max(oldChildren.length, newChildren.length); i++) {
        if (!oldChildren[i]) node.appendChild(newChildren[i].cloneNode(true));
        else if (!newChildren[i]) liveChildren[i]?.remove();
        else if (liveChildren[i]) patchRenderedNode(liveChildren[i], oldChildren[i], newChildren[i]);
    }
}

function reconcileCards(list, entries, render, idAttribute) {
    const existing = new Map([...list.children].map(node => [node.getAttribute(idAttribute), node]));
    entries.forEach((entry, index) => {
        const id = String(entry.id);
        let node = existing.get(id);
        const template = document.createElement('template');
        template.innerHTML = render(entry).trim();
        const next = template.content.firstElementChild;
        const before = node && renderedTemplates.get(node);
        if (!node || !before) {
            node = next.cloneNode(true);
        } else {
            patchRenderedNode(node, before, next);
        }
        renderedTemplates.set(node, next);
        // Moving an unchanged focused card can blur it or restart its video.
        if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
        existing.delete(id);
    });
    for (const node of existing.values()) {
        if (node.contains(activeHoverPreview) || node.contains(pendingHoverPreview)) stopHoverPreview();
        node.remove();
    }
}

function retryThumbnail(image) {
    const preview = image.closest('.history-preview');
    (preview || image).classList.add('thumbnail-unavailable');
    if (preview) preview.querySelector('.history-preview-fallback > span').textContent = 'Preview unavailable';
    scheduleThumbnailRetry(image);
}

function scheduleThumbnailRetry(image, delay = 1000) {
    // Ready images can still suffer transport or decoding failures. Recovery
    // is bounded and never probes pending generation with per-image HEADs.
    if (image.dataset.thumbnailRetryPending || Number(image.dataset.thumbnailFailures || 0) >= 3) return;
    image.dataset.thumbnailRetryPending = '1';
    setTimeout(() => {
        delete image.dataset.thumbnailRetryPending;
        if (!image.isConnected || image.dataset.assetState !== 'ready') return;
        image.dataset.thumbnailFailures = String(Number(image.dataset.thumbnailFailures || 0) + 1);
        const url = new URL(thumbnailUrl(image.dataset.assetId), location.href);
        url.searchParams.set('retry', String(Date.now()));
        image.src = url.href;
    }, delay);
}

function libraryEntryForAssets(id) {
    return collectionSnapshots.library.find(info => String(info.id) === String(id))
        || allLibraryEntries.find(info => String(info.id) === String(id));
}

function assetState(id, kind = 'thumbnail') {
    return libraryEntryForAssets(id)?.assets?.[kind] || 'queued';
}

function montageDelivery(id) {
    const assets = libraryEntryForAssets(id)?.assets;
    if (assets?.montage_delivery) return assets.montage_delivery;
    return {
        available: assets?.montage === 'ready', current: true,
        url: '/api/preview/' + encodeURIComponent(id) + '?v=' + HOVER_PREVIEW_CACHE_VERSION,
    };
}

function hasVideoAssets(info) {
    return Boolean(info && (info.assets?.thumbnail
        || PLAYLIST_VIDEO_EXTENSIONS.has((info.filename || '').split('.').pop().toLowerCase())));
}

function assetImage(id, attributes = '') {
    const state = assetState(id);
    const source = state === 'ready' ? ` src="${thumbnailUrl(id)}"` : '';
    return `<img data-asset-id="${escapeAttr(id)}" data-asset-state="${state}"${source} alt="" ${attributes} onerror="retryThumbnail(this)" onload="thumbnailLoaded(this)">`;
}

const assetDemand = {
    tab: globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    revision: 0, timer: null, inFlight: false, latest: null, signature: null,
};
let intentionalHoverPreview = null;
let assetViewportObserver = null;
const observedAssetCards = new Set();

function visibleAssetIds() {
    if (document.hidden || document.getElementById('tab-history').hidden) return [];
    const cards = [...document.querySelectorAll('#historyList [data-row-id]')];
    return cards.filter(card => {
        if (!card.querySelector('[data-play-action][data-play-ext]')) return false;
        if (!hasVideoAssets(collectionSnapshots.library.find(info => String(info.id) === card.dataset.rowId))) return false;
        if (!endlessHistoryEnabled()) return true;
        const bounds = card.getBoundingClientRect();
        return bounds.bottom >= -160 && bounds.top <= innerHeight + 160;
    }).slice(0, 200).map(card => card.dataset.rowId);
}

function updateAssetViewport() {
    if (!assetViewportObserver && 'IntersectionObserver' in window) {
        assetViewportObserver = new IntersectionObserver(() => scheduleAssetDemand(), { rootMargin: '160px' });
    }
    const cards = new Set(document.querySelectorAll('#historyList [data-row-id]'));
    for (const card of observedAssetCards) {
        if (!cards.has(card)) {
            assetViewportObserver?.unobserve(card);
            observedAssetCards.delete(card);
        }
    }
    for (const card of cards) {
        if (!observedAssetCards.has(card)) {
            assetViewportObserver?.observe(card);
            observedAssetCards.add(card);
        }
    }
    scheduleAssetDemand();
}

function scheduleAssetDemand({ reconcile = false, interaction = true } = {}) {
    const ids = visibleAssetIds();
    const hoverId = intentionalHoverPreview?.dataset.downloadId;
    const hovered = ids.includes(hoverId) ? hoverId : null;
    const signature = JSON.stringify([ids, hovered]);
    if (!reconcile && signature === assetDemand.signature) return;
    assetDemand.signature = signature;
    interaction ||= Boolean(assetDemand.latest?.interaction);
    assetDemand.latest = { tab_id: assetDemand.tab, revision: ++assetDemand.revision, ids, hovered_id: hovered, interaction };
    if (assetDemand.timer !== null) return;
    assetDemand.timer = setTimeout(() => {
        assetDemand.timer = null;
        flushAssetDemand();
    }, 150);
}

async function flushAssetDemand() {
    if (assetDemand.inFlight || !assetDemand.latest) return;
    const demand = assetDemand.latest;
    assetDemand.latest = null;
    assetDemand.inFlight = true;
    try {
        const response = await apiFetch('/api/assets/demand', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(demand), keepalive: demand.ids.length === 0,
        });
        if (response.ok) {
            const data = await response.json();
            if (demand.revision === assetDemand.revision) applyAssetReadiness(data.assets || {});
        }
    } catch (_) { /* Focus, navigation and SSE reconnect reconcile transport failures. */ }
    finally {
        assetDemand.inFlight = false;
        if (assetDemand.latest && assetDemand.timer === null) {
            assetDemand.timer = setTimeout(() => {
                assetDemand.timer = null;
                flushAssetDemand();
            }, 150);
        }
    }
}

function applyAssetReadiness(assets) {
    for (const [id, readiness] of Object.entries(assets)) {
        const info = libraryEntryForAssets(id);
        if (!info) continue;
        info.assets = readiness;
        const complete = allLibraryEntries.find(item => String(item.id) === id);
        if (complete) complete.assets = readiness;
        // Only changed cards are patched. The retained template protects live
        // image/hover elements from unrelated readiness and progress events.
        const card = document.querySelector(`#historyList [data-row-id="${CSS.escape(id)}"]`);
        if (card && renderedTemplates.has(card)) {
            const template = document.createElement('template');
            template.innerHTML = renderItem(info, true).trim();
            const next = template.content.firstElementChild;
            patchRenderedNode(card, renderedTemplates.get(card), next);
            renderedTemplates.set(card, next);
        }
        for (const image of document.querySelectorAll(`img[data-asset-id="${CSS.escape(id)}"]`)) {
            const previous = image.dataset.assetState;
            image.dataset.assetState = readiness.thumbnail;
            if (readiness.thumbnail === 'ready') {
                if (previous !== 'ready' || !image.hasAttribute('src')) image.src = thumbnailUrl(id);
            } else {
                image.removeAttribute('src');
            }
        }
    }
    if (intentionalHoverPreview && !intentionalHoverPreview.isConnected) intentionalHoverPreview = null;
    if (intentionalHoverPreview && !activeHoverPreview
            && montageDelivery(intentionalHoverPreview.dataset.downloadId).available) {
        startHoverPreview(intentionalHoverPreview, false);
    }
}

let lastAssetInteraction = 0;
function renewAssetDemand() {
    const now = Date.now();
    if (now - lastAssetInteraction < 1000) return;
    lastAssetInteraction = now;
    scheduleAssetDemand({ reconcile: true });
}

window.addEventListener('scroll', renewAssetDemand, { passive: true });
window.addEventListener('focus', () => scheduleAssetDemand({ reconcile: true }));
document.addEventListener('visibilitychange', () => scheduleAssetDemand({ reconcile: true }));
window.addEventListener('pagehide', () => {
    // This also clears demand for form-based logout and ordinary navigation.
    assetDemand.latest = { tab_id: assetDemand.tab, revision: ++assetDemand.revision, ids: [], hovered_id: null };
    if (assetDemand.timer !== null) clearTimeout(assetDemand.timer);
    assetDemand.timer = null;
    flushAssetDemand();
});

function thumbnailLoaded(image) {
    delete image.dataset.thumbnailFailures;
    (image.closest('.history-preview') || image).classList.remove('thumbnail-unavailable');
}

const favicon = document.getElementById('appFavicon');
const idleFaviconHref = favicon ? favicon.getAttribute('href') : '';
const appTitleIcon = document.getElementById('appTitleIcon');
const appTitleProgressRing = document.getElementById('appTitleProgressRing');

function progressBytes(info) {
    const total = Number(info.total_bytes);
    if (!Number.isFinite(total) || total <= 0) return null;

    const reportedDownloaded = Number(info.downloaded_bytes);
    const downloaded = Number.isFinite(reportedDownloaded)
        ? Math.min(total, Math.max(0, reportedDownloaded))
        : 0;
    return { downloaded, total };
}

function aggregateActiveProgress(downloads) {
    const active = downloads.filter(info => ACTIVE_PROGRESS_STATUSES.has(info.status));
    if (!active.length) return null;

    let downloadedBytes = 0;
    let totalBytes = 0;
    for (const info of active) {
        const progress = progressBytes(info);
        if (!progress) return { count: active.length, percent: null };
        downloadedBytes += progress.downloaded;
        totalBytes += progress.total;
    }

    return {
        count: active.length,
        percent: (downloadedBytes / totalBytes) * 100,
    };
}

function itemProgressPercent(info) {
    const progress = progressBytes(info);
    if (!progress) return null;
    return Math.round((progress.downloaded / progress.total) * 1000) / 10;
}

function renderActionProgressIcon(symbolId, info) {
    const percent = itemProgressPercent(info);
    const progressAttr = percent === null ? '' : ` data-progress="${percent}"`;
    const ringAttr = percent === null || percent <= 0
        ? ' hidden'
        : ` style="stroke-dashoffset: ${100 - percent};"`;
    return `<svg class="icon action-progress-icon" viewBox="-2 -2 20 20" aria-hidden="true"${progressAttr}>
                    <use href="#${symbolId}" x="0" y="0" width="16" height="16"/>
                    <circle class="action-progress-track" cx="8" cy="8" r="8.1"/>
                    <circle class="action-progress-ring" cx="8" cy="8" r="8.1" pathLength="100" transform="rotate(-90 8 8)"${ringAttr}/>
                </svg>`;
}

function updateHeaderProgress(aggregate) {
    if (!appTitleIcon || !appTitleProgressRing) return;
    if (!aggregate) {
        appTitleProgressRing.setAttribute('hidden', '');
        delete appTitleIcon.dataset.progress;
        delete appTitleIcon.dataset.runningCount;
        return;
    }

    appTitleIcon.dataset.runningCount = String(aggregate.count);
    if (aggregate.percent === null || aggregate.percent <= 0) {
        appTitleProgressRing.setAttribute('hidden', '');
        delete appTitleIcon.dataset.progress;
        return;
    }

    const percent = Math.round(aggregate.percent * 10) / 10;
    appTitleProgressRing.style.strokeDashoffset = String(100 - percent);
    appTitleProgressRing.removeAttribute('hidden');
    appTitleIcon.dataset.progress = String(percent);
}

function updateFavicon(aggregate) {
    if (!favicon) return;
    if (!aggregate || aggregate.percent === null) {
        favicon.setAttribute('href', idleFaviconHref);
        delete favicon.dataset.progress;
        if (aggregate) {
            favicon.dataset.runningCount = String(aggregate.count);
        } else {
            delete favicon.dataset.runningCount;
        }
        return;
    }

    const percent = Math.round(aggregate.percent * 10) / 10;
    const radius = 7.5;
    const angle = (percent / 100) * Math.PI * 2;
    const endX = 8 + radius * Math.sin(angle);
    const endY = 8 - radius * Math.cos(angle);
    let progressShape = '';
    if (percent >= 100) {
        progressShape = `<circle cx="8" cy="8" r="${radius}" fill="#1f8a3b"/>`;
    } else if (percent > 0) {
        const largeArc = percent > 50 ? 1 : 0;
        progressShape = `<path d="M8 8 L8 .5 A${radius} ${radius} 0 ${largeArc} 1 ${endX.toFixed(3)} ${endY.toFixed(3)} Z" fill="#1f8a3b"/>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="${radius}" fill="#888"/>${progressShape}<g fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4v5.5"/><path d="M5 7l3 3 3-3"/><path d="M4.5 12.5h7"/></g></svg>`;
    favicon.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(svg)}`);
    favicon.dataset.progress = String(percent);
    favicon.dataset.runningCount = String(aggregate.count);
}

function updateProgressIndicators(downloads) {
    const aggregate = aggregateActiveProgress(downloads);
    updateHeaderProgress(aggregate);
    updateFavicon(aggregate);
}

function showServerStatus(source = 'events') {
    source = source === '/api/health' || source === 'events' ? source : 'api';
    showServerStatus.failures ||= new Set();
    showServerStatus.failures.add(source);
    document.getElementById('serverStatus').hidden = false;
    document.getElementById('versionFooter').classList.add('server-unavailable');
}

function hideServerStatus(source = 'events') {
    source = source === '/api/health' || source === 'events' ? source : 'api';
    showServerStatus.failures?.delete(source);
    if (showServerStatus.failures?.size) return;
    document.getElementById('serverStatus').hidden = true;
    document.getElementById('versionFooter').classList.remove('server-unavailable');
}

async function apiFetch(url, options) {
    const authEpoch = tagSessionEpoch;
    const safeRead = (options?.method || 'GET').toUpperCase() === 'GET';
    try {
        for (let retry = 0; ; retry++) {
            if (authEpoch !== tagSessionEpoch) throw new DOMException('Session changed', 'AbortError');
            options?.signal?.throwIfAborted();
            const res = await fetch(url, options);
            if (authEpoch !== tagSessionEpoch) throw new DOMException('Session changed', 'AbortError');
            if (res.status === 401) {
                resetTagSession();
                resetPlayerListening();
                window.location.assign('/login');
                throw Object.assign(new Error('Your session has ended. Sign in again.'), { retryable: false, status: 401 });
            }
            if (safeRead && res.status === 503) {
                const data = await res.clone().json().catch(() => ({}));
                // Only the server's explicit contention response is safe to
                // recover automatically. Replaying a mutation can duplicate work.
                if (data.code === 'database_busy' && data.retryable === true) {
                    if (retry < 2) {
                        const retryAfter = res.headers.get('Retry-After');
                        const seconds = retryAfter === null ? NaN : Number(retryAfter);
                        const delay = Number.isFinite(seconds)
                            ? seconds * 1000
                            : Date.parse(retryAfter) - Date.now();
                        await new Promise(resolve => setTimeout(
                            resolve, Number.isFinite(delay)
                                ? Math.min(2000, Math.max(0, delay)) : 250,
                        ));
                        continue;
                    }
                    throw Object.assign(new Error(data.error || 'Database is busy. Try again shortly.'), { retryable: false });
                }
            }
            hideServerStatus(url);
            return res;
        }
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        showServerStatus(url);
        throw err;
    }
}

function hideActionError() {
    document.getElementById('actionError').hidden = true;
    document.getElementById('newDownloadError').hidden = true;
    document.getElementById('settingsError').hidden = true;
    document.getElementById('currentDrawerError').hidden = true;
}

function showActionError(message) {
    let errorId = 'actionError';
    let messageId = 'actionErrorMessage';
    if (document.getElementById('newDownloadDialog').open) {
        errorId = 'newDownloadError';
        messageId = 'newDownloadErrorMessage';
    } else if (!document.getElementById('settingsPage').hidden) {
        errorId = 'settingsError';
        messageId = 'settingsErrorMessage';
    } else if (document.getElementById('currentDownloadsDrawer').open) {
        errorId = 'currentDrawerError';
        messageId = 'currentDrawerErrorMessage';
    }
    const error = document.getElementById(errorId);
    document.getElementById(messageId).textContent = message;
    error.hidden = false;
}

function apiAction(url, options) {
    hideActionError();
    return apiFetch(url, options)
        .then(async res => {
            if (res.ok) return res;
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || res.statusText || `Request failed (${res.status})`);
        })
        .catch(err => {
            showActionError(err.message || 'Request failed');
            throw err;
        });
}

const uploadDropOverlay = document.getElementById('uploadDropOverlay');
const uploadDropTitle = document.getElementById('uploadDropTitle');
const uploadDropDetail = document.getElementById('uploadDropDetail');
let uploadDragDepth = 0;
const droppedUploads = new Map();
const activeUploadRequests = new Map();
let uploadProgressRenderTimer = null;

function isFileDrag(event) {
    return event.dataTransfer
        && Array.from(event.dataTransfer.types || []).includes('Files');
}

function showUploadOverlay(title, detail) {
    uploadDropTitle.textContent = title;
    uploadDropDetail.textContent = detail;
    uploadDropOverlay.classList.add('active');
    uploadDropOverlay.setAttribute('aria-hidden', 'false');
    if (!uploadDropOverlay.open) uploadDropOverlay.showModal();
}

function hideUploadOverlay() {
    uploadDropOverlay.classList.remove('active', 'uploading');
    uploadDropOverlay.setAttribute('aria-hidden', 'true');
    if (uploadDropOverlay.open) uploadDropOverlay.close();
}

function uploadIsCurrent(upload) {
    return upload.epoch === tagSessionEpoch && droppedUploads.get(upload.info.id) === upload;
}

function hasUploadProtocol() {
    return tagCapabilities?.upload_recovery === 1 && tagCapabilities?.mutation_protocol === 1
        && ['upload.register', 'upload.cancel'].every(kind => tagCapabilities.actions?.includes(kind));
}

function uploadIntent(upload) {
    return tagMutations.status(upload.cancelIntentId || upload.registerIntentId);
}

function uploadText(upload) {
    const intent = uploadIntent(upload);
    if (upload.recoveryRequired) return 'Upload recovery requires intervention. Check again after file ownership is repaired.';
    if (['rejected', 'conflicted'].includes(intent?.status)) return intent.message;
    if (upload.stopRequested && !['published', 'cancelled', 'failed'].includes(upload.phase)) {
        return intent?.status === 'unconfirmed' || upload.unknown ? 'Stopping upload… Server cancellation not confirmed. Check upload status.' : 'Stopping upload…';
    }
    if (intent?.status === 'unconfirmed' || upload.unknown) return 'Upload outcome not confirmed. Check upload status.';
    if (upload.adopted && upload.phase === 'registered') return 'Upload registered. The local file is unavailable on this page. Check upload status or stop the upload.';
    if (upload.phase === 'failed' && upload.failure) return upload.failure;
    if (intent?.delayed) return intent.message;
    if (upload.delayed && upload.phase === 'processing') return 'Processing upload… Waiting for server confirmation.';
    return ({ registering: 'Registering upload…', registered: 'Upload registered', transferring: 'Uploading…',
        processing: 'Processing upload…', published: 'Video added to library', cancelled: 'Upload stopped', failed: 'Upload failed' })[upload.phase] || upload.info.upload_detail;
}

function uploadStatusMarkup(upload, summary = false) {
    const intent = uploadIntent(upload);
    const id = escapeAttr(upload.info.id);
    const unknown = upload.unknown || intent?.status === 'unconfirmed';
    const check = upload.protocol && (unknown || upload.recoveryRequired || upload.adopted || upload.stopRequested || upload.phase === 'processing')
        ? `<button type="button" data-upload-recovery="check" data-upload-id="${id}"${upload.checking ? ' disabled' : ''}>Check upload status</button>` : '';
    const replay = upload.protocol && intent?.status === 'unconfirmed' && !intent.replayExpired
        ? `<button type="button" data-upload-recovery="replay" data-upload-id="${id}">${upload.cancelIntentId ? 'Recover cancellation' : 'Recover registration'}</button>` : '';
    const dismiss = !upload.recoveryRequired && intent && (['rejected', 'conflicted'].includes(intent.status) || intent.status === 'unconfirmed' && intent.canResolve)
        ? `<button type="button" data-upload-recovery="dismiss" data-upload-id="${id}">Dismiss upload request</button>` : '';
    const legacyCheck = !upload.protocol && unknown ? `<button type="button" data-upload-recovery="current" data-upload-id="${id}">Check Current downloads</button>` : '';
    return `<div class="upload-request-status" role="status" aria-live="off" data-upload-phase="${escapeAttr(upload.phase)}" data-upload-id="${id}">${summary ? `<strong>${escapeHtml(upload.info.title)}</strong>: ` : ''}<span>${escapeHtml(uploadText(upload))}</span> ${check}${replay}${dismiss}${legacyCheck}</div>`;
}

function uploadStatusSlot(id) {
    const upload = droppedUploads.get(String(id));
    return upload ? uploadStatusMarkup(upload) : '';
}

function uploadDiagnosticIntents() {
    return [...droppedUploads.values()].filter(upload => !uploadIntent(upload) && (!upload.settled || upload.unknown || upload.recoveryRequired))
        .map(upload => ({ kind: 'upload.transfer', status: upload.unknown ? 'unconfirmed' : 'sending' }));
}

function renderUploadRecovery() {
    const summary = document.getElementById('uploadRecoverySummary');
    const uploads = [...droppedUploads.values()];
    const unresolved = uploads.filter(upload => !upload.settled || upload.unknown || upload.recoveryRequired || uploadIntent(upload));
    const html = unresolved.map(upload => uploadStatusMarkup(upload, true)).join('');
    if (summary.innerHTML !== html) summary.innerHTML = html;
    summary.hidden = !unresolved.length;
    uploadMutationMetrics.pending = unresolved.length;
    uploadMutationMetrics.unconfirmed = unresolved.filter(upload => upload.unknown || uploadIntent(upload)?.status === 'unconfirmed').length;
    uploadMutationMetrics.conflicted = unresolved.filter(upload => uploadIntent(upload)?.status === 'conflicted').length;
}

function renderDroppedUploads() {
    clearTimeout(uploadProgressRenderTimer);
    uploadProgressRenderTimer = null;
    for (const upload of droppedUploads.values()) upload.info.upload_detail = uploadText(upload);
    renderDownloadCollections();
    renderUploadRecovery();
}

function acceptUploadReply(upload, data, { settle = true } = {}) {
    if (!uploadIsCurrent(upload) || data?.id !== upload.info.id || !VDL.validUploadState(data.upload) || data.upload.id !== upload.info.id) return false;
    const snapshot = data.upload;
    const known = tagState.selectDownload(upload.info.id);
    // Byte counts can advance within one phase revision. Skip unchanged
    // render reconciliation so a store notification cannot feed itself.
    const removalRevision = typeof data.removal_revision === 'string' && /^(0|[1-9]\d*)$/.test(data.removal_revision) ? data.removal_revision : null;
    const merge = removalRevision !== null && (!known?.removal_revision || BigInt(removalRevision) > BigInt(known.removal_revision)) || !known?.upload || BigInt(snapshot.revision) > BigInt(known.upload.revision)
        || snapshot.revision === known.upload.revision && (settle || snapshot.downloaded_bytes > known.upload.downloaded_bytes)
        || data.download && !known.filename;
    if (merge && !tagState.acceptDownload({ ...(data.download || {}), ...(removalRevision === null ? {} : { removal_revision: removalRevision }), id: upload.info.id, upload_revision: snapshot.revision, upload: snapshot })) return false;
    const canonical = tagState.selectDownload(upload.info.id)?.upload;
    if (!canonical) return false;
    upload.registered = true;
    upload.recoveryRequired = !!canonical.recovery_required;
    const transportPhase = upload.phase;
    upload.phase = canonical.phase;
    if (upload.transferStarted && !upload.adopted && ['registered', 'transferring'].includes(canonical.phase)) {
        upload.phase = transportPhase === 'processing' ? 'processing' : 'transferring';
    }
    upload.info.status = upload.transferStarted && !upload.adopted && canonical.phase === 'registered' ? 'downloading' : canonical.download_status;
    upload.info.downloaded_bytes = Math.max(upload.info.downloaded_bytes || 0, canonical.downloaded_bytes);
    upload.info.total_bytes = canonical.total_bytes;
    upload.info.progress = `${Math.min(100, upload.info.downloaded_bytes / canonical.total_bytes * 100).toFixed(1)}%`;
    if (data.download && data.download.id === upload.info.id && canonical.phase === 'published') upload.info = { ...upload.info, ...data.download };
    if (['published', 'cancelled', 'failed'].includes(canonical.phase)) {
        upload.settled = !upload.recoveryRequired;
        upload.file = null;
        if (canonical.phase === 'failed' && typeof data.error === 'string') upload.failure = data.error;
        if (settle) upload.unknown = false;
        upload.timers.forEach(clearTimeout);
        upload.timers = [];
    }
    return true;
}

function handleUploadMutationEvent(event) {
    const upload = [...droppedUploads.values()].find(entry => entry.registerIntentId === event.intentId || entry.cancelIntentId === event.intentId);
    if (!upload || !uploadIsCurrent(upload)) return;
    if (event.outcome === 'reconciliation') uploadMutationMetrics.reconciliationReads++;
    if (event.outcome === 'confirmed') {
        const model = tagState.selectDownload(upload.info.id);
        if (model?.upload) acceptUploadReply(upload, { id: upload.info.id, upload: model.upload, ...(model.upload.phase === 'published' && model.filename ? { download: model } : {}) });
        upload.unknown = false;
        const registration = event.action === 'upload.register';
        if (registration) upload.registerIntentId = null;
        else upload.cancelIntentId = null;
        // Coordinator retirement completes after its event; dispatch a successor
        // only after the original immutable attempt has left the conflict domain.
        queueMicrotask(() => {
            if (!uploadIsCurrent(upload)) return;
            if (upload.stopRequested && !upload.settled) stopDroppedUpload(upload);
            else if (registration && !upload.settled) beginDroppedTransfer(upload);
            renderDroppedUploads();
        });
    } else if (event.outcome === 'unconfirmed') upload.unknown = true;
    else if (['rejected', 'conflicted'].includes(event.outcome)) {
        if (!upload.registered) upload.info.status = 'interrupted';
        upload.settled = false;
    }
    renderDroppedUploads();
}

function recordUploadOutcome(upload, outcome, startedAt) {
    if (!uploadIsCurrent(upload)) return;
    for (const metrics of [uploadMutationMetrics, mutationMetrics]) {
        if (outcome === 'confirmed') { metrics.acknowledgements++; metrics.latestAcknowledgementMs = Math.max(0, performance.now() - startedAt); }
        if (outcome === 'unconfirmed' && !upload.unknown) metrics.unconfirmedOutcomes++;
    }
}

function transferDroppedVideo(id, file) {
    const upload = droppedUploads.get(String(id));
    if (!upload || !uploadIsCurrent(upload) || activeUploadRequests.has(String(id))) return Promise.reject(new Error('Upload transfer is unavailable'));
    return new Promise(resolve => {
        const request = new XMLHttpRequest();
        const sentAt = performance.now();
        activeUploadRequests.set(String(id), request);
        const current = () => uploadIsCurrent(upload) && activeUploadRequests.get(String(id)) === request;
        request.open('PUT', '/api/upload/' + encodeURIComponent(id));
        request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        request.upload.onprogress = event => {
            if (!current() || upload.stopRequested) return;
            upload.info.downloaded_bytes = event.loaded;
            if (event.loaded >= file.size) {
                upload.phase = 'processing';
                if (!upload.timers.length) {
                    upload.timers.push(setTimeout(() => {
                        if (current() && !upload.settled) { upload.delayed = true; renderDroppedUploads(); }
                    }, 5000));
                    upload.timers.push(setTimeout(() => {
                        if (current() && !upload.settled) { upload.unknown = true; renderDroppedUploads(); }
                    }, 30000));
                }
            }
            if (uploadProgressRenderTimer === null) uploadProgressRenderTimer = setTimeout(renderDroppedUploads, 150);
        };
        request.onload = () => {
            if (!current()) { resolve(null); return; }
            let data = null;
            try { data = JSON.parse(request.responseText || '{}'); } catch (_) { /* A malformed acknowledgement leaves publication unknown. */ }
            if (request.status === 401) { resetTagSession(); resolve(null); return; }
            if (request.status === 403 || request.status === 404) { tagMutations.fence(String(id)); resolve(null); return; }
            if (upload.protocol) {
                if (!acceptUploadReply(upload, data)) { recordUploadOutcome(upload, 'unconfirmed', sentAt); upload.unknown = true; }
                else recordUploadOutcome(upload, 'confirmed', sentAt);
            } else if (request.status >= 200 && request.status < 300 && data?.id === id) {
                upload.phase = 'published'; upload.settled = true; upload.file = null;
                recordUploadOutcome(upload, 'confirmed', sentAt);
            } else if (request.status === 409 && data?.error === 'Upload cancelled') {
                upload.phase = 'cancelled'; upload.info.status = 'cancelled'; upload.settled = true; upload.file = null;
            } else { recordUploadOutcome(upload, 'unconfirmed', sentAt); upload.unknown = true; }
            resolve(data);
        };
        request.onerror = request.onabort = () => {
            if (current() && !upload.settled) { recordUploadOutcome(upload, 'unconfirmed', sentAt); upload.unknown = true; }
            // A local abort says nothing about server cancellation or publication.
            resolve(null);
        };
        request.onloadend = () => {
            const owned = activeUploadRequests.get(String(id)) === request;
            if (owned) activeUploadRequests.delete(String(id));
            upload.timers.forEach(clearTimeout); upload.timers = [];
            if (!owned || !uploadIsCurrent(upload)) return;
            renderDroppedUploads();
            fetchHistory({ sortFavorites: true }).catch(() => {});
        };
        request.send(file);
    });
}

async function beginDroppedTransfer(upload) {
    if (!uploadIsCurrent(upload) || upload.transferStarted || upload.stopRequested || upload.settled || !upload.file) return;
    upload.transferStarted = true;
    upload.phase = 'transferring';
    upload.info.status = 'downloading';
    renderDroppedUploads();
    try { await transferDroppedVideo(upload.info.id, upload.file); }
    catch (_) { if (uploadIsCurrent(upload)) upload.unknown = true; }
    if (uploadIsCurrent(upload)) renderDroppedUploads();
}

async function registerDroppedVideo(upload, file) {
    if (!uploadIsCurrent(upload) || upload.registrationStarted) return;
    upload.registrationStarted = true;
    if (!upload.protocol) for (const metrics of [uploadMutationMetrics, mutationMetrics]) metrics.submissions++;
    if (upload.protocol) {
        tagState.acceptDownload({ ...upload.info, upload_revision: '0', upload: null });
        const submitted = tagMutations.submit({ kind: 'upload.register', targetId: upload.info.id, value: { filename: file.name, filesize: file.size } });
        if (submitted.accepted) upload.registerIntentId = submitted.intentId;
        else { upload.info.status = 'interrupted'; upload.phase = 'failed'; upload.failure = submitted.message; upload.settled = true; upload.file = null; showActionError(submitted.message); }
        renderDroppedUploads();
        return;
    }
    try {
        const response = await apiFetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: upload.info.id, filename: file.name, filesize: file.size }) });
        const data = await response.json().catch(() => null);
        if (!uploadIsCurrent(upload)) return;
        if (!response.ok || data?.id !== upload.info.id) {
            if (response.status === 400) { upload.phase = 'failed'; upload.info.status = 'interrupted'; upload.settled = true; upload.file = null; }
            else upload.unknown = true;
            upload.info.upload_detail = data?.error || 'Upload registration not confirmed';
            if (upload.phase === 'failed') { upload.failure = upload.info.upload_detail; showActionError(upload.failure); }
        } else {
            upload.registered = true; upload.phase = 'registered';
            if (upload.stopRequested) await stopDroppedUpload(upload);
            else await beginDroppedTransfer(upload);
        }
    } catch (_) { if (uploadIsCurrent(upload)) upload.unknown = true; }
    if (uploadIsCurrent(upload)) renderDroppedUploads();
}

function uploadDroppedVideos(files) {
    hideUploadOverlay();
    if (!files.length) return;
    closeAllMenus(); hideActionError();
    const startedAt = performance.now();
    const uploads = [];
    for (const file of files) {
        if (droppedUploads.size >= 128) { showActionError('Resolve pending uploads before adding more files.'); break; }
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
        const upload = {
            epoch: tagSessionEpoch, file, timers: [], protocol: hasUploadProtocol(), phase: 'registering',
            registered: false, stopRequested: false, settled: false, unknown: false,
            info: { id, title: file.name, requested_filename: file.name, source_type: 'upload', url: '', status: 'starting',
                progress: '0%', downloaded_bytes: 0, total_bytes: file.size, filesize: file.size,
                created_at: Date.now() / 1000, upload_detail: 'Registering upload…' },
        };
        droppedUploads.set(id, upload); uploads.push(upload);
    }
    renderDroppedUploads();
    uploadMutationMetrics.latestLocalFeedbackMs = Math.max(0, performance.now() - startedAt);
    mutationMetrics.latestLocalFeedbackMs = uploadMutationMetrics.latestLocalFeedbackMs;
    uploads.forEach(upload => registerDroppedVideo(upload, upload.file));
}

async function stopDroppedUpload(upload) {
    if (!uploadIsCurrent(upload) || ['published', 'cancelled', 'failed'].includes(upload.phase)) return;
    const startedAt = performance.now();
    upload.stopRequested = true;
    renderDroppedUploads();
    uploadMutationMetrics.latestLocalFeedbackMs = Math.max(0, performance.now() - startedAt);
    mutationMetrics.latestLocalFeedbackMs = uploadMutationMetrics.latestLocalFeedbackMs;
    activeUploadRequests.get(upload.info.id)?.abort();
    if (!upload.registered || upload.registerIntentId && tagMutations.status(upload.registerIntentId)) return;
    if (upload.protocol) {
        if (upload.cancelIntentId || upload.cancelSubmitted) return;
        const result = tagMutations.submit({ kind: 'upload.cancel', targetId: upload.info.id, value: {} });
        if (result.accepted) { upload.cancelSubmitted = true; upload.cancelIntentId = result.intentId; }
        else upload.unknown = true;
        renderDroppedUploads();
        return;
    }
    if (upload.cancelSubmitted) return;
    upload.cancelSubmitted = true;
    for (const metrics of [uploadMutationMetrics, mutationMetrics]) metrics.submissions++;
    try {
        const response = await apiFetch('/api/stop/' + encodeURIComponent(upload.info.id), { method: 'POST' });
        const data = await response.json().catch(() => null);
        if (!uploadIsCurrent(upload)) return;
        if (response.ok && data?.upload && VDL.validUploadState(data.upload)) acceptUploadReply(upload, data);
        // Legacy acceptance may merely set a worker flag. Its collection state,
        // rather than the fetch abort, establishes eventual cancellation.
        else upload.unknown = true;
    } catch (_) { if (uploadIsCurrent(upload)) upload.unknown = true; }
    if (uploadIsCurrent(upload)) { renderDroppedUploads(); fetchHistory().catch(() => {}); }
}

function adoptServerUploads(entries) {
    if (!hasUploadProtocol()) return;
    for (const info of entries) {
        if (info.source_type !== 'upload' || info.can_manage_upload !== true || !VDL.validUploadState(info.upload) || droppedUploads.has(String(info.id))) continue;
        if (['published', 'cancelled', 'failed'].includes(info.upload.phase) && !info.upload.recovery_required) continue;
        const upload = { epoch: tagSessionEpoch, file: null, timers: [], protocol: true, phase: info.upload.phase,
            registered: true, registrationStarted: true, transferStarted: true,
            stopRequested: !!info.upload.cancel_requested, settled: false, unknown: false,
            info: { ...info }, adopted: true };
        droppedUploads.set(String(info.id), upload);
        acceptUploadReply(upload, { id: String(info.id), upload: info.upload });
    }
}

function uploadCollectionData() {
    const byId = new Map(collectionSnapshots.current.concat(collectionSnapshots.library).map(info => [String(info.id), info]));
    const announcements = [];
    for (const [id, upload] of droppedUploads) {
        if (!uploadIsCurrent(upload)) continue;
        const server = byId.get(id);
        if (upload.protocol && server?.upload && VDL.validUploadState(server.upload)) acceptUploadReply(upload, { id, upload: server.upload, ...(server.status === 'finished' ? { download: server } : {}) }, { settle: false });
        if (!upload.protocol && server && ['finished', 'cancelled', 'error'].includes(server.status)) {
            upload.phase = ({ finished: 'published', cancelled: 'cancelled', error: 'failed' })[server.status];
            upload.settled = true; upload.unknown = false; upload.file = null; upload.info = { ...upload.info, ...server };
        }
        const announcement = `${upload.info.title}: ${uploadText(upload)}`;
        if (upload.announcedText !== announcement) {
            upload.announcedText = announcement;
            announcements.push(announcement);
        }
        const confirmed = tagState.selectDownload(id);
        byId.set(id, { ...server, ...upload.info, ...(confirmed?.upload ? { upload: confirmed.upload, upload_revision: confirmed.upload_revision } : {}), downloaded_bytes: Math.max(server?.downloaded_bytes || 0, upload.info.downloaded_bytes) });
        if (upload.settled && !upload.unknown && !uploadIntent(upload) && server && server.status === upload.info.status) droppedUploads.delete(id);
    }
    // The active dialog owns an inner live region; phase text changes once,
    // while byte progress and repeat renders remain silent.
    if (announcements.length) announceTagStatus(announcements.join('. '));
    return [...byId.values()];
}

document.addEventListener('click', async event => {
    const button = event.target.closest('[data-upload-recovery]');
    if (!button) return;
    const upload = droppedUploads.get(button.dataset.uploadId);
    if (!upload || !uploadIsCurrent(upload) || upload.checking) return;
    if (button.dataset.uploadRecovery === 'current') { openCurrentDownloads(); fetchHistory().catch(() => {}); return; }
    if (button.dataset.uploadRecovery === 'dismiss') {
        const intentId = upload.cancelIntentId || upload.registerIntentId;
        if (intentId && tagMutations.resolve(intentId)) {
            upload.cancelIntentId = null; upload.registerIntentId = null;
            if (!upload.registered) { droppedUploads.delete(upload.info.id); upload.file = null; }
            else {
                upload.stopRequested = false; upload.cancelSubmitted = false;
                upload.settled = ['published', 'cancelled', 'failed'].includes(upload.phase) && !upload.recoveryRequired;
                if (upload.settled) upload.file = null;
            }
        }
        renderDroppedUploads(); return;
    }
    upload.checking = true;
    renderDroppedUploads();
    try {
        const intentId = upload.cancelIntentId || upload.registerIntentId;
        if (intentId && tagMutations.status(intentId)?.status === 'unconfirmed') await tagMutations.recover(intentId, { replay: button.dataset.uploadRecovery === 'replay' });
        if (!uploadIsCurrent(upload)) return;
        if (button.dataset.uploadRecovery === 'check') {
            uploadMutationMetrics.reconciliationReads++; mutationMetrics.reconciliationReads++;
            const response = await apiFetch(`/api/upload/${encodeURIComponent(upload.info.id)}/status`);
            const data = await response.json().catch(() => null);
            if (!uploadIsCurrent(upload)) return;
            if ((response.status === 403 || response.status === 404 && data?.error !== 'Mutation unavailable') && upload.registered) tagMutations.fence(upload.info.id);
            else if (response.status === 403 || response.status === 404) upload.unknown = true;
            else if (response.ok && acceptUploadReply(upload, data)) {
                if (!uploadIntent(upload) && !upload.stopRequested && !upload.transferStarted && upload.phase === 'registered') await beginDroppedTransfer(upload);
                else if (upload.stopRequested && upload.phase === 'registered') stopDroppedUpload(upload);
                if (!['published', 'cancelled', 'failed'].includes(upload.phase) && upload.transferStarted && !activeUploadRequests.has(upload.info.id)) upload.unknown = true;
            }
        }
    } catch (_) {
        if (uploadIsCurrent(upload)) upload.unknown = true;
    } finally {
        if (uploadIsCurrent(upload)) { upload.checking = false; renderDroppedUploads(); }
    }
});

document.addEventListener('dragenter', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    uploadDragDepth += 1;
    showUploadOverlay(
        'Drop video to add it',
        'The original file will be copied into your library.',
    );
});

document.addEventListener('dragover', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', event => {
    // A final page exit may follow several descendant enters, so it is authoritative
    // even when the browser no longer exposes the external drag's data types.
    if (event.relatedTarget === null && uploadDragDepth > 0) {
        uploadDragDepth = 0;
        hideUploadOverlay();
        return;
    }
    if (!isFileDrag(event)) return;
    uploadDragDepth = Math.max(0, uploadDragDepth - 1);
    if (uploadDragDepth === 0) hideUploadOverlay();
});

document.addEventListener('drop', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    uploadDragDepth = 0;
    const files = Array.from(event.dataTransfer.files || []);
    uploadDroppedVideos(files);
});

uploadDropOverlay.addEventListener('cancel', event => {
    event.preventDefault();
    uploadDragDepth = 0;
    hideUploadOverlay();
});

function updateApiVersion(version, unavailable) {
    const footer = document.getElementById('versionFooter');
    const apiVersion = document.getElementById('apiVersion');
    const warning = document.getElementById('versionWarning');
    const status = document.getElementById('versionStatus');
    const uiVersion = footer.dataset.uiVersion;

    if (unavailable) {
        apiVersion.textContent = 'API unavailable';
        warning.hidden = true;
        footer.classList.remove('version-mismatch');
        status.textContent = 'API version is unavailable.';
        return;
    }

    const usableVersion = typeof version === 'string' && version.trim()
        ? version.trim()
        : null;
    const apiLabel = usableVersion ? `API v${usableVersion}` : 'API unknown';
    const mismatched = usableVersion !== uiVersion;
    apiVersion.textContent = apiLabel;
    warning.hidden = !mismatched;
    footer.classList.toggle('version-mismatch', mismatched);
    status.textContent = mismatched
        ? `Version mismatch: UI version ${uiVersion}; ${apiLabel}. Use the Refresh page link to load the current UI.`
        : `UI and API version ${uiVersion} match.`;
}

let uptimeBaseline = null;

function formatUptime(seconds) {
    const totalSeconds = Math.max(0, Math.floor(Number(seconds)));
    const units = [
        { seconds: 365 * 24 * 60 * 60, label: 'Year' },
        { seconds: 30 * 24 * 60 * 60, label: 'Month' },
        { seconds: 24 * 60 * 60, label: 'Day' },
        { seconds: 60 * 60, label: 'Hour' },
        { seconds: 60, label: 'Minute' },
        { seconds: 1, label: 'Second' },
    ];
    const unit = units.find(candidate => totalSeconds >= candidate.seconds)
        || units[units.length - 1];
    const value = Math.floor(totalSeconds / unit.seconds);
    return `${value} ${unit.label}${value === 1 ? '' : 's'}`;
}

function renderUptime() {
    if (!uptimeBaseline) return;
    const elapsedSeconds = Math.max(0, (Date.now() - uptimeBaseline.receivedAt) / 1000);
    document.getElementById('uptime').textContent =
        `Uptime ${formatUptime(uptimeBaseline.seconds + elapsedSeconds)}`;
}

function updateUptime(seconds, unavailable) {
    const uptime = document.getElementById('uptime');
    if (unavailable) {
        uptimeBaseline = null;
        uptime.textContent = 'Uptime unavailable';
        return;
    }

    const usableSeconds = Number(seconds);
    if (typeof seconds !== 'number' || !Number.isFinite(usableSeconds) || usableSeconds < 0) {
        uptimeBaseline = null;
        uptime.textContent = 'Uptime unknown';
        return;
    }

    uptimeBaseline = { seconds: usableSeconds, receivedAt: Date.now() };
    renderUptime();
}

function checkHealth() {
    return apiFetch('/api/health')
        .then(res => {
            if (!res.ok) throw new Error(`Health check failed with status ${res.status}`);
            return res.json();
        })
        .then(data => {
            updateApiVersion(data && data.version, false);
            updateUptime(data && data.uptime_seconds, false);
        })
        .catch(() => {
            showServerStatus('/api/health');
            updateApiVersion(null, true);
            updateUptime(null, true);
        });
}

let libraryStorageSnapshot = null;
let libraryStorageEpoch = 0;

function formatVideoStorage(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)
            || !Number.isInteger(bytes) || bytes < 0) return null;
    const total = BigInt(bytes);
    if (total < 1000n) return `${total} B`;
    const units = ['B', 'k', 'M', 'G', 'T', 'P', 'E'];
    let unit = 1;
    let divisor = 1000n;
    while (unit < units.length - 1 && total >= divisor * 1000n) {
        divisor *= 1000n;
        unit += 1;
    }
    // Integer arithmetic preserves upward ties at decimal unit boundaries.
    let tenths = (total * 10n + divisor / 2n) / divisor;
    if (tenths >= 10000n && unit < units.length - 1) {
        divisor *= 1000n;
        unit += 1;
        tenths = (total * 10n + divisor / 2n) / divisor;
    }
    return `${tenths / 10n}.${tenths % 10n} ${units[unit]}`;
}

function parseLibraryStorage(data) {
    if (!data || !['calculating', 'ready', 'stale', 'unavailable'].includes(data.state)) return null;
    if (data.state === 'calculating' || data.state === 'unavailable') {
        return data.total_bytes === null && data.measured_at === null && data.next_refresh_at === null
            ? { total_bytes: null, measured_at: null, next_refresh_at: null, state: data.state } : null;
    }
    const utcTime = value => typeof value === 'string'
        && /(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
    if (formatVideoStorage(data.total_bytes) === null
            || !utcTime(data.measured_at) || !utcTime(data.next_refresh_at)
            || Date.parse(data.next_refresh_at) <= Date.parse(data.measured_at)) return null;
    return {
        total_bytes: data.total_bytes, measured_at: data.measured_at,
        next_refresh_at: data.next_refresh_at, state: data.state,
    };
}

function renderLibraryStorage() {
    const snapshot = libraryStorageSnapshot;
    const state = snapshot?.state || 'calculating';
    let label = state === 'unavailable' ? 'Videos unavailable' : 'Videos calculating…';
    let detail = state === 'unavailable'
        ? 'A measurement is unavailable. The server will retry automatically.'
        : 'The first measurement is being calculated.';
    if (snapshot?.total_bytes !== null && snapshot?.total_bytes !== undefined) {
        label = `Videos ${formatVideoStorage(snapshot.total_bytes)}${state === 'stale' ? ' (stale)' : ''}`;
        const measured = new Date(snapshot.measured_at);
        detail = `Last successful measurement: ${measured.toLocaleString()}.`;
        if (state === 'stale') detail += ' This measurement is stale; a refresh is pending or unavailable.';
    }
    const summary = document.getElementById('libraryStorageLabel');
    const updated = document.getElementById('libraryStorageUpdated');
    // Focus and SSE can reconcile the same generation repeatedly. Leave the
    // accessible text intact when its meaning has not changed.
    if (summary.textContent !== label) summary.textContent = label;
    if (updated.textContent !== detail) updated.textContent = detail;
    document.getElementById('libraryStorage').dataset.state = state;
}

function clearLibraryStorage() {
    libraryStorageEpoch += 1;
    libraryStorageSnapshot = null;
    document.getElementById('libraryStorage').open = false;
    renderLibraryStorage();
}

function fetchLibraryStorage() {
    return coordinateRefresh('library-storage', async () => {
        const epoch = libraryStorageEpoch;
        try {
            const response = await apiFetch('/api/library-storage', { cache: 'no-store' });
            if (!response.ok) throw Object.assign(new Error('Video storage is unavailable.'), { status: response.status });
            const snapshot = parseLibraryStorage(await response.json());
            if (!snapshot) throw new Error('Invalid video storage response.');
            if (epoch !== libraryStorageEpoch) return;
            libraryStorageSnapshot = snapshot;
        } catch (error) {
            if (epoch !== libraryStorageEpoch) return;
            if (error.status === 401 || error.status === 403) clearLibraryStorage();
            libraryStorageSnapshot = libraryStorageSnapshot?.total_bytes !== null
                    && libraryStorageSnapshot?.total_bytes !== undefined
                ? { ...libraryStorageSnapshot, state: 'stale' }
                : { total_bytes: null, measured_at: null, next_refresh_at: null, state: 'unavailable' };
        }
        renderLibraryStorage();
    });
}

const storageAccountChannel = typeof BroadcastChannel === 'function'
    ? new BroadcastChannel('vdl-account') : null;
if (storageAccountChannel) storageAccountChannel.onmessage = () => {
    clearLibraryStorage();
    resetTagSession();
};
document.querySelector('form.logout-form')?.addEventListener('submit', () => {
    clearLibraryStorage();
    storageAccountChannel?.postMessage('signed-out');
});
window.addEventListener('pagehide', clearLibraryStorage);
window.addEventListener('pageshow', event => {
    if (event.persisted) {
        fetchLibraryStorage();
        fetchHistory();
        loadTagCapabilities();
    }
});

setInterval(() => {
    checkHealth();
}, 30000);
setInterval(renderUptime, 1000);

checkHealth();

function startDownload(event) {
    if (event) event.preventDefault();
    const url = urlInput.value.trim();
    if (downloadSubmitting || probeState !== 'ready' || url !== probedUrl) return;
    const generation = probeGeneration;
    const dialogSession = newDownloadSession;
    downloadSubmitting = true;
    renderProbeState();
    const selectedQuality = document.getElementById('optionsQualitySelect').value;
    const selectedContainer = document.getElementById('optionsContainerSelect').value;
    const customFilename = document.getElementById('optionsFilename').value;
    
    let finalFormat = selectedQuality;
    if (selectedContainer) {
        const container = selectedContainer;
        const audioExt = container === 'mp4' ? 'm4a' : container;
        if (selectedQuality) {
            const qualityMatch = selectedQuality.match(/^(bestvideo\[height<=\d+\])\+bestaudio\/best$/);
            if (qualityMatch) {
                finalFormat = `${qualityMatch[1]}[ext=${container}]+bestaudio[ext=${audioExt}]/best[ext=${container}]`;
            } else {
                finalFormat = `${selectedQuality}[ext=${container}]`;
            }
        } else {
            finalFormat = `bestvideo[ext=${container}]+bestaudio[ext=${audioExt}]/best[ext=${container}]`;
        }
    }
    
    for (const id of ['optionsQualitySelect', 'optionsContainerSelect', 'optionsFilename']) downloadOptionValues.set(id, document.getElementById(id).value);
    submitDownloadRequest({ url, ...(finalFormat ? { format: finalFormat } : {}), ...(customFilename ? { filename: customFilename } : {}) }, {
        generation, dialogSession, draftGeneration: downloadDraftGeneration,
        fields: downloadOptionDraft(),
    });
}

function downloadOptionDraft() {
    return { url: urlInput.value.trim(), quality: document.getElementById('optionsQualitySelect').value,
        container: document.getElementById('optionsContainerSelect').value, filename: document.getElementById('optionsFilename').value };
}
function downloadSubmissionIntent() {
    return downloadSubmission?.intentId ? tagMutations.status(downloadSubmission.intentId) : downloadSubmission?.legacy || null;
}
function resetDownloadSubmission(clearDraft = false) {
    downloadSubmission?.timers?.forEach(clearTimeout);
    const oldKey = downloadSubmission?.key;
    downloadSubmission = null;
    if (oldKey) tagState.writer.forgetSubmission(oldKey);
    downloadSubmitting = false;
    if (clearDraft) {
        downloadDraftGeneration++;
        // Authentication changes discard the private draft and invalidate old probes.
        urlInput.value = '';
        invalidateProbe();
        updateUrlClear();
    }
    renderDownloadSubmission();
}
function downloadSubmissionText(entry) {
    if (downloadSubmission?.accepted) return downloadSubmission.accepted.status === 'interrupted'
        ? 'Download request accepted; work was interrupted. Review Current downloads to resume or retry.'
        : 'Download request accepted. Worker status updates separately.';
    return entry?.message || 'Starting download…';
}
function renderDownloadSubmission() {
    const entry = downloadSubmissionIntent();
    const active = !!entry && ['queued', 'sending', 'unconfirmed', 'conflicted'].includes(entry.status);
    downloadSubmitting = active;
    const button = (mode, label) => `<button type="button" data-submission-recovery="${mode}">${label}</button>`;
    const actions = entry?.status === 'unconfirmed' ? (entry.legacy ? button('current', 'Check Current downloads') : button('check', 'Check request') + button('replay', 'Recover request') + button('resolve', 'Resolve request'))
        : entry?.status === 'rejected' ? button('restore', 'Use submitted input') + button('resolve', 'Review input')
        : downloadSubmission?.accepted ? button('dismiss', 'Dismiss') : '';
    const text = downloadSubmission ? downloadSubmissionText(entry) : '';
    const html = text ? `<span>${escapeHtml(text)}</span>${actions}` : '';
    for (const id of ['downloadSubmissionStatus', 'downloadSubmissionSummary']) {
        const node = document.getElementById(id);
        if (!node) continue;
        if (node.innerHTML !== html) node.innerHTML = html;
        node.hidden = !text;
        node.dataset.submissionState = downloadSubmission?.accepted ? 'accepted' : entry?.status || '';
        node.dataset.downloadId = downloadSubmission?.accepted?.download_id || '';
        node.dataset.jobId = downloadSubmission?.accepted?.id || '';
        node.dataset.attemptId = downloadSubmission?.accepted?.attempt_id || '';
    }
    const summary = document.getElementById('downloadSubmissionSummary');
    if (summary) summary.hidden = !text || document.getElementById('newDownloadDialog').open;
    for (const [field, states] of [['pending', ['queued', 'sending', 'unconfirmed', 'conflicted']], ['unconfirmed', ['unconfirmed']], ['conflicted', ['conflicted']]]) {
        downloadSubmissionMetrics[field] = states.includes(entry?.status) ? 1 : 0;
    }
    renderProbeState();
}
function finishDownloadSubmission(record, job) {
    if (downloadSubmission !== record) return;
    record.timers?.forEach(clearTimeout);
    record.accepted = job;
    record.legacy = null;
    downloadSubmitting = false;
    if (record.generation === probeGeneration && record.dialogSession === newDownloadSession
            && record.draftGeneration === downloadDraftGeneration
            && JSON.stringify(record.fields) === JSON.stringify(downloadOptionDraft())) {
        urlInput.value = '';
        invalidateProbe();
        updateUrlClear();
        if (optionsDetails && !optionsOpenedManually) setOptionsOpen(false);
        closeNewDownload();
    }
    renderDownloadSubmission();
}
function handleDownloadSubmissionEvent(event) {
    const record = downloadSubmission;
    if (!record || record.intentId && record.intentId !== event.intentId) return;
    if (!record.intentId) record.intentId = event.intentId;
    if (event.outcome === 'confirmed') {
        const job = tagMutations.status(event.intentId)?.acceptedJob;
        if (job) finishDownloadSubmission(record, job);
    } else {
        renderDownloadSubmission();
    }
    if (event.outcome === 'reconciliation') downloadSubmissionMetrics.reconciliationReads++;
}
function submitDownloadRequest(value, draft) {
    const started = performance.now();
    if (downloadSubmission?.intentId && !tagMutations.resolve(downloadSubmission.intentId)) {
        // A confirmed operation has already left the coordinator; unresolved
        // acceptance must retain its identity until explicit recovery settles it.
        if (tagMutations.status(downloadSubmission.intentId)) { renderDownloadSubmission(); return; }
    }
    downloadSubmission?.timers?.forEach(clearTimeout);
    const oldKey = downloadSubmission?.key;
    downloadSubmission = null;
    if (oldKey) tagState.writer.forgetSubmission(oldKey);
    const record = { ...draft, value, key: `submission:${++downloadSubmissionSequence}`, timers: [] };
    downloadSubmission = record;
    if (tagCapabilities?.mutation_protocol === 1 && tagCapabilities.actions?.includes('download.submit')) {
        tagState.acceptDownload({ id: record.key, submission_revision: '0', submission: null });
        const result = tagMutations.submit({ kind: 'download.submit', targetId: record.key, value, viewToken: draft.dialogSession });
        if (!result.accepted) {
            record.legacy = { status: 'rejected', message: result.message, legacy: true };
            renderDownloadSubmission();
            return;
        }
        record.intentId = result.intentId;
    } else {
        record.legacy = { status: 'sending', message: 'Starting download…', legacy: true };
        for (const metrics of [downloadSubmissionMetrics, mutationMetrics]) metrics.submissions++;
        const epoch = tagSessionEpoch;
        const current = () => downloadSubmission === record && epoch === tagSessionEpoch;
        const unknown = () => {
            if (!current()) return;
            if (record.legacy.status !== 'unconfirmed') for (const metrics of [downloadSubmissionMetrics, mutationMetrics]) metrics.unconfirmedOutcomes++;
            record.legacy.status = 'unconfirmed';
            record.legacy.message = 'Download request not confirmed. This server cannot safely recover it. Check Current downloads, then reload to intentionally start a separate request; the original may still complete.';
            renderDownloadSubmission();
        };
        record.timers = [setTimeout(() => {
            if (!current() || record.legacy?.status !== 'sending') return;
            record.legacy.message = 'Still waiting for download request confirmation.';
            renderDownloadSubmission();
        }, 5000), setTimeout(unknown, 30000)];
        Promise.resolve().then(() => {
            if (!current()) return;
            return apiFetch('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
        }).then(async response => {
            if (!response) return;
            const body = await response.json().catch(() => null);
            if (!current()) return;
            if ([401, 403].includes(response.status)) { resetDownloadSubmission(); return; }
            if (response.ok && typeof body?.id === 'string' && body.id) {
                if (tagState.isFenced(body.id)) { resetDownloadSubmission(); return; }
                for (const metrics of [downloadSubmissionMetrics, mutationMetrics]) { metrics.acknowledgements++; metrics.latestAcknowledgementMs = performance.now() - started; }
                finishDownloadSubmission(record, { id: '', download_id: body.id, attempt_id: '', status: 'accepted' });
                fetchHistory();
            } else if ([400, 409, 413, 422, 429].includes(response.status)) {
                record.legacy.status = 'rejected';
                record.legacy.message = 'Download request refused. Review the retained input before submitting again.';
                for (const metrics of [downloadSubmissionMetrics, mutationMetrics]) metrics.rejectedOutcomes++;
                renderDownloadSubmission();
            } else unknown();
        }).catch(unknown).finally(() => record.timers.forEach(clearTimeout));
    }
    renderDownloadSubmission();
    downloadSubmissionMetrics.latestLocalFeedbackMs = Math.max(0, performance.now() - started);
    mutationMetrics.latestLocalFeedbackMs = downloadSubmissionMetrics.latestLocalFeedbackMs;
}
document.addEventListener('click', async event => {
    const button = event.target.closest('[data-submission-recovery]');
    const record = downloadSubmission;
    if (!button || !record) return;
    const action = button.dataset.submissionRecovery;
    const entry = downloadSubmissionIntent();
    if (action === 'current' && entry?.legacy) {
        closeNewDownload();
        openCurrentDownloads();
        downloadSubmissionMetrics.reconciliationReads++;
        await fetchHistory();
        return;
    }
    if (action === 'check' || action === 'replay') {
        await tagMutations.recover(record.intentId, action === 'replay' ? { replay: true } : {});
    } else {
        if (action !== 'dismiss' && (record.legacy ? entry?.status !== 'rejected' : entry && !tagMutations.resolve(record.intentId))) {
            announceTagStatus('The original download request may still complete. Check its status before submitting again.');
            return;
        }
        if (action === 'restore') {
            openNewDownload();
            const fields = record.fields;
            if (urlInput.value !== fields.url || probedUrl !== fields.url.trim()) {
                urlInput.value = fields.url;
                scheduleProbe(fields.url.trim(), 0);
            }
            // Restore only choices available in the current probe; a new URL
            // must finish its own probe before its options can be selected.
            for (const [id, value] of [['optionsQualitySelect', fields.quality], ['optionsContainerSelect', fields.container]]) {
                const select = document.getElementById(id);
                if ([...select.options].some(option => option.value === value)) select.value = value;
            }
            document.getElementById('optionsFilename').value = fields.filename;
            downloadDraftGeneration++;
            downloadRestoredOptions = { fields, generation: probeGeneration, draftGeneration: downloadDraftGeneration, dialogSession: newDownloadSession };
            updateUrlClear();
        }
        record.timers.forEach(clearTimeout);
        downloadSubmission = null;
        tagState.writer.forgetSubmission(record.key);
        downloadSubmitting = false;
        if (action === 'resolve') openNewDownload();
    }
    renderDownloadSubmission();
});

let probeTimeout;
// A request may finish after its URL has been replaced or cleared. Generation
// checks keep those callbacks from restoring options for an obsolete input.
let probeGeneration = 0;
let probeState = 'empty';
let probedUrl = '';
let downloadSubmitting = false;
let downloadDraftGeneration = 0;
let downloadRestoredOptions = null;
let downloadSubmission = null;
let downloadSubmissionSequence = 0;
const urlInput = document.getElementById('urlInput');
const urlClear = document.getElementById('urlClear');
const optionsDetails = document.querySelector('#optionsContainer details');
const downloadOptionValues = new Map();

function updateUrlClear() {
    urlClear.style.display = urlInput.value ? '' : 'none';
}

function renderProbeState() {
    const checking = probeState === 'checking';
    const ready = probeState === 'ready';
    const content = document.getElementById('optionsContent');
    const overlay = document.getElementById('optionsOverlay');
    content.dataset.state = downloadSubmitting ? 'submitting' : probeState;
    content.setAttribute('aria-busy', String(checking));
    overlay.classList.toggle('hidden', probeState === 'ready');
    document.getElementById('optionsSpinner').hidden = !checking;
    document.getElementById('optionsRetry').hidden = probeState !== 'error';

    const messages = {
        empty: 'Select a URL to see available options',
        checking: 'Checking video information…',
        ready: 'Video information ready. Download is ready.',
        error: 'Could not load video information. Retry or check the URL.',
    };
    document.getElementById('optionsMessage').textContent = messages[probeState];
    // Keep the live region outside the busy options region, and avoid repeating
    // Checking announcements for each keystroke during the debounce.
    const status = document.getElementById('downloadReadinessStatus');
    const message = downloadSubmission ? downloadSubmissionText(downloadSubmissionIntent()) : messages[probeState];
    if (status.textContent !== message) status.textContent = message;

    for (const id of ['optionsQualitySelect', 'optionsContainerSelect']) {
        const select = document.getElementById(id);
        select.disabled = !ready || select.options.length <= 1;
    }
    document.getElementById('optionsFilename').disabled = !ready;
    document.getElementById('downloadSubmit').disabled = !ready || downloadSubmitting;
    document.getElementById('downloadSubmit').setAttribute('aria-busy', String(downloadSubmitting));
}

function invalidateProbe(state = 'empty') {
    downloadRestoredOptions = null;
    clearTimeout(probeTimeout);
    probeGeneration += 1;
    probedUrl = '';
    resetOptions(state);
}

function scheduleProbe(url, delay = 500) {
    invalidateProbe(url ? 'checking' : 'empty');
    if (!url) return;
    const generation = probeGeneration;
    probedUrl = url;
    setOptionsOpen(true);
    probeTimeout = setTimeout(() => probeVideoUrl(url, generation), delay);
}

urlClear.addEventListener('click', () => {
    downloadDraftGeneration++;
    urlInput.value = '';
    invalidateProbe();
    if (optionsDetails && !optionsOpenedManually) setOptionsOpen(false);
    updateUrlClear();
    urlInput.focus();
});

// Drive the options panel open/close with a max-height animation instead of
// the native instant toggle, so the content slides rather than snapping.
function setOptionsOpen(open) {
    const content = optionsDetails.querySelector('.options-content');
    if (open) {
        optionsDetails.open = true;          // put content in DOM flow first
        // Read scrollHeight after a rAF so the browser has laid out the newly
        // visible content; without this the height can be 0 on the first open.
        requestAnimationFrame(() => {
            content.style.maxHeight = content.scrollHeight + 'px';
        });
    } else {
        optionsOpenedManually = false;
        // If the content is already at zero height (e.g. the panel was never
        // fully opened, or a previous close left it collapsed), there is no
        // transition to wait for — set [open]=false immediately so the chevron
        // and toggle state stay consistent.
        if (!content.style.maxHeight || content.style.maxHeight === '0px' || content.style.maxHeight === '0') {
            optionsDetails.open = false;
            return;
        }
        content.style.maxHeight = '0';
        // Remove [open] after the slide-up finishes so the chevron resets.
        // Filter by target and propertyName so bubbled transitionend events
        // from child elements don't
        // fire this handler prematurely. The setTimeout fallback guarantees
        // [open] is cleared even if transitionend is suppressed (e.g. when
        // the DOM is mutated mid-transition by resetOptions()).
        const closePanel = () => {
            // A new URL can reopen Options before the old close finishes.
            if (content.style.maxHeight === '0px' || content.style.maxHeight === '0') {
                optionsDetails.open = false;
            }
        };
        content.addEventListener('transitionend', (ev) => {
            if (ev.target !== content || ev.propertyName !== 'max-height') return;
            clearTimeout(closeFallback);
            closePanel();
        }, { once: true });
        const closeFallback = setTimeout(closePanel, 250);
    }
}

// Tracks whether the user explicitly opened the panel by clicking the summary,
// as opposed to it being opened automatically when a URL is typed. Used by
// startDownload to decide whether to collapse the panel after submitting.
let optionsOpenedManually = false;

// Intercept summary clicks to use the animated helper instead of native toggle
if (optionsDetails) {
    optionsDetails.querySelector('.options-summary').addEventListener('click', (e) => {
        e.preventDefault();
        const opening = !optionsDetails.open;
        if (opening) optionsOpenedManually = true;
        setOptionsOpen(opening);
    });
    // Sync initial state in case the panel starts open
    if (optionsDetails.open) {
        const content = optionsDetails.querySelector('.options-content');
        content.style.maxHeight = content.scrollHeight + 'px';
    }
}

urlInput.addEventListener('input', () => {
    updateUrlClear();
    const url = urlInput.value.trim();
    // Equivalent input must not invalidate a pending submission's success
    // callback: whitespace and repeated pastes still refer to the same URL.
    if (url === probedUrl) return;
    downloadDraftGeneration++;
    scheduleProbe(url);
});

for (const id of ['optionsQualitySelect', 'optionsContainerSelect', 'optionsFilename']) {
    const field = document.getElementById(id);
    downloadOptionValues.set(id, field.value);
    const changed = () => {
        // A text field's change event may arrive only when it blurs after
        // submission. Its earlier input event already recorded that value.
        if (downloadOptionValues.get(id) === field.value) return;
        downloadOptionValues.set(id, field.value);
        downloadDraftGeneration++;
    };
    field.addEventListener('input', changed);
    field.addEventListener('change', changed);
}

// Native paste fires input after updating the field, including clipboard
// shortcuts. Use that single path so one paste schedules only one probe.
document.getElementById('optionsRetry').addEventListener('click', () => {
    scheduleProbe(urlInput.value.trim(), 0);
});

function probeVideoUrl(url, generation) {
    const isCurrent = () => generation === probeGeneration
        && url === urlInput.value.trim();
    if (!isCurrent()) return;

    apiFetch('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
    })
    .then(res => {
        if (!res.ok) throw new Error('Probe failed');
        return res.json();
    })
    .then(data => {
        if (!isCurrent()) return;
        if (!data || typeof data !== 'object' || Array.isArray(data)
                || Object.prototype.hasOwnProperty.call(data, 'error')
                || !Array.isArray(data.resolutions) || !Array.isArray(data.containers)
                || !data.resolutions.every(value => typeof value === 'string')
                || !data.containers.every(value => typeof value === 'string' && value.trim())
                || (data.title != null && typeof data.title !== 'string')) {
            throw new Error('Invalid probe response');
        }

        if (data.title) {
            document.getElementById('optionsFilename').placeholder = `Will be auto-filled: ${data.title}`;
        }

        const select = document.getElementById('optionsQualitySelect');
        data.resolutions.forEach(resolution => {
            const match = resolution.match(/^(\d+)p$/);
            const height = match ? Number(match[1]) : 0;
            if (!Number.isSafeInteger(height) || height <= 0) return;
            const option = document.createElement('option');
            option.value = `bestvideo[height<=${height}]+bestaudio/best`;
            option.textContent = `${height}p`;
            select.appendChild(option);
        });

        const containerSelect = document.getElementById('optionsContainerSelect');
        data.containers.forEach(ext => {
            const option = document.createElement('option');
            option.value = ext;
            option.textContent = ext.toUpperCase();
            containerSelect.appendChild(option);
        });
        const restored = downloadRestoredOptions;
        if (restored && restored.generation === probeGeneration && restored.draftGeneration === downloadDraftGeneration && restored.dialogSession === newDownloadSession) {
            for (const [select, value] of [[document.getElementById('optionsQualitySelect'), restored.fields.quality], [containerSelect, restored.fields.container]]) {
                if ([...select.options].some(option => option.value === value)) select.value = value;
            }
            document.getElementById('optionsFilename').value = restored.fields.filename;
        }
        downloadRestoredOptions = null;
        probeState = 'ready';
        renderProbeState();
    })
    .catch(() => {
        if (!isCurrent()) return;
        // Extractor errors can contain markup or sensitive details. Keep this
        // local message concise and offer a retry of the current URL.
        probeState = 'error';
        renderProbeState();
    });
}

function resetOptions(state = 'empty') {
    document.getElementById('optionsQualitySelect').innerHTML =
        '<option value="">Use default preference</option>';
    document.getElementById('optionsContainerSelect').innerHTML =
        '<option value="">Automatic</option>';
    document.getElementById('optionsFilename').value = '';
    document.getElementById('optionsFilename').placeholder = 'Will be auto-filled from video title';
    probeState = state;
    renderProbeState();
}

let availableTags = [];
let searchTerms = [];
const editingTagIds = new Set();
const tagDrafts = new Map();
const pendingTagCommits = new Map();
const tagEditorTokens = new Map();
const tagEditPositions = new Map();
const unavailableTagIds = new Set();
const checkingTagAvailability = new Set();
const submittedTagIntents = new Set();
const recoveredTagIntents = new Set();
let tagCapabilities = null;
let tagRenderScheduled = false;
let acceptingTagSnapshots = false;
const tagMutationMetrics = {
    submissions: 0, acknowledgements: 0, rejectedOutcomes: 0, unconfirmedOutcomes: 0, conflicts: 0,
    latestLocalFeedbackMs: null, latestAcknowledgementMs: null, reconciliationReads: 0,
    pending: 0, unconfirmed: 0, conflicted: 0,
};
VDL.tagMutationMetrics = () => Object.freeze({ ...tagMutationMetrics });
// Favorite presentation shares the coordinator, but never the tag conflict domain.
const renameDrafts = new Map();
const renameEditPositions = new Map();
const compatibilityRenames = new Map();
let renameViewSequence = 0;
const renameMutationMetrics = { ...tagMutationMetrics };
VDL.renameMutationMetrics = () => Object.freeze({ ...renameMutationMetrics });
const favoriteEditPositions = new Map();
const compatibilityFavorites = new Map();
const favoriteNotices = new Map();
const compatibilityVisibility = new Map();
const visibilityNotices = new Map();
const visibilityMutationMetrics = { ...tagMutationMetrics };
VDL.visibilityMutationMetrics = () => Object.freeze({ ...visibilityMutationMetrics });
const favoriteMutationMetrics = { ...tagMutationMetrics };
const mutationMetrics = { ...tagMutationMetrics };
const preferenceMutationMetrics = { ...tagMutationMetrics };
const playlistMutationMetrics = { ...tagMutationMetrics };
const downloadCommandMetrics = { ...tagMutationMetrics };
const downloadSubmissionMetrics = { ...tagMutationMetrics };
const uploadMutationMetrics = { ...tagMutationMetrics };
const removalMutationMetrics = { ...tagMutationMetrics };
const bulkClearMetrics = { ...tagMutationMetrics };
const bulkClears = new Map();
const bulkRemovedAttemptIds = new Set();
VDL.bulkClearMetrics = () => Object.freeze({ ...bulkClearMetrics });
const compatibilityRemovals = new Map();
const removalPositions = new Map();
const removalAnnouncements = new Map();
VDL.removalMutationMetrics = () => Object.freeze({ ...removalMutationMetrics });
VDL.entryRemovalMetrics = VDL.removalMutationMetrics;
VDL.uploadMutationMetrics = () => Object.freeze({ ...uploadMutationMetrics });
VDL.downloadSubmissionMetrics = () => Object.freeze({ ...downloadSubmissionMetrics });
VDL.downloadCommandMetrics = () => Object.freeze({ ...downloadCommandMetrics });
const compatibilityCommands = new Map();
const commandNotices = new Map();
const commandAnnouncements = new Map();
VDL.playlistMutationMetrics = () => Object.freeze({ ...playlistMutationMetrics });
VDL.preferenceMutationMetrics = () => Object.freeze({ ...preferenceMutationMetrics });
let preferenceSubmission = null;
let preferenceDraftGeneration = 0;
let preferenceViewToken = 0;
let preferenceDirty = false;
let preferenceMessage = '';
let preferenceReviewVisible = false;
let preferenceSavedTimer = null;
VDL.favoriteMutationMetrics = () => Object.freeze({ ...favoriteMutationMetrics });
VDL.mutationMetrics = () => Object.freeze({ ...mutationMetrics });
const tagState = VDL.createClientState();
const tagMutations = VDL.createMutations({
    state: tagState,
    transport: async ({ url, method, body }) => {
        if (method === 'POST' && url === '/api/playlists' || method === 'PUT' && /^\/api\/playlists\/[^/]+$/.test(url)) {
            const submission = [...playlistSubmissions.values()].find(entry => !entry.legacy && (method === 'POST' ? entry.kind === 'playlist.create' && !entry.mutationId : entry.key === decodeURIComponent(url.split('/')[3])));
            if (submission) submission.mutationId = body?.client_mutation_id;
        }
        if (method !== 'GET' && url.startsWith('/api/playlists/')) {
            const id = decodeURIComponent(url.split('/')[3]);
            const action = playlistActions.get(id);
            if (action) action.mutationId = body?.client_mutation_id;
        }
        if (method === 'POST' && url === '/api/preferences' && preferenceSubmission) preferenceSubmission.mutationId = body?.client_mutation_id;
        if (method === 'GET') {
            mutationMetrics.reconciliationReads++;
            if (url.startsWith('/api/playlists') || [...playlistSubmissions.values(), ...playlistActions.values()].some(entry => entry.mutationId && url.endsWith(entry.mutationId))) playlistMutationMetrics.reconciliationReads++;
            if (url === '/api/preferences' || (preferenceSubmission?.mutationId && url === `/api/mutations/${encodeURIComponent(preferenceSubmission.mutationId)}`)) preferenceMutationMetrics.reconciliationReads++;
        }
        const response = await apiFetch(url, {
            method,
            ...(body === undefined ? {} : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    },
    onEvent: event => {
        const domainMetrics = ['history.clear', 'library.clear'].includes(event.action) ? bulkClearMetrics : event.action === 'entry.remove' ? removalMutationMetrics : event.action.startsWith('upload.') ? uploadMutationMetrics : event.action === 'download.submit' ? downloadSubmissionMetrics : event.action.startsWith('download.') ? downloadCommandMetrics : event.action.startsWith('playlist.') ? playlistMutationMetrics : event.action === 'preference.set' ? preferenceMutationMetrics : event.action === 'rename.set' ? renameMutationMetrics : event.action === 'visibility.set' ? visibilityMutationMetrics : event.action === 'favorite.set' ? favoriteMutationMetrics : tagMutationMetrics;
        for (const metrics of [domainMetrics, mutationMetrics]) {
            if (event.outcome === 'presented') metrics.submissions++;
            if (event.outcome === 'confirmed') {
                metrics.acknowledgements++;
                metrics.latestAcknowledgementMs = event.elapsedMs;
            }
            if (event.outcome === 'rejected') metrics.rejectedOutcomes++;
            if (event.outcome === 'unconfirmed') metrics.unconfirmedOutcomes++;
            if (event.outcome === 'conflicted') metrics.conflicts++;
        }
        mutationMetrics.pending = event.pending;
        mutationMetrics.unconfirmed = event.unconfirmed;
        mutationMetrics.conflicted = event.conflicted;
        if (['history.clear', 'library.clear'].includes(event.action)) handleBulkClearEvent(event);
        if (event.action === 'entry.remove') handleRemovalMutationEvent(event);
        if (event.action.startsWith('upload.')) handleUploadMutationEvent(event);
        if (event.action === 'download.submit') handleDownloadSubmissionEvent(event);
        else if (event.action.startsWith('download.')) {
            if (event.outcome === 'reconciliation') downloadCommandMetrics.reconciliationReads++;
            handleDownloadCommandEvent(event);
        }
        if (event.action === 'preference.set') handlePreferenceMutationEvent(event);
        if (event.action.startsWith('playlist.')) handlePlaylistMutationEvent(event);
        if (event.action === 'rename.set') {
            const intent = tagMutations.status(event.intentId);
            const draft = intent && renameDrafts.get(intent.targetId);
            if (event.outcome === 'confirmed' && draft?.submittedIntentId === event.intentId) {
                if (draft.generation === draft.submittedGeneration && draft.viewToken === draft.submittedViewToken) renameDrafts.delete(intent.targetId);
                else delete draft.submittedIntentId;
            }
            const messages = {
                presented: 'Renaming…', confirmed: 'Renamed.', rejected: 'Could not rename. The requested name is retained.',
                conflicted: 'Name changed elsewhere. Review the current name before retrying.',
                unconfirmed: 'Rename not confirmed. Check its status before replaying.',
            };
            if (messages[event.outcome]) announceTagStatus(messages[event.outcome]);
        }
        if (event.action === 'visibility.set') {
            if (event.outcome === 'reconciliation') visibilityMutationMetrics.reconciliationReads++;
            const messages = { presented: 'Changing visibility…', confirmed: 'Visibility change confirmed.',
                rejected: 'Visibility change refused. Last confirmed visibility is retained.',
                conflicted: 'Visibility changed elsewhere. Review current visibility before submitting again.',
                unconfirmed: 'Visibility change not confirmed.' };
            const intent = tagMutations.status(event.intentId);
            if (intent && event.outcome === 'confirmed') visibilityNotices.set(intent.targetId, messages.confirmed);
            if (messages[event.outcome]) announceTagStatus(messages[event.outcome]);
            refreshVisibilityPresentations();
            if (event.outcome === 'confirmed') fetchLibraryStorage();
        }
        if (event.action === 'favorite.set') {
            const messages = {
                presented: 'Saving favorite', confirmed: 'Favorite saved.',
                rejected: 'Could not save favorite. Retry or dismiss the failed save.',
                conflicted: 'Favorite changed elsewhere. Review the current favorite before retrying.',
                unconfirmed: 'Favorite save not confirmed. Check its status before retrying.',
            };
            if (messages[event.outcome]) announceTagStatus(messages[event.outcome]);
        }
    },
    currentBulkView: scope => {
        const record = bulkClears.get(scope);
        if (record) record.currentReadView = { epoch: tagSessionEpoch, attempts: attemptRequest, library: libraryRequestEpoch, attemptSnapshot: attemptSnapshotVersion, librarySnapshot: librarySnapshotVersion, page: attemptPage, filter: document.getElementById('attemptSearchInput').value };
        return { page: attemptPage, filter: document.getElementById('attemptSearchInput').value };
    },
    onBulkCurrentState: ({ scope, intentId, snapshot }) => {
        const record = bulkClears.get(scope);
        const view = record?.currentReadView;
        if (!record || record.intentId !== intentId || !view || view.epoch !== tagSessionEpoch || (scope === 'history' ? view.attempts !== attemptRequest || view.attemptSnapshot !== attemptSnapshotVersion : view.library !== libraryRequestEpoch || view.librarySnapshot !== librarySnapshotVersion)) return false;
        record.currentSnapshot = snapshot;
        return true;
    },
    canResolveBulkState: intentId => {
        const record = [...bulkClears.values()].find(entry => entry.intentId === intentId);
        const view = record?.currentReadView;
        return !!record?.currentSnapshot && !!view && view.epoch === tagSessionEpoch && (record.scope === 'history' ? view.attempts === attemptRequest && view.attemptSnapshot === attemptSnapshotVersion : view.library === libraryRequestEpoch && view.librarySnapshot === librarySnapshotVersion);
    },
    onAuthLoss: resetTagSession,
    onNotice: ({ targetId, message }) => {
        if (targetId === 'installation') { preferenceMessage = message; renderPreferenceStatus(); }
        else announceTagStatus(message);
    },
});

function resetTagSession() {
    tagSessionEpoch += 1;
    for (const record of bulkClears.values()) (record.timers || []).forEach(clearTimeout);
    bulkClears.clear(); bulkRemovedAttemptIds.clear();
    refreshBulkClearPresentations();
    for (const id of compatibilityRemovals.keys()) clearCompatibilityRemoval(id);
    removalPositions.clear(); removalAnnouncements.clear();
    for (const upload of droppedUploads.values()) upload.timers.forEach(clearTimeout);
    droppedUploads.clear();
    for (const request of activeUploadRequests.values()) request.abort();
    activeUploadRequests.clear();
    clearTimeout(uploadProgressRenderTimer); uploadProgressRenderTimer = null;
    renderUploadRecovery();
    resetDownloadSubmission(true);
    for (const entry of compatibilityCommands.values()) entry.timers.forEach(clearTimeout);
    compatibilityCommands.clear(); commandNotices.clear(); commandAnnouncements.clear();
    ++attemptRequest;
    attemptRows.clear();
    document.getElementById('attemptHistoryList').replaceChildren();
    refreshDownloadCommandPresentations();
    resetPreferenceSession();
    resetPlaylistSession();
    tagMutations.reset();
    tagDrafts.clear();
    editingTagIds.clear();
    tagEditorTokens.clear();
    tagEditPositions.clear();
    pendingTagCommits.clear();
    unavailableTagIds.clear();
    submittedTagIntents.clear();
    recoveredTagIntents.clear();
    checkingTagAvailability.clear();
    for (const id of compatibilityRenames.keys()) clearCompatibilityRename(id);
    renameDrafts.clear();
    renameEditPositions.clear();
    renameViewSequence++;
    favoriteEditPositions.clear();
    compatibilityFavorites.clear();
    favoriteNotices.clear();
    for (const entry of compatibilityVisibility.values()) entry.timers.forEach(clearTimeout);
    compatibilityVisibility.clear(); visibilityNotices.clear();
    refreshVisibilityPresentations();
    announceTagStatus('');
    updateTagMutationSummary();
    collectionSnapshots.library = [];
    collectionSnapshots.current = [];
    allLibraryEntries = [];
    availableTags = [];
    closeHistoryInfo();
}

function announceTagStatus(message) {
    for (const id of ['tagMutationStatus', 'currentTagMutationStatus']) {
        const status = document.getElementById(id);
        if (status && status.textContent !== message) status.textContent = message;
    }
}

function updateTagMutationSummary() {
    refreshBulkClearPresentations();
    refreshDownloadCommandPresentations();
    refreshRemovalPresentations();
    for (const intentId of submittedTagIntents) {
        if (tagMutations.status(intentId) !== null) continue;
        submittedTagIntents.delete(intentId);
        recoveredTagIntents.delete(intentId);
    }
    const allIntents = mutationDiagnosticIntents();
    const intents = allIntents.filter(intent => intent.kind.startsWith('tag.'));
    refreshVisibilityPresentations();
    const visibilityIntents = allIntents.filter(intent => intent.kind === 'visibility.set');
    visibilityMutationMetrics.pending = visibilityIntents.filter(intent => ['queued', 'sending', 'unconfirmed', 'conflicted'].includes(intent.status)).length;
    visibilityMutationMetrics.unconfirmed = visibilityIntents.filter(intent => intent.status === 'unconfirmed').length;
    visibilityMutationMetrics.conflicted = visibilityIntents.filter(intent => intent.status === 'conflicted').length;
    const favoriteIntents = allIntents.filter(intent => intent.kind === 'favorite.set');
    updateFavoriteMutationSummary(favoriteIntents);
    const renameIntents = allIntents.filter(intent => intent.kind === 'rename.set');
    updateRenameMutationSummary(renameIntents.concat([...compatibilityRenames.values()]));
    for (const [metrics, entries] of [[renameMutationMetrics, renameIntents.concat([...compatibilityRenames.values()])], [favoriteMutationMetrics, favoriteIntents], [mutationMetrics, allIntents]]) {
        metrics.pending = entries.filter(intent => ['queued', 'sending', 'unconfirmed', 'conflicted'].includes(intent.status)).length;
        metrics.unconfirmed = entries.filter(intent => intent.status === 'unconfirmed').length;
        metrics.conflicted = entries.filter(intent => intent.status === 'conflicted').length;
    }
    tagMutationMetrics.pending = intents.filter(intent => ['queued', 'sending', 'unconfirmed', 'conflicted'].includes(intent.status)).length;
    tagMutationMetrics.unconfirmed = intents.filter(intent => intent.status === 'unconfirmed').length;
    tagMutationMetrics.conflicted = intents.filter(intent => intent.status === 'conflicted').length;
    const groups = [
        [['queued', 'sending'], 'saving'],
        [['unconfirmed'], 'not confirmed'],
        [['conflicted'], 'in conflict'],
        [['rejected'], 'needing correction'],
    ];
    const parts = groups.map(([states, description]) => {
        const count = intents.filter(intent => states.includes(intent.status)).length;
        return count ? `${count} tag ${count === 1 ? 'edit' : 'edits'} ${description}` : '';
    }).filter(Boolean);
    if (pendingTagCommits.size) parts.push(`${pendingTagCommits.size} tag requests awaiting confirmation`);
    for (const id of ['tagMutationSummary', 'currentTagMutationSummary']) {
        const summary = document.getElementById(id);
        if (!summary) continue;
        summary.hidden = !parts.length;
        summary.textContent = parts.length ? `${parts.join('. ')}. Open the entry’s tags for details.` : '';
    }
}

function projectTagEntry(info) {
    const projected = tagState.selectDownload(String(info.id));
    if (!projected) return info;
    return { ...info, ...(projected.upload && (!info.upload || BigInt(info.upload.revision) < BigInt(projected.upload.revision)) ? { status: projected.upload.download_status, downloaded_bytes: projected.upload.downloaded_bytes, total_bytes: projected.upload.total_bytes, upload: projected.upload, upload_revision: projected.upload_revision } : {}), ...(info.current_attempt_id !== projected.current_attempt_id && typeof projected.command_revision === 'string' ? { status: projected.status, progress: projected.progress, speed: projected.speed, eta: projected.eta, downloaded_bytes: projected.downloaded_bytes, total_bytes: projected.total_bytes, finished_at: projected.finished_at } : {}), command_revision: projected.command_revision, current_attempt_id: projected.current_attempt_id, job_id: projected.job_id, filename: projected.filename, display_filename: projected.display_filename,
        removal_revision: projected.removal_revision, removal_intents: projected.removal_intents, rename_revision: projected.rename_revision, requested_filename: ['sending', 'unconfirmed'].includes(compatibilityRenames.get(String(info.id))?.status) ? compatibilityRenames.get(String(info.id)).value : projected.requested_filename, rename_intents: projected.rename_intents, tags: projected.tags, tag_items: projected.tag_items,
        tags_revision: projected.tags_revision, tag_chips: projected.tag_chips,
        visibility: projected.visibility, visibility_revision: projected.visibility_revision, visibility_intents: projected.visibility_intents,
        can_manage_visibility: projected.can_manage_visibility, can_delete: projected.can_delete, permissions: projected.permissions,
        favorite: projected.favorite, favorite_revision: projected.favorite_revision, favorite_intents: projected.favorite_intents };
}

function hasTagProtocol() {
    return tagCapabilities?.mutation_protocol === 1
        && tagCapabilities.tag_identity_version === VDL.tagIdentity.version;
}

async function loadTagCapabilities() {
    const epoch = tagSessionEpoch;
    try {
        const response = await apiFetch('/api/client-capabilities');
        if (!response.ok) return;
        const capabilities = await response.json();
        if (epoch !== tagSessionEpoch) return;
        tagCapabilities = capabilities;
        tagMutations.setCapabilities(tagCapabilities);
        adoptServerUploads(collectionSnapshots.current);
        renderDroppedUploads();
    } catch (_) {
        // Older deployments retain the legacy contract until a page reload.
    }
}

tagState.subscribe(ids => {
    if (downloadSubmission && ids.some(id => id === downloadSubmission.key || id === downloadSubmission.accepted?.download_id)) {
        if (!downloadSubmission.legacy && !tagState.isAvailable(downloadSubmission.key) || downloadSubmission.accepted && tagState.isFenced(downloadSubmission.accepted.download_id)) resetDownloadSubmission();
        else renderDownloadSubmission();
    }
    ids = ids.filter(id => !id.startsWith('submission:'));
    if (!ids.length) return;
    if (ids.some(id => id.startsWith('playlist:'))) {
        for (const id of ids.filter(id => id.startsWith('playlist:'))) {
            if (tagState.isAvailable(id)) continue;
            fencePlaylistPresentation(id.slice(9));
        }
        renderPlaylistSaveStatus();
        renderPlaylistActionStatus();
        renderPlaylists();
    }
    ids = ids.filter(id => !id.startsWith('playlist:'));
    if (ids.includes('installation')) {
        if (!tagState.selectPreferences() && (preferenceSubmission || preferenceDirty)) resetPreferenceSession();
        else renderPreferenceStatus();
    }
    ids = ids.filter(id => id !== 'installation');
    if (ids.some(id => id.startsWith('bulk:'))) {
        for (const id of ids.filter(id => id.startsWith('bulk:'))) {
            const scope = id.slice(5);
            const record = bulkClears.get(scope);
            if (!tagState.isAvailable(id) && record?.intentId) {
                record.intentId = null; record.status = 'rejected';
                record.message = 'Access to this clear is no longer available. Review your account permissions before trying again.';
                record.rows.clear(); record.positions.clear(); record.appliedIds.clear();
                delete record.currentSnapshot; delete record.currentReadView;
                record.timers.forEach(clearTimeout);
            }
        }
        refreshBulkClearPresentations();
    }
    ids = ids.filter(id => !id.startsWith('bulk:'));
    if (!ids.length) return;
    for (const id of ids) {
        if (tagState.selectDownload(id) !== null) continue;
        unavailableTagIds.add(String(id));
        const upload = droppedUploads.get(String(id));
        if (upload) { upload.timers.forEach(clearTimeout); droppedUploads.delete(String(id)); activeUploadRequests.get(String(id))?.abort(); activeUploadRequests.delete(String(id)); renderUploadRecovery(); }
        for (const key of ['library', 'current']) {
            collectionSnapshots[key] = collectionSnapshots[key].filter(info => String(info.id) !== String(id));
        }
        allLibraryEntries = allLibraryEntries.filter(info => String(info.id) !== String(id));
        clearCompatibilityRename(String(id));
        clearCompatibilityCommand(String(id));
        clearCompatibilityRemoval(String(id));
        removalPositions.delete(String(id));
        commandNotices.delete(String(id));
        for (const [key, entry] of commandAnnouncements) if (entry.targetId === String(id)) commandAnnouncements.delete(key);
        renameDrafts.delete(String(id));
        renameEditPositions.delete(String(id));
        favoriteEditPositions.delete(String(id));
        compatibilityFavorites.delete(String(id));
        favoriteNotices.delete(String(id));
        compatibilityVisibility.get(String(id))?.timers.forEach(clearTimeout);
        compatibilityVisibility.delete(String(id)); visibilityNotices.delete(String(id));
        editingTagIds.delete(String(id));
        tagDrafts.delete(String(id));
        tagEditPositions.delete(String(id));
        if (String(openInfoId) === String(id)) closeHistoryInfo();
    }
    if (acceptingTagSnapshots) {
        for (const id of ids) {
            const notice = commandNotices.get(id);
            if (notice && (tagState.selectDownload(id)?.current_attempt_id !== notice.attemptId || tagState.selectDownload(id)?.status !== notice.workerStatus)) commandNotices.delete(id);
        }
    }
    refreshDownloadCommandPresentations();
    refreshVisibilityPresentations();
    if (acceptingTagSnapshots || tagRenderScheduled) return;
    tagRenderScheduled = true;
    queueMicrotask(() => {
        tagRenderScheduled = false;
        releaseSettledRenameInteractions();
        releaseSettledFavoriteInteractions();
        renderDownloadCollections();
        renderUploadRecovery();
        refreshRenamePresentations();
        const statuses = ids.flatMap(id => tagState.selectDownload(id)?.tag_chips || [])
            .filter(chip => chip.status !== 'confirmed')
            .map(chip => chip.message || `${chip.operation === 'tag.remove' ? 'Removing' : 'Saving'} tag ${chip.name}`);
        const delayedFavorites = ids.flatMap(id => tagState.selectDownload(id)?.favorite_intents || [])
            .filter(intent => intent.delayed && intent.status === 'sending')
            .map(intent => intent.message);
        const delayedRenames = ids.flatMap(id => tagState.selectDownload(id)?.rename_intents || [])
            .filter(intent => intent.delayed && intent.status === 'sending').map(intent => intent.message);
        if (statuses.length || delayedFavorites.length || delayedRenames.length) announceTagStatus([...statuses, ...delayedFavorites, ...delayedRenames].join('. '));
    });
});

window.addEventListener('beforeunload', event => {
    if (![...droppedUploads.values()].some(upload => !upload.settled || upload.unknown || uploadIntent(upload)) && !playlistActions.size && !playlistSubmissions.size && !playlistRetainedDrafts.size && !(playlistEditorDraft && playlistEditorSnapshot() !== playlistEditorBaseline) && !preferenceDirty && !preferenceSubmission && !tagMutations.hasPending() && ![...tagDrafts.values()].some(value => value.trim()) && !renameDrafts.size && !compatibilityVisibility.size && !compatibilityRenames.size && !compatibilityCommands.size && !compatibilityRemovals.size && ![...bulkClears.values()].some(entry => !['confirmed', 'rejected'].includes(bulkClearEntry(entry).status)) && !downloadSubmission?.legacy && !urlInput.value.trim()) return;
    event.preventDefault();
    event.returnValue = '';
});
document.querySelector('form.logout-form')?.addEventListener('submit', resetTagSession);
window.addEventListener('pagehide', resetTagSession);

function tagSearchKey(value) {
    try { return VDL.tagIdentity.normalize(String(value || '')).key; }
    catch (_) { return String(value || '').toLowerCase(); }
}

function sortTags(tags) {
    return tags.slice().sort((left, right) => left.localeCompare(
        right, undefined, { sensitivity: 'base' }));
}

function refreshAvailableTags(rows) {
    const names = new Set();
    rows.forEach(row => {
        const confirmed = tagState.writer.confirmed(String(row.id));
        (Array.isArray(confirmed?.tags) ? confirmed.tags : (row.tags || [])).forEach(tag => names.add(tag));
    });
    availableTags = sortTags(Array.from(names));
}

function parseSearchTerms(value) {
    const terms = [];
    let draft = '';
    let quoted = false;

    for (const character of String(value || '')) {
        if (character === '"') {
            quoted = !quoted;
        } else if (/\s/.test(character) && !quoted) {
            if (draft) terms.push(draft);
            draft = '';
        } else {
            draft += character;
        }
    }
    if (draft) terms.push(draft);
    return terms.map(term => term.trim()).filter(Boolean);
}

function searchQualityHeight(value) {
    const key = tagSearchKey(value);
    const aliases = {
        '8k': 4320,
        '4k': 2160,
        'uhd': 2160,
        '2k': 1440,
        'qhd': 1440,
    };
    if (Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key];

    const dimensions = key.match(/^(\d+)\s*[x×]\s*(\d+)$/);
    const vertical = key.match(/^(\d+)\s*p?$/);
    const height = dimensions
        ? Number(dimensions[2])
        : vertical
            ? Number(vertical[1])
            : 0;
    return Number.isFinite(height) && height > 0 ? height : null;
}

function searchPlaylistValues(terms = searchTerms) {
    return terms
        .map(tagSearchKey)
        .filter(term => /^playlists?:/.test(term))
        .map(term => term.replace(/^playlists?:/, '').trim());
}

function parseDurationTime(value) {
    const text = value.toLowerCase();
    let seconds;
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(text)) {
        seconds = Number(text);
    } else if (/^[0-9]+:[0-5][0-9](?::[0-5][0-9])?$/.test(text)) {
        seconds = text.split(':').reduce((total, field) => total * 60 + Number(field), 0);
    } else {
        const components = Array.from(text.matchAll(/([0-9]+(?:\.[0-9]+)?)([hms])/g));
        if (!components.length || components.map(component => component[0]).join('') !== text) return null;
        const factors = { h: 3600, m: 60, s: 1 };
        let previousFactor = Infinity;
        seconds = 0;
        for (const [index, component] of components.entries()) {
            const factor = factors[component[2]];
            if (factor >= previousFactor
                    || (index < components.length - 1 && component[1].includes('.'))) return null;
            seconds += Number(component[1]) * factor;
            previousFactor = factor;
        }
    }
    return Number.isFinite(seconds) ? seconds : null;
}

const durationSearchCache = new WeakMap();

function durationSearchConditions(terms = searchTerms) {
    if (durationSearchCache.has(terms)) return durationSearchCache.get(terms);
    const conditions = [];
    let valid = true;
    for (const term of terms) {
        if (!/^duration:/i.test(term)) continue;
        const comparison = term.slice('duration:'.length).match(/^(>=|<=|>|<)(.+)$/);
        const seconds = comparison ? parseDurationTime(comparison[2]) : null;
        if (seconds === null) {
            valid = false;
            break;
        }
        conditions.push({ operator: comparison[1], seconds });
    }
    const result = { valid, conditions };
    durationSearchCache.set(terms, result);
    return result;
}

function matchesDurationConditions(duration, conditions) {
    if (!Number.isFinite(duration) || duration <= 0) return false;
    return conditions.every(({ operator, seconds }) => {
        if (operator === '>') return duration > seconds;
        if (operator === '>=') return duration >= seconds;
        if (operator === '<') return duration < seconds;
        return duration <= seconds;
    });
}

function matchesSearchFilter(info, terms = searchTerms) {
    if (terms.length === 0) return true;
    const durationFilter = durationSearchConditions(terms);
    if (!durationFilter.valid || (durationFilter.conditions.length
            && !matchesDurationConditions(info.duration_seconds, durationFilter.conditions))) return false;
    const title = tagSearchKey(info.title);
    const filename = tagSearchKey(displayFilename(info));
    const tags = new Set((Array.isArray(info.tags) ? info.tags : []).map(tagSearchKey));
    const userTerms = [];
    const qualityTerms = [];
    const starredTerms = [];
    const viewTerms = [];
    const playlistTerms = [];
    const contentTerms = [];
    terms.forEach(term => {
        if (/^duration:/i.test(term)) return;
        const key = tagSearchKey(term);
        if (key.startsWith('user:')) userTerms.push(key.slice('user:'.length).trim());
        else if (key.startsWith('quality:')) {
            qualityTerms.push(searchQualityHeight(key.slice('quality:'.length).trim()));
        } else if (key.startsWith('starred:')) {
            starredTerms.push(key.slice('starred:'.length).trim());
        } else if (key.startsWith('star:')) {
            starredTerms.push(key.slice('star:'.length).trim());
        } else if (key.startsWith('views:')) {
            viewTerms.push(key.slice('views:'.length).trim());
        } else if (/^playlists?:/.test(key)) {
            playlistTerms.push(key.replace(/^playlists?:/, '').trim());
        } else {
            contentTerms.push(term);
        }
    });

    if (userTerms.length) {
        const downloadedBy = tagSearchKey(info.downloaded_by);
        if (!userTerms.some(user => user && user === downloadedBy)) return false;
    }
    if (qualityTerms.length) {
        const height = searchQualityHeight(info.resolution)
            ?? searchQualityHeight(info.quality);
        if (!qualityTerms.some(minimum => minimum !== null && height >= minimum)) return false;
    }
    if (starredTerms.length) {
        const favorite = Boolean(info.favorite);
        if (!starredTerms.some(value => (
            (value === 'yes' && favorite) || (value === 'no' && !favorite)
        ))) return false;
    }
    if (viewTerms.length) {
        const numericViews = Number(info.view_count);
        const viewCount = Number.isFinite(numericViews) && numericViews >= 0
            ? numericViews
            : 0;
        if (!viewTerms.some(value => (
            (value === 'new' && viewCount === 0)
            || (/^\d+$/.test(value) && viewCount >= Number(value))
        ))) return false;
    }
    if (playlistTerms.length) {
        if (!playlistTerms.includes('no')) return false;
    }
    if (contentTerms.length === 0) return true;

    const matchesContent = term => {
        const key = tagSearchKey(term);
        return tags.has(key) || title.includes(key) || filename.includes(key);
    };
    return contentTerms.some(matchesContent);
}

function setHistorySearchExpanded(expanded) {
    const search = document.getElementById('historySearch');
    const toggle = document.getElementById('historySearchToggle');
    search.classList.toggle('expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
}

function updateDurationSearchFeedback() {
    const invalid = !durationSearchConditions().valid;
    const input = document.getElementById('historySearchInput');
    input.setAttribute('aria-invalid', String(invalid));
    input.setAttribute('aria-describedby', invalid
        ? 'historySearchHint historySearchError' : 'historySearchHint');
    document.getElementById('historySearchError').hidden = !invalid;
    document.getElementById('historySearch').classList.toggle('invalid', invalid);
}

function applyHistorySearch() {
    closeAllMenus();
    const input = document.getElementById('historySearchInput');
    document.getElementById('historySearchClear').hidden = !input.value;
    searchTerms = parseSearchTerms(input.value);
    updateDurationSearchFeedback();
    historyPage = 0;
    historyEndlessVisibleCount = HISTORY_ENDLESS_BATCH_SIZE;
    // Apply the query to retained data immediately while a live refresh runs.
    renderDownloadCollections({ sortFavorites: true });
    fetchHistory({ sortFavorites: true });
}

const historySearch = document.getElementById('historySearch');
const historySearchToggle = document.getElementById('historySearchToggle');
const historySearchInput = document.getElementById('historySearchInput');
const historySearchClear = document.getElementById('historySearchClear');

function closeAccountMenu(restoreFocus = false) {
    const menu = document.getElementById('accountMenu');
    const button = document.getElementById('accountMenuButton');
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus();
}

function openAccountMenu({ focusFirst = false } = {}) {
    closeHistoryInfo();
    closeAllMenus();
    const menu = document.getElementById('accountMenu');
    const button = document.getElementById('accountMenuButton');
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    if (focusFirst) menu.querySelector('[role="menuitem"]').focus();
}

const accountMenuButton = document.getElementById('accountMenuButton');
const accountMenu = document.getElementById('accountMenu');

const playbackModeToggle = document.getElementById('playbackModeToggle');
const playbackModeMenu = document.getElementById('playbackModeMenu');
const endlessPlaybackButton = document.getElementById('endlessPlaybackButton');
const playbackModeStorageKey = 'playback-mode-user-'
    + document.getElementById('playbackModeControl').dataset.userId;

function loadRememberedPlaybackMode() {
    try {
        const stored = localStorage.getItem(playbackModeStorageKey);
        if (['shuffle', 'shuffle_clips'].includes(stored)) return stored;
    } catch (error) {
        // Browser storage can be blocked even when the page itself is usable.
    }
    return 'sequential';
}

let rememberedPlaybackMode = loadRememberedPlaybackMode();

function renderRememberedPlaybackMode() {
    const clips = rememberedPlaybackMode === 'shuffle_clips';
    const shuffle = clips || rememberedPlaybackMode === 'shuffle';
    const label = clips ? 'Shuffle Clips' : shuffle ? 'Shuffle' : 'Play All';
    endlessPlaybackButton.setAttribute('aria-label', label);
    endlessPlaybackButton.title = clips
        ? 'Shuffle random 5–20 second clips from your library.'
        : shuffle
        ? 'Shuffle your library continuously in the built-in player'
        : 'Play the current Library selection continuously in the built-in player';
    endlessPlaybackButton.querySelector('svg use').setAttribute(
        'href', shuffle ? '#i-shuffle' : '#i-play',
    );
    endlessPlaybackButton.querySelector('span').textContent = label;
    endlessPlaybackButton.disabled = document.getElementById(
        clips ? 'playbackMenuShuffleClips' : shuffle ? 'playbackMenuShuffle' : 'playbackMenuPlayAll',
    ).disabled;
}

function startChosenPlaybackMode(mode) {
    rememberedPlaybackMode = mode;
    renderRememberedPlaybackMode();
    try {
        localStorage.setItem(playbackModeStorageKey, mode);
    } catch (error) {
        // Keep the in-page choice and let the requested playback proceed.
    }
    if (['shuffle', 'shuffle_clips'].includes(mode)) startShufflePlayback(mode);
    else startSequentialPlayback();
}

renderRememberedPlaybackMode();

function closePlaybackModeMenu(restoreFocus = false) {
    if (playbackModeMenu.hidden) return;
    playbackModeMenu.hidden = true;
    playbackModeToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) playbackModeToggle.focus();
}

function playbackModeItems() {
    return Array.from(playbackModeMenu.querySelectorAll('[role="menuitem"]'))
        .filter(item => !item.disabled);
}

function openPlaybackModeMenu(focus = null) {
    closeHistoryInfo();
    closeAllMenus();
    playbackModeMenu.hidden = false;
    playbackModeToggle.setAttribute('aria-expanded', 'true');
    const items = playbackModeItems();
    if (focus === 'first' && items.length) items[0].focus();
    if (focus === 'last' && items.length) items[items.length - 1].focus();
}

playbackModeToggle.addEventListener('click', event => {
    event.stopPropagation();
    if (playbackModeMenu.hidden) openPlaybackModeMenu();
    else closePlaybackModeMenu();
});
playbackModeToggle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openPlaybackModeMenu(event.key === 'ArrowDown' ? 'first' : 'last');
});
playbackModeMenu.addEventListener('keydown', event => {
    const items = playbackModeItems();
    const current = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape') {
        event.preventDefault();
        closePlaybackModeMenu(true);
        return;
    }
    if (next === null || !items.length) return;
    event.preventDefault();
    items[next].focus();
});
endlessPlaybackButton.addEventListener('click', () => {
    startChosenPlaybackMode(rememberedPlaybackMode);
});
document.getElementById('playbackMenuPlayAll').addEventListener(
    'click', () => startChosenPlaybackMode('sequential'),
);
document.getElementById('playbackMenuShuffle').addEventListener(
    'click', () => startChosenPlaybackMode('shuffle'),
);
document.getElementById('playbackMenuShuffleClips').addEventListener(
    'click', () => startChosenPlaybackMode('shuffle_clips'),
);
accountMenuButton.addEventListener('click', event => {
    event.stopPropagation();
    if (accountMenu.hidden) openAccountMenu();
    else closeAccountMenu();
});
accountMenuButton.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    openAccountMenu({ focusFirst: true });
});
accountMenu.addEventListener('keydown', event => {
    const items = Array.from(accountMenu.querySelectorAll('[role="menuitem"]'));
    const current = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape') {
        event.preventDefault();
        closeAccountMenu(true);
        return;
    }
    if (next === null) return;
    event.preventDefault();
    items[next].focus();
});

historySearchToggle.addEventListener('click', () => {
    setHistorySearchExpanded(true);
    historySearchInput.focus();
});
historySearchInput.addEventListener('focus', () => setHistorySearchExpanded(true));
historySearchInput.addEventListener('input', applyHistorySearch);
historySearchClear.addEventListener('click', () => {
    historySearchInput.value = '';
    applyHistorySearch();
    historySearchInput.focus();
});
historySearchInput.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    historySearchInput.value = '';
    applyHistorySearch();
    setHistorySearchExpanded(false);
    historySearchToggle.focus();
});
historySearchInput.addEventListener('blur', () => {
    setTimeout(() => {
        if (historySearch.contains(document.activeElement)) return;
        if (!historySearchInput.value) setHistorySearchExpanded(false);
    }, 0);
});

function tagChipHtml(chip, removable) {
    if (typeof chip === 'string') chip = { key: tagSearchKey(chip), name: chip, status: 'confirmed' };
    const { name, key, status = 'confirmed', intentId } = chip;
    const pending = ['queued', 'sending', 'unconfirmed'].includes(status);
    const failed = ['rejected', 'conflicted', 'unconfirmed'].includes(status);
    const slot = pending && !failed
        ? '<span class="tag-status-slot"><span class="options-spinner tag-spinner" aria-hidden="true"></span></span>'
        : failed
            ? `<span class="tag-status-slot" aria-label="${escapeAttr(chip.message || 'Save not confirmed')}">!</span>`
            : removable
                ? `<button type="button" class="tag-remove tag-status-slot" data-remove-tag="${escapeAttr(name)}" aria-label="Remove ${escapeAttr(name)}">×</button>`
                : '';
    return `<span class="tag-chip${removable || pending || failed ? ' tag-chip-editing' : ''}${chip.operation === 'tag.remove' && pending ? ' tag-chip-removing' : ''}${failed ? ' tag-chip-failed' : ''}" data-tag-key="${escapeAttr(key)}" data-tag-state="${escapeAttr(status)}"${intentId ? ` data-tag-intent="${escapeAttr(intentId)}"` : ''}><span class="tag-chip-label">${escapeHtml(name)}</span>${slot}</span>`;
}

function tagMessagesHtml(chips) {
    return chips.filter(chip => chip.intentId && (chip.delayed || ['queued', 'rejected', 'conflicted', 'unconfirmed'].includes(chip.status)))
        .map(chip => {
            const unknown = chip.status === 'unconfirmed';
            const failed = ['rejected', 'conflicted'].includes(chip.status);
            const message = chip.message || (unknown ? 'Save not confirmed' : failed ? 'Could not save tag' : chip.status === 'queued' ? 'Waiting to save' : 'Still saving tag');
            const action = (label, name) => `<button type="button" data-tag-action="${name}" data-intent-id="${escapeAttr(chip.intentId)}">${label}</button>`;
            return `<div class="tag-mutation-message"><span>${escapeHtml(chip.name)}: ${escapeHtml(message)}</span>${unknown ? action('Check save', 'check') + action('Recover save', 'recover') + action('Use current tags', 'dismiss') : failed ? action('Retry', 'retry') + (chip.operation === 'tag.add' ? action('Edit', 'edit') : '') + action('Dismiss', 'dismiss') : chip.status === 'queued' ? action('Discard queued edit', 'dismiss') : ''}</div>`;
        }).join('');
}

function tagSuggestionsHtml(info, draft) {
    const attached = new Set((info.tags || []).map(tagSearchKey));
    const query = tagSearchKey(draft.trim());
    return availableTags
        .filter(tag => !attached.has(tagSearchKey(tag)) && (!query || tagSearchKey(tag).includes(query)))
        .map(tag => `<button type="button" class="tag-suggestion" data-suggest-tag="${escapeAttr(tag)}" role="option">${escapeHtml(tag)}</button>`)
        .join('');
}

function renderTagControl(info) {
    info = projectTagEntry(info);
    const id = String(info.id);
    const chips = info.tag_chips || (info.tags || []).map(name => ({ key: tagSearchKey(name), name, status: 'confirmed' }));
    const messages = tagMessagesHtml(chips);
    const compatibility = pendingTagCommits.get(id);
    const saving = compatibility ? `<div class="tag-mutation-message">${escapeHtml(compatibility)}</div>` : '';
    if (!editingTagIds.has(id)) {
        const contents = chips.length
            ? chips.map(chip => tagChipHtml(chip, false)).join('')
            : '<span class="add-tag-affordance">Add tags</span>';
        return `<div class="tag-display-wrap" data-tag-id="${escapeAttr(id)}"><div class="tag-row tag-display-row" data-tag-id="${escapeAttr(id)}" data-mode="display" role="button" tabindex="0" aria-label="Edit tags">${contents}</div>${messages}${saving}</div>`;
    }
    const draft = tagDrafts.get(id) || '';
    const suggestions = tagSuggestionsHtml(info, draft);
    return `<div class="tag-editor-shell" data-tag-id="${escapeAttr(id)}">
                <div class="tag-token-input">
                    ${chips.map(chip => tagChipHtml(chip, true)).join('')}
                    <input class="tag-entry-input" type="text" value="${escapeAttr(draft)}" autocomplete="off" aria-label="Add tags" aria-expanded="${suggestions ? 'true' : 'false'}">
                </div>
                <div class="tag-suggestions tag-entry-suggestions" role="listbox"${suggestions ? '' : ' hidden'}>${suggestions}</div>
                ${messages}${saving}
            </div>`;
}

function tagEditStart(id) {
    id = String(id);
    editingTagIds.add(id);
    tagEditorTokens.set(id, {});
    tagDrafts.set(id, '');
    tagEditPositions.set(id, historyPageItems.findIndex(info => String(info.id) === id));
    tagState.beginEdit(id);
    renderDownloadCollections();
    document.querySelector(`.tag-editor-shell[data-tag-id="${CSS.escape(id)}"] .tag-entry-input`)?.focus();
}

function tagEditStop(id) {
    id = String(id);
    editingTagIds.delete(id);
    tagEditorTokens.delete(id);
    tagDrafts.delete(id);
    tagEditPositions.delete(id);
    tagState.endEdit(id);
    renderDownloadCollections();
    resumeDeferredHistoryFetch();
}

function tagCommit(id, explicitTag) {
    const startedAt = performance.now();
    const tagId = String(id);
    if (removalBlocksWrites(tagId)) { announceTagStatus('Resolve the removal before changing this entry.'); return; }
    const input = document.querySelector(`.tag-editor-shell[data-tag-id="${CSS.escape(tagId)}"] .tag-entry-input`);
    const tag = explicitTag === undefined ? ((input && input.value) || '') : explicitTag;
    if (!tag.trim()) return;
    if (!hasTagProtocol()) {
        compatibilityTagMutation(tagId, tag, 'POST', input);
        return;
    }
    const result = tagMutations.submit({ kind: 'tag.add', targetId: tagId, value: tag, viewToken: tagEditorTokens.get(tagId) });
    if (!result.accepted) {
        announceTagStatus(result.message || 'Could not submit tag');
        showActionError(result.message || 'Could not submit tag');
        return;
    }
    if (result.intentId) submittedTagIntents.add(result.intentId);
    // Transfer the submitted draft before any render can capture the live input.
    tagDrafts.set(tagId, '');
    if (input) input.value = '';
    renderDownloadCollections();
    announceTagStatus(`Saving tag ${tag}`);
    tagMutationMetrics.latestLocalFeedbackMs = Math.max(0, performance.now() - startedAt);
}

function compatibilityTagMutation(id, tag, method, input) {
    if (pendingTagCommits.has(id)) return;
    const draft = input?.value;
    const token = tagEditorTokens.get(id);
    const epoch = tagSessionEpoch;
    pendingTagCommits.set(id, `${method === 'POST' ? 'Saving' : 'Removing'} tag ${tag}…`);
    renderDownloadCollections();
    apiFetch('/api/tags/' + encodeURIComponent(id), {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag }),
    }).then(async response => {
        const data = await response.json();
        if (epoch !== tagSessionEpoch) return;
        if (!response.ok) throw new Error(data.error || 'Save not confirmed');
        if (token === tagEditorTokens.get(id) && tagDrafts.get(id) === draft && method === 'POST') {
            tagDrafts.set(id, '');
            const current = document.querySelector(`.tag-editor-shell[data-tag-id="${CSS.escape(id)}"] .tag-entry-input`);
            if (current) current.value = '';
        }
        pendingTagCommits.delete(id);
        return fetchHistory();
    }).catch(() => {
        if (epoch !== tagSessionEpoch) return;
        pendingTagCommits.set(id, 'Save not confirmed. Refresh to check the current tags before trying again.');
        renderDownloadCollections();
    });
}

function tagRemove(id, tag) {
    if (removalBlocksWrites(id)) { announceTagStatus('Resolve the removal before changing this entry.'); return; }
    if (!hasTagProtocol()) return compatibilityTagMutation(String(id), tag, 'DELETE');
    const result = tagMutations.submit({ kind: 'tag.remove', targetId: String(id), value: tag, viewToken: tagEditorTokens.get(String(id)) });
    if (!result.accepted) announceTagStatus(result.message || 'Could not remove tag');
    else if (result.intentId) submittedTagIntents.add(result.intentId);
    renderDownloadCollections();
}

function bindTagEditors() {
    document.querySelectorAll('.tag-display-row').forEach(row => {
        if (row.dataset.tagDisplayBound) return;
        row.dataset.tagDisplayBound = '1';
        row.addEventListener('click', event => {
            event.stopPropagation();
            if (row.classList.contains('tag-display-row')) tagEditStart(row.dataset.tagId);
        });
        row.addEventListener('keydown', event => {
            if (!row.classList.contains('tag-display-row')) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                tagEditStart(row.dataset.tagId);
            }
        });
    });
    document.querySelectorAll('.tag-editor-shell, .tag-display-wrap').forEach(shell => {
        if (shell.dataset.tagEditorBound) return;
        shell.dataset.tagEditorBound = '1';
        const id = shell.dataset.tagId;
        shell.addEventListener('input', event => {
            if (!event.target.matches('.tag-entry-input')) return;
            const input = event.target;
            tagDrafts.set(id, input.value);
            const suggestions = shell.querySelector('.tag-entry-suggestions');
            const info = tagState.selectDownload(id) || { tags: [] };
            const html = tagSuggestionsHtml(info, input.value);
            suggestions.innerHTML = html;
            suggestions.hidden = !html;
            input.setAttribute('aria-expanded', String(Boolean(html)));
        });
        shell.addEventListener('keydown', event => {
            if (!event.target.matches('.tag-entry-input')) return;
            if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                tagCommit(id);
            } else if (event.key === 'Backspace' && !event.target.value) {
                const chips = shell.querySelectorAll('.tag-token-input > .tag-chip');
                const last = chips[chips.length - 1];
                if (last) {
                    event.preventDefault();
                    const remove = last.querySelector('[data-remove-tag]');
                    if (remove) tagRemove(id, remove.dataset.removeTag);
                    else announceTagStatus(`Tag ${last.querySelector('.tag-chip-label').textContent} is pending. Wait for confirmation.`);
                }
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                tagEditStop(id);
            }
        });
        shell.addEventListener('focusout', event => {
            const input = event.target;
            if (!input.matches('.tag-entry-input')) return;
            const token = tagEditorTokens.get(id);
            setTimeout(() => {
                if (!shell.isConnected || !input.isConnected || token !== tagEditorTokens.get(id)) return;
                if (!shell.contains(document.activeElement)) tagEditStop(id);
            }, 0);
        });
        shell.addEventListener('mousedown', event => {
            if (event.target.closest('[data-remove-tag], [data-suggest-tag], [data-tag-action]')) event.preventDefault();
        });
        shell.addEventListener('click', event => {
            const action = event.target.closest('[data-tag-action]');
            const remove = event.target.closest('[data-remove-tag]');
            const suggestion = event.target.closest('[data-suggest-tag]');
            if (action) {
                event.stopPropagation();
                const intentId = action.dataset.intentId;
                if (action.dataset.tagAction === 'check') tagMutations.recover(intentId);
                else if (action.dataset.tagAction === 'recover') tagMutations.recover(intentId, { replay: true });
                else if (action.dataset.tagAction === 'retry') tagMutations.retry(intentId);
                else if (action.dataset.tagAction === 'dismiss') {
                    if (!tagMutations.resolve(intentId)) announceTagStatus('The original save may still complete. Check its status before using the current tags.');
                }
                else if (action.dataset.tagAction === 'edit') {
                    const chip = tagState.selectDownload(id)?.tag_chips.find(chip => chip.intentId === intentId);
                    if (!chip) return;
                    if (tagDrafts.get(id)) {
                        announceTagStatus('Finish or clear your current draft before editing this failed tag.');
                        return;
                    }
                    if (!editingTagIds.has(id)) tagEditStart(id);
                    tagMutations.resolve(intentId);
                    tagDrafts.set(id, chip.name);
                    renderDownloadCollections();
                    const input = document.querySelector(`.tag-editor-shell[data-tag-id="${CSS.escape(id)}"] .tag-entry-input`);
                    if (input) { input.value = chip.name; input.focus(); }
                }
            } else if (remove || suggestion) {
                event.stopPropagation();
                if (remove) tagRemove(id, remove.dataset.removeTag);
                else tagCommit(id, suggestion.dataset.suggestTag);
            } else if (!event.target.closest('button') && shell.matches('.tag-editor-shell')) {
                shell.querySelector('.tag-entry-input')?.focus();
            }
        });
    });
}

function stopDownload(id, attemptId) {
    closeAllMenus();
    const upload = droppedUploads.get(String(id));
    if (upload) {
        stopDroppedUpload(upload).catch(() => {});
        return;
    }
    submitDownloadCommand('stop', id, attemptId);
}

function hasRenameProtocol() {
    return tagCapabilities?.mutation_protocol === 1 && tagCapabilities.actions?.includes('rename.set');
}

function renamePresentationText(id) {
    const intent = renameIntent(id);
    if (!intent) return '';
    const message = intent.status === 'unconfirmed' ? 'Rename not confirmed' : ['rejected', 'conflicted'].includes(intent.status) ? 'Rename needs attention' : 'Renaming…';
    return `${intent.value} · ${message}`;
}

function renameSurfaceStatus(info) {
    const text = renamePresentationText(info.id);
    return `<span class="rename-surface-status" data-rename-presentation="${escapeAttr(String(info.id))}"${text ? '' : ' hidden'}>${escapeHtml(text)}</span>`;
}

function refreshRenamePresentations() {
    for (const node of document.querySelectorAll('[data-rename-presentation]')) {
        const text = renamePresentationText(node.dataset.renamePresentation);
        node.hidden = !text;
        node.textContent = text;
    }
    for (const node of document.querySelectorAll('[data-rename-filename]')) {
        const model = tagState.selectDownload(node.dataset.renameFilename);
        if (model) node.textContent = displayFilename(projectTagEntry(model));
    }
    if (typeof endlessPlayback !== 'undefined' && endlessPlayback.currentDownloadId) {
        const title = document.getElementById('playerTitle');
        if (title) {
            title.textContent = currentPlayerDisplayTitle();
        }
    }
}

function currentPlayerDisplayTitle() {
    const item = endlessPlayback.currentItem;
    const id = endlessPlayback.currentDownloadId;
    const model = id ? tagState.selectDownload(id) : null;
    const title = item?.filenameTitle && model?.filename
        ? displayFilename({ ...model, requested_filename: null })
        : item?.title || 'Video playback';
    const pending = id ? renamePresentationText(id) : '';
    return `${title}${pending ? ` · ${pending}` : ''}`;
}

function renameIntent(id) {
    return tagState.selectDownload(String(id))?.rename_intents[0] || compatibilityRenames.get(String(id)) || null;
}

function pinRenameInteraction(id) {
    if (!renameEditPositions.has(id)) renameEditPositions.set(id, historyPageItems.findIndex(info => String(info.id) === id));
}

function releaseSettledRenameInteractions() {
    let released = false;
    for (const id of renameEditPositions.keys()) {
        if (!renameDrafts.has(id) && !renameIntent(id)) { renameEditPositions.delete(id); released = true; }
    }
    if (released && !renameEditPositions.size) resumeDeferredHistoryFetch();
}

function updateRenameMutationSummary(intents) {
    for (const id of ['renameMutationSummary', 'currentRenameMutationSummary']) {
        const summary = document.getElementById(id);
        if (!summary) continue;
        summary.hidden = !intents.length;
        summary.textContent = intents.length ? `${intents.length} ${intents.length === 1 ? 'rename' : 'renames'} ${intents.some(intent => intent.status === 'unconfirmed') ? 'not confirmed' : 'pending or needing attention'}. Open the entry’s file name for details.` : '';
    }
}

function renderRenameControl(id, basename, fullWidth = false) {
    id = String(id);
    const draft = renameDrafts.get(id);
    const intent = renameIntent(id);
    const busy = intent && ['queued', 'sending', 'unconfirmed'].includes(intent.status);
    const widthClass = fullWidth ? ' rename-wrap-block' : '';
    const widthStyle = draft?.width && !fullWidth ? `style="width:${draft.width}px"` : '';
    const action = (name, text) => `<button type="button" data-rename-recovery="${name}" data-intent-id="${escapeAttr(intent.id)}">${text}</button>`;
    let recovery = '';
    if (intent?.legacy && intent.status === 'unconfirmed') recovery = action('check', 'Check current name');
    else if (intent?.status === 'unconfirmed') recovery = action('check', 'Check rename') + action('recover', 'Replay') + action('dismiss', 'Use current name');
    else if (intent && ['rejected', 'conflicted'].includes(intent.status)) recovery = action('edit', 'Correct name') + action('retry', 'Retry') + action('dismiss', 'Dismiss');
    const message = intent ? (['queued', 'sending'].includes(intent.status) && !intent.delayed ? 'Renaming…' : intent.message) : draft?.error || '';
    const feedback = `<span class="rename-feedback" data-rename-state="${escapeAttr(intent?.status || (message ? 'rejected' : 'confirmed'))}"${message ? '' : ' hidden'}>${intent ? `<span class="rename-requested">${escapeHtml(intent.value)}</span> ` : ''}<span>${escapeHtml(message)}</span>${recovery}</span>`;
    const editor = draft
        ? `<input class="rename-input" type="text" aria-label="File name" ${widthStyle} value="${escapeAttr(draft.value)}" data-orig="${escapeAttr(basename)}" oninput="renameOnInput('${id}', this.value)" />
            <button class="rename-btn confirm" type="button" title="Save" aria-label="Save" onclick="renameCommit('${id}')"${busy ? ' disabled' : ''}><svg class="icon"><use href="#i-check"/></svg></button>
            <button class="rename-btn cancel" type="button" title="Cancel" aria-label="Cancel" onclick="renameCancel('${id}')"><svg class="icon"><use href="#i-x"/></svg></button>`
        : `<span class="rename-display" data-orig="${escapeAttr(basename)}">${escapeHtml(basename)}</span>
            <button class="rename-btn" type="button" title="Edit name" aria-label="Edit name" onclick="renameStart('${id}')"><svg class="icon"><use href="#i-pencil"/></svg></button>`;
    return `<span class="rename-wrap${widthClass}" data-rename-id="${escapeAttr(id)}" data-mode="${draft ? 'edit' : 'display'}"><span class="rename-editor-row">${editor}</span>${feedback}</span>`;
}

function renameOnInput(id, value) {
    const draft = renameDrafts.get(String(id));
    if (!draft) return;
    draft.value = value;
    draft.generation++;
    draft.error = '';
}

function bindRenameInputs() {
    document.querySelectorAll('.rename-wrap[data-mode="edit"] .rename-input').forEach(input => {
        if (input.dataset.bound === '1') return;
        input.dataset.bound = '1';
        const id = input.closest('.rename-wrap')?.dataset.renameId;
        if (!id) return;
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); renameCommit(id); }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); renameCancel(id); }
        });
    });
}

function renameStart(id) {
    id = String(id);
    const model = tagState.selectDownload(id);
    if (!model) return;
    const wrap = document.querySelector(`.rename-wrap[data-rename-id="${CSS.escape(id)}"]`);
    const width = Math.round(wrap?.querySelector('.rename-display')?.getBoundingClientRect().width || 0);
    const orig = renameIntent(id)?.value || displayFilename(model);
    pinRenameInteraction(id);
    renameDrafts.set(id, { value: orig, width, generation: 0, viewToken: ++renameViewSequence });
    renderDownloadCollections();
    const input = document.querySelector(`.rename-wrap[data-rename-id="${CSS.escape(id)}"] .rename-input`);
    if (!input) return;
    input.focus();
    const dot = orig.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : orig.length);
}

function renameCancel(id) {
    id = String(id);
    renameDrafts.delete(id);
    releaseSettledRenameInteractions();
    renderDownloadCollections();
}

function renameCommit(id) {
    if (removalBlocksWrites(id)) { announceTagStatus('Resolve the removal before changing this entry.'); return; }
    const startedAt = performance.now();
    id = String(id);
    const draft = renameDrafts.get(id);
    if (!draft) return;
    const existing = renameIntent(id);
    if (existing && ['queued', 'sending', 'unconfirmed'].includes(existing.status)) {
        announceTagStatus(existing.status === 'unconfirmed' ? 'Rename not confirmed. Check its status before submitting another name.' : 'Renaming… Your newer draft is retained.');
        return;
    }
    const value = draft.value.trim();
    if (!value || /[/\\\x00]/.test(value) || ['.', '..'].includes(value)) {
        draft.error = 'Enter a filename without path separators.';
        announceTagStatus(draft.error);
        renderDownloadCollections();
        return;
    }
    if (!hasRenameProtocol()) {
        startCompatibilityRename(id, value, draft);
        return;
    }
    if (existing && ['rejected', 'conflicted'].includes(existing.status)) {
        if (existing.legacy) clearCompatibilityRename(id);
        else tagMutations.resolve(existing.id);
    }
    const result = tagMutations.submit({ kind: 'rename.set', targetId: id, value, viewToken: draft.viewToken });
    if (!result.accepted) {
        draft.error = result.message;
        announceTagStatus(result.message);
    } else if (result.intentId) {
        draft.submittedGeneration = draft.generation;
        draft.submittedViewToken = draft.viewToken;
        draft.submittedIntentId = result.intentId;
        submittedTagIntents.add(result.intentId);
        pinRenameInteraction(id);
    } else renameDrafts.delete(id);
    renderDownloadCollections();
    refreshRenamePresentations();
    renameMutationMetrics.latestLocalFeedbackMs = performance.now() - startedAt;
    mutationMetrics.latestLocalFeedbackMs = renameMutationMetrics.latestLocalFeedbackMs;
}

function clearCompatibilityRename(id) {
    compatibilityRenames.get(id)?.timers?.forEach(clearTimeout);
    compatibilityRenames.delete(id);
}

async function checkCompatibilityRename(intent) {
    const epoch = tagSessionEpoch;
    const context = tagState.capture();
    try {
        const response = await apiFetch(`/api/downloads/${encodeURIComponent(intent.targetId)}/editable-state`);
        if (epoch !== tagSessionEpoch || compatibilityRenames.get(intent.targetId) !== intent) return false;
        if ([403, 404].includes(response.status)) { tagMutations.fence(intent.targetId); return false; }
        const body = await response.json();
        if (epoch !== tagSessionEpoch || compatibilityRenames.get(intent.targetId) !== intent) return false;
        renameMutationMetrics.reconciliationReads++;
        mutationMetrics.reconciliationReads++;
        if (response.ok && String(body?.id) === intent.targetId && typeof body.filename === 'string') return tagState.acceptDownload(body, context);
    } catch (_) { /* A current name cannot prove a lost legacy request's outcome. */ }
    return false;
}

function startCompatibilityRename(id, value, draft) {
    const existing = compatibilityRenames.get(id);
    if (existing && existing.status !== 'rejected') return;
    const epoch = tagSessionEpoch;
    const intent = { id: `legacy-rename-${++renameViewSequence}`, targetId: id, kind: 'rename.set', value, status: 'sending', legacy: true };
    compatibilityRenames.set(id, intent);
    pinRenameInteraction(id);
    const generation = draft.generation;
    const viewToken = draft.viewToken;
    const startedAt = performance.now();
    renameMutationMetrics.submissions++;
    mutationMetrics.submissions++;
    renderDownloadCollections();
    refreshRenamePresentations();
    renameMutationMetrics.latestLocalFeedbackMs = performance.now() - startedAt;
    mutationMetrics.latestLocalFeedbackMs = renameMutationMetrics.latestLocalFeedbackMs;
    announceTagStatus('Renaming…');
    const timer = setTimeout(() => {
        if (epoch !== tagSessionEpoch || compatibilityRenames.get(id) !== intent || intent.status !== 'sending') return;
        intent.delayed = true;
        intent.message = 'Still waiting for rename confirmation.';
        renderDownloadCollections();
        announceTagStatus(intent.message);
    }, 5000);
    const timeoutTimer = setTimeout(() => {
        if (epoch !== tagSessionEpoch || compatibilityRenames.get(id) !== intent || intent.status !== 'sending') return;
        intent.status = 'unconfirmed';
        intent.message = 'Rename not confirmed. This server cannot safely replay it. Checking the current name does not prove completion.';
        renderDownloadCollections();
        announceTagStatus(intent.message);
    }, 30000);
    intent.timers = [timer, timeoutTimer];
    apiFetch('/api/rename/' + encodeURIComponent(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: value }),
    }).then(async response => {
        const body = await response.json().catch(() => null);
        if (epoch !== tagSessionEpoch || compatibilityRenames.get(id) !== intent) return;
        if ([403, 404].includes(response.status)) { tagMutations.fence(id); return; }
        if (response.ok && body?.id === id && typeof body.filename === 'string') {
            const checked = await checkCompatibilityRename(intent);
            if (epoch !== tagSessionEpoch || compatibilityRenames.get(id) !== intent) return;
            if (!checked) await fetchHistory();
            if (epoch !== tagSessionEpoch || compatibilityRenames.get(id) !== intent) return;
            clearCompatibilityRename(id);
            const currentDraft = renameDrafts.get(id);
            if (currentDraft === draft && draft.generation === generation && draft.viewToken === viewToken && draft.value.trim() === value) renameDrafts.delete(id);
            renameMutationMetrics.acknowledgements++;
            mutationMetrics.acknowledgements++;
            renameMutationMetrics.latestAcknowledgementMs = performance.now() - startedAt;
            mutationMetrics.latestAcknowledgementMs = renameMutationMetrics.latestAcknowledgementMs;
            announceTagStatus('Renamed.');
        } else if ([400, 409, 410, 413, 422].includes(response.status)) {
            intent.status = 'rejected';
            intent.message = 'Could not rename. Correct the name or try again.';
            renameMutationMetrics.rejectedOutcomes++;
            mutationMetrics.rejectedOutcomes++;
            announceTagStatus(intent.message);
        } else throw new Error('Rename not confirmed');
    }).catch(() => {
        if (epoch !== tagSessionEpoch || compatibilityRenames.get(id) !== intent) return;
        intent.status = 'unconfirmed';
        intent.message = 'Rename not confirmed. This server cannot safely replay it. Checking the current name does not prove completion.';
        renameMutationMetrics.unconfirmedOutcomes++;
        mutationMetrics.unconfirmedOutcomes++;
        announceTagStatus(intent.message);
    }).finally(() => {
        clearTimeout(timer);
        clearTimeout(timeoutTimer);
        if (epoch !== tagSessionEpoch) return;
        releaseSettledRenameInteractions();
        renderDownloadCollections();
        refreshRenamePresentations();
    });
}

document.addEventListener('click', event => {
    const button = event.target.closest('[data-rename-recovery]');
    if (!button) return;
    const intentId = button.dataset.intentId;
    const intent = tagMutations.status(intentId) || [...compatibilityRenames.values()].find(entry => entry.id === intentId);
    if (!intent) return;
    const action = button.dataset.renameRecovery;
    if (intent.legacy) {
        if (action === 'check') checkCompatibilityRename(intent);
        else if (intent.status === 'rejected') {
            clearCompatibilityRename(intent.targetId);
            if (action === 'retry') { const draft = renameDrafts.get(intent.targetId); if (draft) startCompatibilityRename(intent.targetId, intent.value, draft); }
            else if (action === 'edit' && !renameDrafts.has(intent.targetId)) renameStart(intent.targetId);
        }
        renderDownloadCollections();
        return;
    }
    if (action === 'check') tagMutations.recover(intentId);
    else if (action === 'recover') tagMutations.recover(intentId, { replay: true });
    else if (action === 'retry') tagMutations.retry(intentId);
    else if (action === 'edit') {
        const draft = renameDrafts.get(intent.targetId);
        if (draft && draft.value.trim() && draft.value !== intent.value) {
            announceTagStatus('Finish or clear your newer name before restoring the failed name.');
            return;
        }
        tagMutations.resolve(intentId);
        renameStart(intent.targetId);
        const restored = renameDrafts.get(intent.targetId);
        if (restored) {
            restored.value = intent.value;
            restored.generation++;
            const input = document.querySelector(`.rename-wrap[data-rename-id="${CSS.escape(intent.targetId)}"] .rename-input`);
            if (input) input.value = intent.value;
        }
        renderDownloadCollections();
    } else if (!tagMutations.resolve(intentId)) announceTagStatus('The original rename may still complete. Check its status before using the current name.');
    releaseSettledRenameInteractions();
    renderDownloadCollections();
});

function pauseDownload(id, attemptId) { closeAllMenus(); return submitDownloadCommand('pause', id, attemptId); }
function unpauseDownload(id, attemptId) { closeAllMenus(); return submitDownloadCommand('unpause', id, attemptId); }
function reloadDownload(id, url, attemptId) { closeAllMenus(); return submitDownloadCommand('retry', id, attemptId); }
function continueDownload(id, url, attemptId) { closeAllMenus(); return submitDownloadCommand('resume', id, attemptId); }

function hasDownloadCommandProtocol(action) {
    return tagCapabilities?.mutation_protocol === 1 && tagCapabilities.actions?.includes(`download.${action}`);
}
function clearCompatibilityCommand(id) {
    const entry = compatibilityCommands.get(id);
    if (entry) entry.timers.forEach(clearTimeout);
    compatibilityCommands.delete(id);
}
function downloadCommandIntents(id) {
    return tagMutations.pending().filter(entry => entry.kind.startsWith('download.') && entry.kind !== 'download.submit' && entry.targetId === String(id))
        .concat(compatibilityCommands.has(String(id)) ? [compatibilityCommands.get(String(id))] : []);
}
function downloadCommandText(intent) {
    if (intent.message) return intent.message;
    const label = { 'download.pause': 'Pausing…', 'download.unpause': 'Resuming…', 'download.stop': 'Stopping…', 'download.retry': 'Starting…', 'download.resume': 'Starting…' }[intent.kind];
    return intent.status === 'queued' ? `${label} Queued behind the previous request.` : label;
}
function announceDownloadCommand(entry, message) {
    if (!entry || !message || commandAnnouncements.get(entry.id)?.message === message) return;
    if (commandAnnouncements.size >= 256) commandAnnouncements.delete(commandAnnouncements.keys().next().value);
    commandAnnouncements.set(entry.id, { targetId: entry.targetId, message });
    // The existing live regions alternate with the native Current dialog:
    // its inner region is exposed while the page region is inert, and vice versa.
    announceTagStatus(message);
}
function downloadCommandStatusHtml(id, attemptId = null) {
    const intents = downloadCommandIntents(id).filter(entry => attemptId === null || entry.value.attempt_id === attemptId);
    const notice = commandNotices.get(String(id));
    const action = (entry, mode, label) => `<button type="button" data-command-recovery="${mode}" data-intent-id="${escapeAttr(entry.id)}">${label}</button>`;
    return intents.map(entry => `<div class="download-command-message" data-command-state="${entry.status}"><span>${escapeHtml(downloadCommandText(entry))}</span>${entry.status === 'unconfirmed' ? (entry.legacy ? action(entry, 'check', 'Check current state') : action(entry, 'check', 'Check request') + action(entry, 'replay', 'Recover request') + action(entry, 'dismiss', 'Use current state')) : ['rejected', 'conflicted'].includes(entry.status) ? action(entry, 'dismiss', 'Review current state') : entry.status === 'queued' ? action(entry, 'dismiss', 'Discard queued request') : ''}</div>`).join('')
        || (notice && (attemptId === null || notice.attemptId === attemptId) ? `<span>${escapeHtml(notice.message)}</span>` : '');
}
function downloadCommandStatusSlot(id, attemptId = null) {
    return `<div class="download-command-status" data-download-command-status="${escapeAttr(id)}"${attemptId === null ? '' : ` data-command-attempt="${escapeAttr(attemptId)}"`} role="status" aria-live="off" aria-atomic="true">${downloadCommandStatusHtml(id, attemptId)}</div>`;
}
function refreshDownloadCommandPresentations() {
    const entries = tagMutations.pending().filter(entry => entry.kind.startsWith('download.') && entry.kind !== 'download.submit').concat([...compatibilityCommands.values()]);
    for (const entry of entries) if (entry.status === 'sending' && entry.delayed) announceDownloadCommand(entry, downloadCommandText(entry));
    for (const node of document.querySelectorAll('[data-download-command-status]')) {
        const html = downloadCommandStatusHtml(node.dataset.downloadCommandStatus, node.dataset.commandAttempt || null);
        if (node.innerHTML !== html) node.innerHTML = html;
    }
    for (const button of document.querySelectorAll('[data-download-command]')) {
        const pending = downloadCommandIntents(button.dataset.downloadId);
        const canQueueStop = button.dataset.downloadCommand === 'stop' && pending.every(entry => entry.kind === 'download.pause' && ['queued', 'sending', 'unconfirmed'].includes(entry.status));
        button.disabled = pending.length > 0 && !canQueueStop;
        button.setAttribute('aria-busy', String(pending.some(entry => entry.kind === `download.${button.dataset.downloadCommand}` && ['queued', 'sending'].includes(entry.status))));
    }
    for (const button of document.querySelectorAll('[data-attempt-action="resume"], [data-attempt-action="retry"]')) {
        const info = attemptRows.get(button.dataset.attemptId)?.info;
        if (info) { button.disabled = false; button.setAttribute('aria-disabled', String(downloadCommandIntents(info.download_id).length > 0)); }
    }
    const summary = document.getElementById('downloadCommandSummary');
    if (summary) {
        const groups = new Map(entries.map(entry => [JSON.stringify([entry.targetId, entry.value.attempt_id]), entry]));
        const html = [...groups.values()].map(entry => {
            const model = tagState.writer.confirmed(entry.targetId);
            const label = model?.title || model?.display_filename || 'Download request';
            return `<div class="download-command-summary-entry"><strong>${escapeHtml(label)}</strong>${downloadCommandStatusHtml(entry.targetId, entry.value.attempt_id)}</div>`;
        }).join('');
        if (summary.innerHTML !== html) summary.innerHTML = html;
        summary.hidden = !entries.length;
    }
    downloadCommandMetrics.pending = entries.filter(entry => ['queued', 'sending', 'unconfirmed', 'conflicted'].includes(entry.status)).length;
    downloadCommandMetrics.unconfirmed = entries.filter(entry => entry.status === 'unconfirmed').length;
    downloadCommandMetrics.conflicted = entries.filter(entry => entry.status === 'conflicted').length;
}
function handleDownloadCommandEvent(event) {
    const entry = tagMutations.status(event.intentId);
    if (event.outcome === 'confirmed' && entry) {
        if (commandNotices.size >= 128) commandNotices.delete(commandNotices.keys().next().value);
        commandNotices.set(entry.targetId, { attemptId: entry.value.attempt_id, workerStatus: tagState.writer.confirmed(entry.targetId)?.status, message: 'Request accepted. Worker status updates separately.' });
        if (entry.kind === 'download.stop') activeUploadRequests.get(entry.targetId)?.abort();
        announceDownloadCommand(entry, 'Request accepted. Worker status updates separately.');
    } else if (entry && event.outcome === 'presented') {
        const queued = downloadCommandIntents(entry.targetId).some(other => other.id !== entry.id && ['queued', 'sending', 'unconfirmed', 'conflicted'].includes(other.status));
        announceDownloadCommand(entry, downloadCommandText(queued ? entry : { ...entry, status: 'sending' }));
    } else if (entry && ['rejected', 'conflicted', 'unconfirmed'].includes(event.outcome)) announceDownloadCommand(entry, downloadCommandText(entry));
    refreshDownloadCommandPresentations();
}
function submitDownloadCommand(action, rawId, attemptId) {
    const id = String(rawId);
    if (removalBlocksWrites(id)) { announceTagStatus('Resolve the removal before changing this entry.'); return { accepted: false, reason: 'unresolved' }; }
    const model = tagState.selectDownload(id);
    if (!model) { announceTagStatus('This download is unavailable.'); return; }
    const sourceAttempt = attemptId === undefined ? model.current_attempt_id : attemptId;
    if (attemptId !== undefined && typeof model.command_revision === 'string' && sourceAttempt !== model.current_attempt_id) {
        announceTagStatus('This is an older attempt. Review the current download before trying again.');
        return { accepted: false, reason: 'unavailable' };
    }
    commandNotices.delete(id);
    const started = performance.now();
    if (hasDownloadCommandProtocol(action)) {
        const result = tagMutations.submit({ kind: `download.${action}`, targetId: id, value: { attempt_id: sourceAttempt } });
        if (!result.accepted) announceTagStatus(result.message || 'Resolve the current request first.');
        refreshDownloadCommandPresentations();
        downloadCommandMetrics.latestLocalFeedbackMs = Math.max(0, performance.now() - started);
        mutationMetrics.latestLocalFeedbackMs = downloadCommandMetrics.latestLocalFeedbackMs;
        return result;
    }
    // Legacy contracts can show delivery feedback, but cannot correlate an unknown request.
    if (downloadCommandIntents(id).length || compatibilityCommands.size + tagMutations.pending().length >= 128) return;
    const epoch = tagSessionEpoch;
    const entry = { id: `legacy-command-${id}`, targetId: id, kind: `download.${action}`, value: { attempt_id: sourceAttempt ?? null }, status: 'sending', message: '', legacy: true, timers: [] };
    compatibilityCommands.set(id, entry);
    announceDownloadCommand(entry, downloadCommandText(entry));
    for (const metrics of [downloadCommandMetrics, mutationMetrics]) metrics.submissions++;
    refreshDownloadCommandPresentations();
    downloadCommandMetrics.latestLocalFeedbackMs = Math.max(0, performance.now() - started);
    mutationMetrics.latestLocalFeedbackMs = downloadCommandMetrics.latestLocalFeedbackMs;
    const current = () => epoch === tagSessionEpoch && compatibilityCommands.get(id) === entry && tagState.isAvailable(id);
    const unknown = () => { if (!current()) return; if (entry.status !== 'unconfirmed') for (const metrics of [downloadCommandMetrics, mutationMetrics]) metrics.unconfirmedOutcomes++; entry.status = 'unconfirmed'; entry.message = 'Request not confirmed. This server cannot safely replay it. Current worker status does not prove acceptance.'; refreshDownloadCommandPresentations(); announceDownloadCommand(entry, entry.message); };
    entry.timers = [setTimeout(() => { if (current() && entry.status === 'sending') { entry.message = 'Still waiting for request confirmation.'; refreshDownloadCommandPresentations(); announceDownloadCommand(entry, entry.message); } }, 5000), setTimeout(unknown, 30000)];
    apiFetch(`/api/${action}/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_attempt_id: sourceAttempt ?? null }) }).then(async response => {
        const body = await response.json().catch(() => null);
        if (!current()) return;
        if ([401, 403, 404].includes(response.status)) { tagMutations.fence(id); return; }
        if (response.ok && body?.id === id) {
            if (commandNotices.size >= 128) commandNotices.delete(commandNotices.keys().next().value);
            commandNotices.set(id, { attemptId: sourceAttempt, workerStatus: tagState.writer.confirmed(id)?.status, message: 'Request accepted. Worker status updates separately.' });
            clearCompatibilityCommand(id);
            announceDownloadCommand(entry, 'Request accepted. Worker status updates separately.');
            for (const metrics of [downloadCommandMetrics, mutationMetrics]) { metrics.acknowledgements++; metrics.latestAcknowledgementMs = performance.now() - started; }
            if (action === 'stop') activeUploadRequests.get(id)?.abort();
        } else if ([400, 409, 410, 413, 422, 429].includes(response.status)) {
            entry.status = 'rejected'; entry.message = `Request refused. ${typeof body?.error === 'string' ? body.error : 'Review current eligibility.'}`;
            announceDownloadCommand(entry, entry.message);
            for (const metrics of [downloadCommandMetrics, mutationMetrics]) metrics.rejectedOutcomes++;
        } else unknown();
        refreshDownloadCommandPresentations();
    }).catch(unknown).finally(() => entry.timers.forEach(clearTimeout));
}
document.addEventListener('click', async event => {
    const button = event.target.closest('[data-command-recovery]');
    if (!button) return;
    const mode = button.dataset.commandRecovery;
    const id = button.dataset.intentId;
    const legacy = [...compatibilityCommands.values()].find(entry => entry.id === id);
    if (legacy) {
        if (mode === 'check') { downloadCommandMetrics.reconciliationReads++; await checkTagAvailability(legacy.targetId); }
        else if (legacy.status === 'rejected') { clearCompatibilityCommand(legacy.targetId); fetchHistory(); fetchAttemptHistory(); }
    } else if (mode === 'check') await tagMutations.recover(id);
    else if (mode === 'replay') await tagMutations.recover(id, { replay: true });
    else if (!tagMutations.resolve(id)) announceTagStatus('The original request may still complete. Check its status before submitting another command.');
    else { fetchHistory(); fetchAttemptHistory(); }
    refreshDownloadCommandPresentations();
});

function hasRemovalProtocol() {
    return tagCapabilities?.mutation_protocol === 1 && tagCapabilities.entry_removal === 1 && tagCapabilities.actions?.includes('entry.remove');
}
function removalIntent(id) {
    return tagMutations.pending().find(entry => entry.kind === 'entry.remove' && entry.targetId === String(id)) || compatibilityRemovals.get(String(id)) || null;
}
function removalBlocksWrites(id) {
    const intent = removalIntent(id);
    return !!intent && intent.status !== 'rejected' || bulkLibraryRetainedPositions().has(String(id));
}
function clearCompatibilityRemoval(id) {
    const entry = compatibilityRemovals.get(String(id));
    if (entry) entry.timers.forEach(clearTimeout);
    compatibilityRemovals.delete(String(id));
}
function removalText(entry) {
    return entry.message || (entry.status === 'unconfirmed' ? 'Removal not confirmed.' : 'Removing…');
}
function removalStatusHtml(id) {
    const entry = removalIntent(id);
    if (!entry) return '';
    const action = (mode, label) => `<button type="button" data-removal-action="${mode}" data-intent-id="${escapeAttr(entry.id)}">${label}</button>`;
    const controls = entry.status === 'unconfirmed'
        ? entry.legacy ? action('check', 'Check current entry')
            : action('check', 'Check removal') + (!entry.replayExpired ? action('replay', 'Recover removal') : '') + (entry.canResolve ? action('resolve', 'Use current state') : '')
        : ['rejected', 'conflicted'].includes(entry.status) ? action('resolve', 'Review current entry') : '';
    return `<div class="download-command-message" data-removal-state="${escapeAttr(entry.status)}">${['queued', 'sending'].includes(entry.status) && !entry.delayed ? '<span class="options-spinner" aria-hidden="true"></span>' : ''}<span>${escapeHtml(removalText(entry))}</span>${controls}</div>`;
}
function removalStatusSlot(id) {
    return `<div class="download-command-status entry-removal-status" data-removal-status="${escapeAttr(id)}" aria-live="off">${removalStatusHtml(id)}</div>`;
}
function refreshRemovalPresentations() {
    const entries = tagMutations.pending().filter(entry => entry.kind === 'entry.remove').concat([...compatibilityRemovals.values()]);
    for (const [id] of removalPositions) if (!removalIntent(id)) removalPositions.delete(id);
    for (const node of document.querySelectorAll('[data-removal-status]')) {
        const html = removalStatusHtml(node.dataset.removalStatus);
        if (node.innerHTML !== html) node.innerHTML = html;
    }
    for (const entry of entries) {
        const message = removalText(entry);
        if (removalAnnouncements.get(entry.id) !== message) {
            removalAnnouncements.set(entry.id, message);
            announceTagStatus(message);
        }
    }
    for (const id of removalAnnouncements.keys()) if (!entries.some(entry => entry.id === id)) removalAnnouncements.delete(id);
    for (const row of document.querySelectorAll('[data-row-id]')) {
        const blocked = removalBlocksWrites(row.dataset.rowId);
        row.classList.toggle('entry-removal-pending', blocked);
        row.setAttribute('aria-busy', String(blocked));
        for (const control of row.querySelectorAll('[data-entry-remove], [data-favorite-action], [data-download-command], .rename-btn.confirm, .tag-chip-remove, [data-remove-tag], [data-suggest-tag], .history-visibility-select')) {
            if (blocked) {
                if (control.dataset.removalDisabled === undefined) control.dataset.removalDisabled = String(control.disabled);
                control.disabled = true;
            } else if (control.dataset.removalDisabled !== undefined) {
                control.disabled = control.dataset.removalDisabled === 'true';
                delete control.dataset.removalDisabled;
            }
        }
    }
    for (const button of document.querySelectorAll('[data-attempt-action="resume"], [data-attempt-action="retry"]')) {
        const info = attemptRows.get(button.dataset.attemptId)?.info;
        if (info) button.setAttribute('aria-disabled', String(removalBlocksWrites(info.download_id) || downloadCommandIntents(info.download_id).length > 0));
    }
    const summary = document.getElementById('removal-mutation-summary');
    if (summary) {
        const html = entries.map(entry => `<div class="download-command-summary-entry"><strong>${escapeHtml(tagState.writer.confirmed(entry.targetId)?.title || 'Entry removal')}</strong>${removalStatusHtml(entry.targetId)}</div>`).join('');
        if (summary.innerHTML !== html) summary.innerHTML = html;
        summary.hidden = !entries.length;
    }
    for (const [field, statuses] of [['pending', ['queued', 'sending', 'unconfirmed', 'conflicted']], ['unconfirmed', ['unconfirmed']], ['conflicted', ['conflicted']]]) removalMutationMetrics[field] = entries.filter(entry => statuses.includes(entry.status)).length;
}
function finishRemovalPresentation(id, { announce = true, render = true } = {}) {
    removalPositions.delete(String(id));
    invalidateLibraryOrder();
    // Playback stays intact while delivery is unresolved. Only a correlated
    // deletion result retires a player that still points at the removed media.
    if (endlessPlayback.currentDownloadId === String(id)) closePlayer();
    ++attemptRequest;
    for (const record of attemptRows.values()) if (String(record.info.download_id) === String(id)) {
        record.info.media_state = 'removed';
        record.info.library_id = null;
        record.info.can_resume = false;
        record.info.can_retry = false;
        record.html = attemptRowHtml(record.info);
        const node = document.getElementById(`attempt-${record.info.id}`);
        if (!node) continue;
        const opened = node.querySelector('details')?.open;
        const hadFocus = node.contains(document.activeElement);
        node.innerHTML = record.html;
        if (node.querySelector('details')) node.querySelector('details').open = Boolean(opened);
        if (hadFocus) node.focus({ preventScroll: true });
    }
    if (announce) announceTagStatus('Entry removed.');
    if (render) { renderDownloadCollections(); renderUploadRecovery(); refreshRemovalPresentations(); }
}
function handleRemovalMutationEvent(event) {
    const entry = tagMutations.status(event.intentId);
    if (event.outcome === 'reconciliation') removalMutationMetrics.reconciliationReads++;
    if (event.outcome === 'confirmed' && entry) finishRemovalPresentation(entry.targetId);
    else refreshRemovalPresentations();
}
function deleteDownload(rawId) {
    const id = String(rawId);
    closeAllMenus();
    const existing = removalIntent(id);
    if (existing) { announceTagStatus(removalText(existing)); return; }
    const upload = droppedUploads.get(id);
    if (upload && !upload.registered && upload.settled && !upload.unknown && !uploadIntent(upload)) {
        droppedUploads.delete(id);
        tagMutations.fence(id);
        renderDroppedUploads();
        return;
    }
    if (upload && (!upload.settled || upload.unknown || uploadIntent(upload))) {
        announceTagStatus('Check upload status and wait for its confirmed outcome before removing it.');
        return;
    }
    const model = tagState.selectDownload(id);
    if (!model || unavailableTagIds.has(id)) return;
    if (tagMutations.pending().some(entry => entry.targetId === id && !['rejected', 'conflicted'].includes(entry.status)) || compatibilityCommands.has(id) || compatibilityRenames.has(id) || compatibilityFavorites.has(id) || pendingTagCommits.has(id)) {
        announceTagStatus('Resolve pending changes before removing this entry.');
        return;
    }
    const started = performance.now();
    removalPositions.set(id, historyPageItems.findIndex(info => String(info.id) === id));
    if (hasRemovalProtocol()) {
        const result = tagMutations.submit({ kind: 'entry.remove', targetId: id, value: { scope: 'entry-and-files' } });
        if (!result.accepted) { removalPositions.delete(id); announceTagStatus(result.message || 'Removal could not be submitted.'); }
        renderDownloadCollections();
        removalMutationMetrics.latestLocalFeedbackMs = Math.max(0, performance.now() - started);
        mutationMetrics.latestLocalFeedbackMs = removalMutationMetrics.latestLocalFeedbackMs;
        return result;
    }
    if (compatibilityRemovals.size + tagMutations.pending().length >= 128) { removalPositions.delete(id); announceTagStatus('Resolve existing requests before removing another entry.'); return; }
    const epoch = tagSessionEpoch;
    const entry = { id: `legacy-removal-${id}`, targetId: id, kind: 'entry.remove', value: { scope: 'entry-and-files' }, status: 'sending', message: '', legacy: true, timers: [] };
    compatibilityRemovals.set(id, entry);
    const current = () => epoch === tagSessionEpoch && compatibilityRemovals.get(id) === entry && tagState.isAvailable(id);
    const unknown = () => {
        if (!current()) return;
        if (entry.status !== 'unconfirmed') for (const metrics of [removalMutationMetrics, mutationMetrics]) metrics.unconfirmedOutcomes++;
        entry.status = 'unconfirmed'; entry.message = 'Removal not confirmed. This server cannot safely replay it. Check the current entry before doing anything else.';
        refreshRemovalPresentations();
    };
    entry.timers = [setTimeout(() => { if (current() && entry.status === 'sending') { entry.delayed = true; entry.message = 'Still waiting for removal confirmation.'; refreshRemovalPresentations(); } }, 5000), setTimeout(unknown, 30000)];
    for (const metrics of [removalMutationMetrics, mutationMetrics]) metrics.submissions++;
    renderDownloadCollections();
    removalMutationMetrics.latestLocalFeedbackMs = Math.max(0, performance.now() - started);
    mutationMetrics.latestLocalFeedbackMs = removalMutationMetrics.latestLocalFeedbackMs;
    apiFetch(`/api/remove/${encodeURIComponent(id)}`, { method: 'POST' }).then(async response => {
        const body = await response.json().catch(() => null);
        if (!current()) return;
        if ([401, 403, 404].includes(response.status)) { tagMutations.fence(id); return; }
        if (response.ok && body?.id === id && (body.message === 'Removed' || body.removed === true)) {
            clearCompatibilityRemoval(id);
            tagMutations.fence(id, true);
            for (const metrics of [removalMutationMetrics, mutationMetrics]) { metrics.acknowledgements++; metrics.latestAcknowledgementMs = Math.max(0, performance.now() - started); }
            finishRemovalPresentation(id);
        } else if ([400, 409, 410, 413, 422, 429].includes(response.status)) {
            entry.status = 'rejected'; entry.message = `Removal refused. ${typeof body?.error === 'string' ? body.error : 'Review current eligibility before trying again.'}`;
            for (const metrics of [removalMutationMetrics, mutationMetrics]) metrics.rejectedOutcomes++;
            refreshRemovalPresentations();
        } else unknown();
    }).catch(unknown).finally(() => entry.timers.forEach(clearTimeout));
}
document.addEventListener('click', async event => {
    const button = event.target.closest('[data-removal-action]');
    if (!button) return;
    const mode = button.dataset.removalAction;
    const intentId = button.dataset.intentId;
    const legacy = [...compatibilityRemovals.values()].find(entry => entry.id === intentId);
    if (legacy) {
        if (mode === 'check') { removalMutationMetrics.reconciliationReads++; await checkTagAvailability(legacy.targetId); }
        else if (legacy.status === 'rejected') { clearCompatibilityRemoval(legacy.targetId); removalPositions.delete(legacy.targetId); }
    } else if (mode === 'check') await tagMutations.recover(intentId);
    else if (mode === 'replay') await tagMutations.recover(intentId, { replay: true });
    else if (!tagMutations.resolve(intentId)) announceTagStatus('The original removal may still complete. Check its status before submitting another removal.');
    renderDownloadCollections();
});

function hasFavoriteProtocol() {
    return tagCapabilities?.mutation_protocol === 1 && tagCapabilities.actions?.includes('favorite.set');
}

function pinFavoriteInteraction(id) {
    if (favoriteEditPositions.has(id)) return;
    const cards = [...document.getElementById('historyList').children];
    favoriteEditPositions.set(id, cards.findIndex(card => card.dataset.rowId === id));
}

function releaseSettledFavoriteInteractions() {
    const before = favoriteEditPositions.size;
    for (const id of favoriteEditPositions.keys()) {
        const model = tagState.selectDownload(id);
        const busy = model?.favorite_intents.length || compatibilityFavorites.has(id);
        const controls = [...document.querySelectorAll('[data-favorite-control]')].filter(control => control.dataset.favoriteControl === id);
        const interacting = controls.some(control => control.contains(document.activeElement) || control.matches(':hover'));
        if (!busy && !interacting) favoriteEditPositions.delete(id);
    }
    if (before && !favoriteEditPositions.size) resumeDeferredHistoryFetch();
}

function updateFavoriteMutationSummary(intents) {
    for (const id of ['favoriteMutationSummary', 'currentFavoriteMutationSummary']) {
        const summary = document.getElementById(id);
        if (!summary) continue;
        const count = intents.length + compatibilityFavorites.size;
        summary.hidden = !count;
        summary.textContent = count ? `${count} favorite ${count === 1 ? 'edit' : 'edits'} ${intents.some(intent => intent.status === 'unconfirmed') ? 'not confirmed' : 'pending or needing attention'}. Open the entry’s favorite for details.` : '';
    }
}

function renderFavoriteControl(info, inline = false) {
    const id = String(info.id);
    const favorite = Boolean(info.favorite);
    const label = favorite ? 'Remove from favorites' : 'Add to favorites';
    const intents = info.favorite_intents || [];
    const pending = compatibilityFavorites.get(id);
    const status = intents.find(intent => ['unconfirmed', 'conflicted', 'rejected'].includes(intent.status)) || intents[0];
    const state = status?.status || pending?.status || 'confirmed';
    let message = status?.message || pending?.message || (status ? 'Saving favorite' : favoriteNotices.get(id) || '');
    if (status && ['sending', 'queued'].includes(status.status) && !status.delayed) message = 'Saving favorite';
    const action = (name, text) => `<button type="button" data-favorite-recovery="${name}" data-intent-id="${escapeAttr(status.id)}">${text}</button>`;
    let recovery = '';
    if (status?.status === 'unconfirmed') recovery = action('check', 'Check save') + action('recover', 'Replay') + action('dismiss', 'Use current favorite');
    else if (status && ['rejected', 'conflicted'].includes(status.status)) recovery = action('retry', 'Retry') + action('dismiss', 'Dismiss');
    const queued = intents.filter(intent => intent.status === 'queued');
    if (queued.length) recovery += queued.map(intent => `<button type="button" data-favorite-recovery="dismiss" data-intent-id="${escapeAttr(intent.id)}">Discard queued favorite ${intent.value ? 'add' : 'removal'}</button>`).join('');
    return `<span data-favorite-control="${escapeAttr(id)}" class="favorite-control${inline ? ' favorite-control-inline' : ''}">
        <button class="favorite-toggle${inline ? ' favorite-toggle-inline' : ''}" type="button" data-favorite-action data-download-id="${escapeAttr(id)}" data-favorite="${!favorite}" aria-label="${label}" title="${label}" aria-pressed="${favorite}"${pending ? ' disabled' : ''}><svg aria-hidden="true"><use href="#i-star"/></svg></button>
        <span class="favorite-feedback" data-favorite-state="${state}"${message ? '' : ' hidden'}><span>${escapeHtml(message)}</span>${recovery}</span>
    </span>`;
}

function toggleFavorite(button) {
    if (button.disabled) return;
    const id = String(button.dataset.downloadId);
    if (removalBlocksWrites(id)) return;
    const model = tagState.selectDownload(id);
    if (!model || unavailableTagIds.has(id)) return;
    const favorite = !model.favorite;
    pinFavoriteInteraction(id);
    favoriteNotices.delete(id);
    if (hasFavoriteProtocol()) {
        const result = tagMutations.submit({ kind: 'favorite.set', targetId: id, value: favorite });
        if (!result.accepted) {
            favoriteNotices.set(id, result.message);
            announceTagStatus(result.message);
        } else if (result.intentId) submittedTagIntents.add(result.intentId);
        const feedbackStartedAt = performance.now();
        renderDownloadCollections();
        favoriteMutationMetrics.latestLocalFeedbackMs = performance.now() - feedbackStartedAt;
        mutationMetrics.latestLocalFeedbackMs = favoriteMutationMetrics.latestLocalFeedbackMs;
        announceTagStatus(result.accepted ? 'Saving favorite' : result.message);
        return;
    }
    // A legacy server has no receipt contract: show request feedback only.
    const epoch = tagSessionEpoch;
    compatibilityFavorites.set(id, { status: 'sending', message: 'Saving favorite' });
    renderDownloadCollections();
    const timer = setTimeout(() => {
        if (epoch !== tagSessionEpoch || !compatibilityFavorites.has(id)) return;
        compatibilityFavorites.set(id, { status: 'sending', message: 'Still waiting for favorite confirmation.' });
        renderDownloadCollections();
    }, 5000);
    apiFetch('/api/favorite/' + encodeURIComponent(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite }),
    }).then(async response => {
        if (epoch !== tagSessionEpoch) return;
        if ([403, 404].includes(response.status)) { tagMutations.fence(id); return; }
        if (!response.ok) throw new Error('Save not confirmed. Refresh to check the current favorite.');
        const body = await response.json();
        if (epoch !== tagSessionEpoch) return;
        if (String(body.id) !== id || typeof body.favorite !== 'boolean') throw new Error('Save not confirmed. Refresh to check the current favorite.');
        tagState.acceptDownload({ id, favorite: body.favorite, ...(typeof body.favorite_revision === 'string' && /^(0|[1-9]\d*)$/.test(body.favorite_revision) ? { favorite_revision: body.favorite_revision } : {}) });
    }).catch(error => {
        if (epoch === tagSessionEpoch && tagState.isAvailable(id)) favoriteNotices.set(id, error.message || 'Save not confirmed. Refresh to check the current favorite.');
    }).finally(() => {
        clearTimeout(timer);
        if (epoch !== tagSessionEpoch) return;
        compatibilityFavorites.delete(id);
        releaseSettledFavoriteInteractions();
        renderDownloadCollections();
    });
}

document.addEventListener('click', event => {
    const button = event.target.closest('[data-favorite-recovery]');
    if (!button) return;
    const id = button.dataset.intentId;
    const action = button.dataset.favoriteRecovery;
    if (action === 'check') tagMutations.recover(id);
    else if (action === 'recover') tagMutations.recover(id, { replay: true });
    else if (action === 'retry') tagMutations.retry(id);
    else if (!tagMutations.resolve(id)) announceTagStatus('The original favorite save may still complete. Check its status before using the current favorite.');
});
for (const eventName of ['focusout', 'pointerout']) document.addEventListener(eventName, event => {
    if (!event.target.closest?.('[data-favorite-control]')) return;
    queueMicrotask(() => {
        const before = favoriteEditPositions.size;
        releaseSettledFavoriteInteractions();
        if (before !== favoriteEditPositions.size) renderDownloadCollections();
    });
});


function hasVisibilityProtocol() {
    return tagCapabilities?.mutation_protocol === 1 && tagCapabilities.actions?.includes('visibility.set');
}
function visibilityIntent(id) {
    const intent = tagState.selectDownload(String(id))?.visibility_intents[0];
    return intent ? tagMutations.status(intent.id) || intent : compatibilityVisibility.get(String(id));
}
function visibilityFeedback(info) {
    const entry = visibilityIntent(info.id);
    const label = value => value === 'private' ? 'Private' : 'Public';
    if (!entry) return escapeHtml(visibilityNotices.get(String(info.id)) || '');
    const confirmed = label(info.visibility);
    const requested = label(entry.value);
    let message = `${confirmed} · Changing to ${entry.value}…`;
    if (entry.status === 'unconfirmed') message = `Visibility change not confirmed · Requested: ${requested} · Last confirmed: ${confirmed}. The current server visibility may differ.`;
    else if (entry.status === 'conflicted') message = `Visibility changed elsewhere · Current confirmed: ${confirmed} · Requested: ${requested}. Review current visibility before submitting again.`;
    else if (entry.status === 'rejected') message = `Visibility change refused · Last confirmed: ${confirmed} · Requested: ${requested}. ${entry.message || ''}`;
    else if (entry.delayed) message += ' Still waiting for confirmation.';
    const button = (action, text) => `<button type="button" data-visibility-recovery="${action}" data-intent-id="${escapeAttr(entry.id)}" data-download-id="${escapeAttr(info.id)}">${text}</button>`;
    let recovery = '';
    if (entry.status === 'unconfirmed') recovery = button('check', 'Check visibility change') + (!entry.legacy && !entry.replayExpired ? button('replay', 'Replay original request') : '') + (entry.canResolve ? button('dismiss', 'Use current visibility') : '');
    if (entry.status === 'conflicted') recovery = button('review', 'Review current visibility');
    if (entry.status === 'rejected') recovery = button('dismiss', 'Dismiss');
    return `<span>${escapeHtml(message)}</span>${recovery}`;
}
function renderVisibilityControl(info) {
    const id = String(info.id);
    const visibility = info.visibility === 'private' ? 'private' : 'public';
    const disabled = !info.can_manage_visibility || !!visibilityIntent(id);
    return `<div class="history-info-section history-visibility-section" data-visibility-control="${escapeAttr(id)}">
        <label class="history-info-label" for="visibility-${escapeAttr(id)}">Visibility</label>
        <select id="visibility-${escapeAttr(id)}" class="history-visibility-select" data-visibility-select data-download-id="${escapeAttr(id)}" data-current="${visibility}" onchange="changeDownloadVisibility(this)"${disabled ? ' disabled' : ''}>
            <option value="public"${visibility === 'public' ? ' selected' : ''}>Public</option>
            <option value="private"${visibility === 'private' ? ' selected' : ''}>Private</option>
        </select>
        <div class="history-visibility-help">${visibilityIntent(id)?.status === 'unconfirmed' ? 'Last confirmed access: ' : ''}${visibility === 'public' ? 'Visible to all users' : 'Visible only to you and administrators'}</div>
        <div class="visibility-feedback" data-visibility-feedback>${visibilityFeedback(info)}</div>
    </div>`;
}
function refreshVisibilityPresentations() {
    for (const section of document.querySelectorAll('[data-visibility-control]')) {
        const id = section.dataset.visibilityControl;
        const model = tagState.selectDownload(id);
        if (!model) { section.replaceChildren(); continue; }
        const select = section.querySelector('[data-visibility-select]');
        if (!select) continue;
        select.value = model.visibility;
        select.dataset.current = model.visibility;
        select.disabled = model.can_manage_visibility !== true || !!visibilityIntent(id) || removalBlocksWrites(id);
        section.querySelector('.history-visibility-help').textContent = (visibilityIntent(id)?.status === 'unconfirmed' ? 'Last confirmed access: ' : '') + (model.visibility === 'private' ? 'Visible only to you and administrators' : 'Visible to all users');
        const feedback = section.querySelector('[data-visibility-feedback]');
        const html = visibilityFeedback(model);
        if (feedback.innerHTML !== html) feedback.innerHTML = html;
    }
    const summary = document.getElementById('visibilityMutationSummary');
    if (summary) {
        const entries = tagMutations.pending().filter(intent => intent.kind === 'visibility.set').concat([...compatibilityVisibility.values()]);
        summary.hidden = !entries.length;
        const html = entries.map(entry => {
            const model = tagState.selectDownload(entry.targetId);
            return model ? `<div>${visibilityFeedback(model)}</div>` : '';
        }).join('');
        if (summary.innerHTML !== html) summary.innerHTML = html;
    }
}
function changeDownloadVisibility(select) {
    if (select.disabled) return;
    const id = String(select.dataset.downloadId);
    const model = tagState.selectDownload(id);
    const visibility = select.value;
    if (!model || model.can_manage_visibility !== true || removalBlocksWrites(id) || visibilityIntent(id)) return;
    select.value = model.visibility;
    visibilityNotices.delete(id);
    const startedAt = performance.now();
    if (hasVisibilityProtocol()) {
        const result = tagMutations.submit({ kind: 'visibility.set', targetId: id, value: visibility });
        if (result.intentId) submittedTagIntents.add(result.intentId);
        if (!result.accepted) { visibilityNotices.set(id, result.message); announceTagStatus(result.message); }
        refreshVisibilityPresentations();
        visibilityMutationMetrics.latestLocalFeedbackMs = performance.now() - startedAt;
        mutationMetrics.latestLocalFeedbackMs = visibilityMutationMetrics.latestLocalFeedbackMs;
        return;
    }
    if (visibility === model.visibility) return;
    const epoch = tagSessionEpoch;
    const context = tagState.capture();
    const entry = { id: `legacy-visibility-${id}`, targetId: id, kind: 'visibility.set', value: visibility, status: 'sending', legacy: true, timers: [] };
    compatibilityVisibility.set(id, entry);
    refreshVisibilityPresentations();
    visibilityMutationMetrics.latestLocalFeedbackMs = performance.now() - startedAt;
    announceTagStatus('Changing visibility…');
    const current = () => epoch === tagSessionEpoch && compatibilityVisibility.get(id) === entry && tagState.isAvailable(id);
    const unknown = () => { if (current()) { entry.status = 'unconfirmed'; refreshVisibilityPresentations(); announceTagStatus('Visibility change not confirmed.'); } };
    entry.timers.push(setTimeout(() => { if (current() && entry.status === 'sending') { entry.delayed = true; refreshVisibilityPresentations(); } }, 5000));
    entry.timers.push(setTimeout(unknown, 30000));
    apiFetch('/api/visibility/' + encodeURIComponent(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility }),
    }).then(async response => {
        if (!current()) return;
        if ([403, 404].includes(response.status)) { tagMutations.fence(id); return; }
        const body = await response.json().catch(() => null);
        if (!current()) return;
        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && typeof body?.error === 'string') {
                entry.status = 'rejected'; entry.message = body.error; refreshVisibilityPresentations(); announceTagStatus('Visibility change refused.');
            } else unknown();
            return;
        }
        if (body?.id !== id || body.visibility !== visibility || typeof body.changed !== 'boolean') { unknown(); return; }
        const snapshot = { id, visibility: body.visibility, can_manage_visibility: body.can_manage_visibility, can_delete: body.can_delete,
            ...(body.permissions ? { permissions: body.permissions } : {}),
            ...(VDL.validVisibilityState(body) ? { visibility_revision: body.visibility_revision } : {}) };
        const confirmed = tagState.writer.confirmed(id);
        const accepted = typeof confirmed.visibility_revision === 'string'
            ? VDL.validVisibilityState(body) && tagState.acceptDownload(snapshot, context)
            : tagState.writer.acceptLegacyVisibility(body, context);
        if (!accepted) { unknown(); return; }
        compatibilityVisibility.delete(id);
        visibilityNotices.set(id, 'Visibility change confirmed.');
        refreshVisibilityPresentations(); renderDownloadCollections(); fetchLibraryStorage(); announceTagStatus('Visibility change confirmed.');
    }).catch(unknown).finally(() => entry.timers.forEach(clearTimeout));
}
document.addEventListener('click', async event => {
    const button = event.target.closest('[data-visibility-recovery]');
    if (!button) return;
    const id = button.dataset.downloadId;
    const intentId = button.dataset.intentId;
    const action = button.dataset.visibilityRecovery;
    const entry = compatibilityVisibility.get(id);
    if (entry) {
        if (action === 'check') await checkTagAvailability(id);
        else if (entry.status === 'rejected') compatibilityVisibility.delete(id);
    } else if (action === 'check') await tagMutations.recover(intentId);
    else if (action === 'replay') await tagMutations.recover(intentId, { replay: true });
    else if (action === 'review') {
        // A conflict keeps the canonical state readable until explicit review.
        if (tagMutations.status(intentId)?.status === 'conflicted') {
            tagMutations.resolve(intentId);
            announceTagStatus('Current visibility reviewed. Choose the desired visibility to submit a new request.');
        }
    } else tagMutations.resolve(intentId);
    refreshVisibilityPresentations();
});

function mutationDiagnosticIntents() {
    return tagMutations.pending().concat([...compatibilityVisibility.values()], [...compatibilityRemovals.values()], uploadDiagnosticIntents(),
        downloadSubmission?.legacy ? [{ ...downloadSubmission.legacy, kind: 'download.submit' }] : [],
        preferenceSubmission?.legacy ? [{ ...preferenceSubmission.legacy, kind: 'preference.set' }] : [],
        [...playlistSubmissions.values()].filter(entry => entry.legacy).map(entry => ({ ...entry.legacy, kind: entry.kind })),
        [...playlistActions.values()].filter(entry => entry.legacy).map(entry => entry.legacy),
        [...bulkClears.values()].filter(entry => entry.legacy && entry.status !== 'confirmed').map(entry => ({ ...entry, kind: `${entry.scope}.clear` })));
}
function bulkClearEntry(record) {
    return (record.intentId && tagMutations.status(record.intentId)) || record;
}
function bulkClearPending(scope) {
    const record = bulkClears.get(scope);
    return !!record && ['queued', 'sending', 'unconfirmed', 'conflicted'].includes(bulkClearEntry(record).status);
}
function bulkLibraryRetainedPositions() {
    const record = bulkClears.get('library');
    return bulkClearPending('library') ? new Map([...record.positions].filter(([id]) => !record.appliedIds.has(id) && tagState.isAvailable(id))) : new Map();
}
function bulkClearText(record) {
    const entry = bulkClearEntry(record);
    return entry.message || (entry.status === 'preview' ? 'Checking clear preview…' : `Clearing ${record.scope}…`);
}
function refreshBulkClearPresentations() {
    const summary = document.getElementById('bulk-clear-summary');
    if (!summary) return;
    const html = [...bulkClears.values()].map(record => {
        const entry = bulkClearEntry(record);
        const action = (name, label) => `<button type="button" data-bulk-clear-action="${name}" data-bulk-clear-scope="${record.scope}">${label}</button>`;
        const controls = entry.status === 'unconfirmed'
            ? entry.legacy ? action('check', 'Check current state')
                : action('check', 'Check clear') + (!entry.replayExpired ? action('replay', 'Recover original clear') : '') + (entry.canResolve ? action('resolve', 'Use current state') : '')
            : ['conflicted', 'rejected', 'confirmed'].includes(entry.status) ? (entry.status === 'confirmed' && record.scope === 'history' ? action('refresh', 'Refresh remaining attempts') : '') + action('resolve', entry.status === 'confirmed' ? 'Dismiss result' : 'Review a new preview') : '';
        const message = bulkClearText(record);
        if (record.announced !== message) { record.announced = message; announceTagStatus(message); }
        return `<div class="download-command-message" data-bulk-clear-status="${record.scope}" data-bulk-clear-state="${escapeAttr(entry.status)}">${['queued', 'sending'].includes(entry.status) && !entry.delayed ? '<span class="options-spinner" aria-hidden="true"></span>' : ''}<span>${escapeHtml(message)}</span>${controls}</div>`;
    }).join('');
    if (summary.innerHTML !== html) summary.innerHTML = html;
    summary.hidden = !bulkClears.size;
    for (const button of document.querySelectorAll('[data-bulk-clear]')) {
        const record = bulkClears.get(button.dataset.bulkClear);
        button.disabled = !!record && !['confirmed', 'rejected'].includes(bulkClearEntry(record).status);
    }
    for (const [scope, id] of [['library', 'historyList'], ['history', 'attemptHistoryList']]) {
        document.getElementById(id)?.setAttribute('aria-busy', String(bulkClearPending(scope)));
    }
    const entries = [...bulkClears.values()].map(bulkClearEntry);
    for (const [field, statuses] of [['pending', ['queued', 'sending', 'unconfirmed', 'conflicted']], ['unconfirmed', ['unconfirmed']], ['conflicted', ['conflicted']]]) bulkClearMetrics[field] = entries.filter(entry => statuses.includes(entry.status)).length;
    const aggregate = mutationDiagnosticIntents();
    for (const [field, statuses] of [['pending', ['queued', 'sending', 'unconfirmed', 'conflicted']], ['unconfirmed', ['unconfirmed']], ['conflicted', ['conflicted']]]) mutationMetrics[field] = aggregate.filter(entry => statuses.includes(entry.status)).length;
    refreshRemovalPresentations();
}
function applyBulkClearResult(record, result) {
    const added = result.removed_ids.filter(id => !record.appliedIds.has(id));
    if (record.scope === 'library') {
        tagState.writer.transaction(() => {
            for (const id of added) {
                record.appliedIds.add(id);
                tagMutations.fence(id, true);
                finishRemovalPresentation(id, { announce: false, render: false });
            }
        });
        if (added.length) { renderDownloadCollections(); renderUploadRecovery(); }
    } else if (added.length) {
        ++attemptRequest;
        let restoreFocus = false;
        for (const id of added) {
            record.appliedIds.add(id);
            bulkRemovedAttemptIds.add(id);
            const node = document.getElementById(`attempt-${id}`);
            restoreFocus ||= !!node?.contains(document.activeElement);
            node?.remove();
            attemptRows.delete(id);
        }
        if (restoreFocus) document.getElementById('attemptHistoryTitle').focus({ preventScroll: true });
        document.getElementById('attemptHistoryStatus').textContent = `${result.removed} terminal attempt records removed. Refresh History to update remaining page totals.`;
        document.getElementById('attemptPageInfo').textContent = `Page ${attemptPage} · totals need refresh after clear`;
    }
}
function handleBulkClearEvent(event) {
    const entry = tagMutations.status(event.intentId);
    const scope = event.action.split('.')[0];
    const record = bulkClears.get(scope);
    if (event.outcome === 'reconciliation') bulkClearMetrics.reconciliationReads++;
    if (record && entry?.bulkResult && ['accepted', 'confirmed'].includes(event.outcome)) {
        applyBulkClearResult(record, entry.bulkResult);
        if (event.outcome === 'confirmed') {
            const result = entry.bulkResult;
            record.status = 'confirmed';
            record.message = `${scope === 'history' ? 'History' : 'Library'} clear complete: ${result.removed} ${scope === 'history' ? 'attempts' : 'items'} removed, ${result.files_deleted} files deleted, ${result.retained} retained, ${result.failed} failed.`;
            record.intentId = null;
            record.rows.clear(); record.positions.clear(); record.appliedIds.clear();
            record.timers.forEach(clearTimeout);
        }
    }
    refreshBulkClearPresentations();
}
async function beginBulkClear(scope) {
    const previous = bulkClears.get(scope);
    if (previous && !['confirmed', 'rejected'].includes(bulkClearEntry(previous).status)) { refreshBulkClearPresentations(); return; }
    if (previous?.intentId) tagMutations.resolve(previous.intentId);
    const epoch = tagSessionEpoch;
    const record = { scope, status: 'preview', message: '', positions: new Map(), rows: new Map(), appliedIds: new Set(), timers: [] };
    bulkClears.set(scope, record);
    refreshBulkClearPresentations();
    const current = () => epoch === tagSessionEpoch && bulkClears.get(scope) === record;
    const route = scope === 'history' ? '/api/clear' : '/api/library/clear';
    const protocol = tagCapabilities?.mutation_protocol === 1 && tagCapabilities.bulk_clear === 1 && tagCapabilities.actions?.includes(`${scope}.clear`);
    try {
        const response = await apiFetch(`${route}/preview${protocol ? '?include_scope=true' : ''}`);
        const preview = await response.json();
        if (!current()) return;
        if (!response.ok) throw new Error(typeof preview?.error === 'string' ? preview.error : 'Could not prepare the clear preview.');
        if (!Number.isSafeInteger(preview.entries) || preview.entries < 0 || !Number.isSafeInteger(preview.with_files) || preview.with_files < 0) throw new Error('Could not verify the clear preview.');
        if (!preview.entries) { bulkClears.delete(scope); refreshBulkClearPresentations(); announceTagStatus(`No eligible ${scope === 'history' ? 'attempt records' : 'Library items'} to clear.`); return; }
        if (protocol && (typeof preview.scope_id !== 'string' || !preview.scope_id || preview.revision !== '0')) throw new Error('Could not bind the clear preview safely.');
        const prompt = scope === 'history' ? `Delete ${preview.entries} terminal attempt records? Library videos and files will be kept.` : `Delete ${preview.entries} Library items and ${preview.with_files} files from disk? Attempt records will be kept.`;
        if (!confirm(prompt)) { if (current()) { bulkClears.delete(scope); refreshBulkClearPresentations(); } return; }
        if (!current()) return;
        const started = performance.now();
        record.status = 'sending'; record.message = `Clearing ${scope}…`;
        if (scope === 'library') record.positions = new Map(historyPageItems.map((info, index) => [String(info.id), index]));
        else { record.rows = new Map(attemptRows); record.page = attemptPage; record.filter = document.getElementById('attemptSearchInput').value; }
        refreshBulkClearPresentations();
        if (protocol) {
            tagState.acceptBulkPreview(scope, preview);
            const submitted = tagMutations.submit({ kind: `${scope}.clear`, targetId: `bulk:${scope}`, value: { scope_id: preview.scope_id, revision: preview.revision, entries: preview.entries } });
            if (!submitted.accepted) { record.status = 'rejected'; record.message = submitted.message || 'Clear request could not be submitted.'; }
            else record.intentId = submitted.intentId;
        } else {
            record.legacy = true;
            for (const metrics of [bulkClearMetrics, mutationMetrics]) metrics.submissions++;
            const unknown = () => { if (!current()) return; if (record.status !== 'unconfirmed') for (const metrics of [bulkClearMetrics, mutationMetrics]) metrics.unconfirmedOutcomes++; record.status = 'unconfirmed'; record.message = 'Clear request not confirmed. This server cannot safely recover or replay it. Check current state without repeating the clear.'; refreshBulkClearPresentations(); };
            record.timers.push(setTimeout(() => { if (current() && record.status === 'sending') { record.delayed = true; record.message = `Still waiting for ${scope} clear confirmation.`; refreshBulkClearPresentations(); } }, 5000), setTimeout(unknown, 30000));
            apiFetch(route, { method: 'POST' }).then(async response => {
                const result = await response.json().catch(() => null);
                if (!current()) return;
                record.timers.forEach(clearTimeout);
                if (response.ok && Number.isSafeInteger(result?.removed) && result.removed >= 0 && Number.isSafeInteger(result.files_deleted) && result.files_deleted >= 0) {
                    record.status = 'confirmed'; record.message = `${scope === 'history' ? 'History' : 'Library'} clear confirmed: ${result.removed} removed, ${result.files_deleted} files deleted.`;
                    for (const metrics of [bulkClearMetrics, mutationMetrics]) { metrics.acknowledgements++; metrics.latestAcknowledgementMs = performance.now() - started; }
                    if (scope === 'library') fetchHistory();
                    fetchAttemptHistory();
                } else if ([400, 403, 404, 409, 413, 422, 429].includes(response.status) && typeof result?.error === 'string') { record.status = 'rejected'; record.message = `Clear request refused. ${result.error}`; for (const metrics of [bulkClearMetrics, mutationMetrics]) metrics.rejectedOutcomes++; }
                else unknown();
                refreshBulkClearPresentations();
            }).catch(unknown);
        }
        refreshBulkClearPresentations();
        bulkClearMetrics.latestLocalFeedbackMs = Math.max(0, performance.now() - started);
        mutationMetrics.latestLocalFeedbackMs = bulkClearMetrics.latestLocalFeedbackMs;
    } catch (error) {
        if (!current()) return;
        record.status = 'rejected'; record.message = typeof error.message === 'string' ? error.message : 'Could not prepare the clear preview.';
        refreshBulkClearPresentations();
    }
}
function clearHistory() { return beginBulkClear('history'); }
function clearLibrary() { return beginBulkClear('library'); }
document.addEventListener('click', event => {
    const control = event.target.closest('[data-bulk-clear-action]');
    if (!control) return;
    const record = bulkClears.get(control.dataset.bulkClearScope);
    if (!record) return;
    const action = control.dataset.bulkClearAction;
    if (action === 'refresh') { bulkClearMetrics.reconciliationReads++; mutationMetrics.reconciliationReads++; fetchAttemptHistory(); }
    else if (record.intentId && action !== 'resolve') tagMutations.recover(record.intentId, { replay: action === 'replay' });
    else if (action === 'resolve' && (!record.intentId || tagMutations.resolve(record.intentId))) {
        record.timers.forEach(clearTimeout);
        bulkClears.delete(record.scope);
        const current = record.currentSnapshot;
        if (current) {
            if (record.scope === 'history') { ++attemptRequest; renderAttemptHistorySnapshot(JSON.parse(JSON.stringify(current)), record.currentReadView.filter); }
            else {
                invalidateLibraryOrder();
                acceptingTagSnapshots = true;
                try { for (const info of current.catalog || current.items) tagState.acceptDownload(info); }
                finally { acceptingTagSnapshots = false; }
                collectionSnapshots.library = JSON.parse(JSON.stringify(current.items));
                allLibraryEntries = JSON.parse(JSON.stringify(current.catalog || current.items));
                libraryOrder = JSON.parse(JSON.stringify(current.order));
                libraryLoaded = true;
                renderLibraryRotationStatus();
            }
        }
        renderDownloadCollections();
    }
    else if (record.legacy && action === 'check') { bulkClearMetrics.reconciliationReads++; mutationMetrics.reconciliationReads++; if (record.scope === 'library') fetchHistory(); fetchAttemptHistory(); }
    refreshBulkClearPresentations();
});

let openMenuId = null;
let openInfoId = null;
let historyFetchDeferred = false;
let historyFavoriteSortDeferred = false;
const heldRowActionPointers = new Set();

function historyRefreshBlocked() {
    return openMenuId !== null || heldRowActionPointers.size > 0;
}

function resumeDeferredHistoryFetch() {
    if (historyRefreshBlocked() || !historyFetchDeferred) return;
    historyFetchDeferred = false;
    const sortFavorites = historyFavoriteSortDeferred;
    historyFavoriteSortDeferred = false;
    // requestAnimationFrame runs after the click synthesized for pointerup, so
    // the pressed action can finish before reconciliation replaces its row.
    scheduleFetch({ sortFavorites });
}

document.addEventListener('pointerdown', (ev) => {
    const target = ev.target.closest && ev.target.closest(
        '#activeList .row-actions button, #historyList .row-actions button');
    if (target) heldRowActionPointers.add(ev.pointerId);
}, true);

function releaseRowActionPointer(ev) {
    if (!heldRowActionPointers.delete(ev.pointerId)) return;
    resumeDeferredHistoryFetch();
}

document.addEventListener('pointerup', releaseRowActionPointer, true);
document.addEventListener('focusout', event => {
    if (event.target.closest?.('.tag-editor-shell')) setTimeout(resumeDeferredHistoryFetch, 0);
});
document.addEventListener('pointercancel', releaseRowActionPointer, true);
window.addEventListener('blur', () => {
    if (heldRowActionPointers.size === 0) return;
    heldRowActionPointers.clear();
    resumeDeferredHistoryFetch();
});

function parseFormats(info) {
    let formats = info.formats;
    if (!formats) return [];
    if (typeof formats === 'string') {
        try { formats = JSON.parse(formats); } catch (e) { return []; }
    }
    return Array.isArray(formats) ? formats : [];
}

function describeFormat(format) {
    const parts = [];
    const height = Number(format.height);
    const resolution = Number.isFinite(height) && height > 0
        ? `${height}p`
        : String(format.resolution || '').toLowerCase() === 'audio only'
            ? ''
            : format.resolution;
    if (resolution) parts.push(String(resolution));

    const fps = Number(format.fps);
    if (Number.isFinite(fps) && fps > 0) parts.push(`${fps}fps`);
    if (format.ext) parts.push(String(format.ext).toUpperCase());

    const hasVideo = Boolean(format.vcodec && format.vcodec !== 'none');
    const hasAudio = Boolean(format.acodec && format.acodec !== 'none');
    if (hasVideo && hasAudio) parts.push('video + audio');
    else if (hasVideo) parts.push('video');
    else if (hasAudio) parts.push('audio');

    if (parts.length) return parts.join(' ');
    if (!format.format) return null;
    const raw = String(format.format);
    const prefix = format.format_id ? `${format.format_id} - ` : '';
    return prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function formatRequestedFormat(info) {
    if (!info.requested_format) return null;
    const requested = String(info.requested_format).trim();
    if (!requested) return null;

    const friendlySelectors = {
        best: 'Best available',
        'bestaudio/best': 'Best available audio',
        'bestvideo+bestaudio/best': 'Best available video + audio',
    };
    if (friendlySelectors[requested]) return friendlySelectors[requested];

    const heightSelector = requested.match(/^bestvideo\[height<=(\d+)\]\+bestaudio\/best$/);
    if (heightSelector) return `Up to ${heightSelector[1]}p video + audio`;

    const formats = parseFormats(info);
    const requestedIds = requested.split('+');
    const matches = requestedIds.map(formatId =>
        formats.find(format => format && String(format.format_id) === formatId)
    );
    if (matches.length && matches.every(Boolean)) {
        const descriptions = matches.map(describeFormat);
        if (descriptions.every(Boolean)) return descriptions.join(' + ');
    }

    return /^\d+$/.test(requested) ? `Format ${requested}` : requested;
}

function renderFormatsTable(info) {
    const formats = parseFormats(info);
    if (formats.length === 0) return '';

    const fmtSize = (n) => {
        if (!n || isNaN(n)) return '';
        const u = ['B','KB','MB','GB','TB']; let i = 0; let v = Number(n);
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
    };
    const cells = (f) => {
        const av = [];
        if (f.vcodec && f.vcodec !== 'none') av.push('video');
        if (f.acodec && f.acodec !== 'none') av.push('audio');
        const kind = av.join('+') || '—';
        const res = f.resolution || (f.height ? f.height + 'p' : '') || '';
        const fps = f.fps ? f.fps + 'fps' : '';
        const note = f.format_note || '';
        return [
            f.format_id || '',
            f.ext || '',
            kind,
            [res, fps].filter(Boolean).join(' '),
            fmtSize(f.filesize),
            note,
        ];
    };
    const head = ['ID','Ext','Kind','Resolution','Size','Note'];
    const rows = formats.map(cells);
    const th = head.map(h => `<th>${escapeHtml(h)}</th>`).join('');
    const tr = rows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(String(c))}</td>`).join('')}</tr>`).join('');
    return `
                <div class="formats-block">
                    <div class="formats-title">Available formats (${formats.length})</div>
                    <div class="formats-scroll">
                        <table class="formats-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>
                    </div>
                </div>`;
}

const openErrorIds = new Set();
function onErrorDetailsToggle(id, el) {
    if (el.open) openErrorIds.add(id);
    else openErrorIds.delete(id);
}

function closeAllMenus() {
    const hadOpenMenu = openMenuId !== null;
    document.querySelectorAll('.kebab-menu.open').forEach(m => m.classList.remove('open'));
    openMenuId = null;
    closeAccountMenu();
    closePlaybackModeMenu();
    if (hadOpenMenu) {
        // Schedule after the click finishes so switching directly to another
        // menu keeps its actions stable and defers the refresh again.
        resumeDeferredHistoryFetch();
    }
}

function closeHistoryInfo() {
    if (openInfoId === null) return;
    document.querySelectorAll('.history-info-popover.open').forEach(popover => {
        popover.classList.remove('open');
    });
    document.querySelectorAll('[data-info-action]').forEach(button => {
        button.setAttribute('aria-expanded', 'false');
    });
    const draft = renameDrafts.get(String(openInfoId));
    if (draft) draft.viewToken = ++renameViewSequence;
    openInfoId = null;
}

function positionHistoryInfo(id) {
    const card = document.querySelector(`#historyList [data-row-id="${CSS.escape(String(id))}"]`);
    const button = card && card.querySelector('[data-info-action]');
    const anchor = card && card.querySelector('.kebab-btn');
    const popover = card && card.querySelector('.history-info-popover');
    if (!button || !anchor || !popover) {
        openInfoId = null;
        return;
    }

    const viewportGap = 12;
    const anchorGap = 8;
    const appHeader = document.getElementById('appHeader');
    const headerBottom = appHeader ? appHeader.getBoundingClientRect().bottom : 0;
    const viewportTop = Math.max(viewportGap, headerBottom + viewportGap);
    const width = Math.min(560, window.innerWidth - viewportGap * 2);
    popover.style.width = `${width}px`;
    popover.style.setProperty(
        '--history-info-max-height',
        `${Math.max(80, window.innerHeight - viewportTop - viewportGap)}px`,
    );
    popover.style.visibility = 'hidden';
    popover.classList.add('open');

    const buttonRect = anchor.getBoundingClientRect();
    const left = Math.min(
        window.innerWidth - width - viewportGap,
        Math.max(viewportGap, buttonRect.right - width),
    );
    const availableBelow = Math.max(0, window.innerHeight - viewportGap
        - buttonRect.bottom - anchorGap);
    const availableAbove = Math.max(0, buttonRect.top - anchorGap - viewportTop);
    const naturalHeight = popover.getBoundingClientRect().height;
    let placement = naturalHeight <= availableBelow || availableBelow >= availableAbove
        ? 'below'
        : 'above';
    const availableHeight = placement === 'below' ? availableBelow : availableAbove;
    popover.style.setProperty(
        '--history-info-max-height',
        `${Math.max(80, availableHeight)}px`,
    );
    const popoverHeight = popover.getBoundingClientRect().height;
    const top = placement === 'below'
        ? buttonRect.bottom + anchorGap
        : buttonRect.top - popoverHeight - anchorGap;
    const pointerX = Math.min(width - 16, Math.max(16, buttonRect.left + buttonRect.width / 2 - left));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.setProperty('--popover-pointer-x', `${pointerX}px`);
    popover.dataset.placement = placement;
    popover.style.visibility = '';
    button.setAttribute('aria-expanded', 'true');
}

function toggleHistoryInfo(id, ev) {
    ev.stopPropagation();
    const wasOpen = openInfoId === String(id);
    closeAllMenus();
    closeHistoryInfo();
    if (wasOpen) return;
    openInfoId = String(id);
    positionHistoryInfo(openInfoId);
}

function restoreOpenHistoryInfo() {
    if (openInfoId !== null) positionHistoryInfo(openInfoId);
}

function toggleMenu(id, ev) {
    ev.stopPropagation();
    const menu = document.getElementById('menu-' + id);
    if (!menu) return;
    const wasOpen = menu.classList.contains('open');
    closeHistoryInfo();
    closeAllMenus();
    if (!wasOpen) {
        menu.classList.add('open');
        openMenuId = id;
    }
}

const HOVER_PREVIEW_DELAY_MS = 250;
const HOVER_PREVIEW_CACHE_VERSION = 5;
let hoverPreviewTimer = null;
let pendingHoverPreview = null;
let activeHoverPreview = null;

function hoverPreviewsEnabled() {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function stopHoverPreview(preview = activeHoverPreview || pendingHoverPreview || intentionalHoverPreview) {
    if (!preview) return;
    if (preview._assetLeaseTimer) {
        clearInterval(preview._assetLeaseTimer);
        preview._assetLeaseTimer = null;
    }
    if (intentionalHoverPreview === preview) {
        intentionalHoverPreview = null;
        scheduleAssetDemand({ reconcile: true });
    }
    if (pendingHoverPreview === preview) {
        clearTimeout(hoverPreviewTimer);
        hoverPreviewTimer = null;
        pendingHoverPreview = null;
    }

    const video = preview.querySelector('.history-preview-video');
    preview.classList.remove('preview-loading', 'preview-playing');
    if (video) {
        video.onplaying = null;
        video.onerror = null;
        video.pause();
        video.removeAttribute('src');
        video.load();
    }
    if (activeHoverPreview === preview) activeHoverPreview = null;
}

function startHoverPreview(preview, interaction = true) {
    hoverPreviewTimer = null;
    pendingHoverPreview = null;
    const hoverRegion = preview.closest('.history-preview-wrap') || preview;
    if (!preview.isConnected || !hoverRegion.matches(':hover') || !hoverPreviewsEnabled()) return;

    if (activeHoverPreview && activeHoverPreview !== preview) {
        stopHoverPreview(activeHoverPreview);
    }
    intentionalHoverPreview = preview;
    const delivery = montageDelivery(preview.dataset.downloadId);
    if (delivery.url && preview._failedMontageUrl === delivery.url) return;
    scheduleAssetDemand({ reconcile: true, interaction });
    if (!delivery.available || !delivery.url) return;
    const video = preview.querySelector('.history-preview-video');
    if (!video || activeHoverPreview === preview) return;

    activeHoverPreview = preview;
    const hoverSession = {};
    preview._hoverSession = hoverSession;
    preview.classList.add('preview-loading');
    video.muted = true;
    video.onplaying = () => {
        if (activeHoverPreview !== preview) return;
        preview.classList.remove('preview-loading');
        preview.classList.add('preview-playing');
    };
    video.onerror = () => recoverHoverPreview(preview, delivery.url, hoverSession);
    // A server-issued identity stays pinned until this hover ends, including
    // any later byte-range requests after a replacement is published.
    video.src = delivery.url;
    if (delivery.identity) {
        const leaseTimer = setInterval(async () => {
            if (activeHoverPreview !== preview || intentionalHoverPreview !== preview || preview._hoverSession !== hoverSession) return;
            try {
                const response = await apiFetch('/api/preview/' + encodeURIComponent(preview.dataset.downloadId) + '/lease', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ asset: delivery.identity }),
                });
                if (response.ok) return;
            } catch (_error) { /* Abandoned sessions expire through the bounded reader lease. */ }
            clearInterval(leaseTimer);
            if (preview._assetLeaseTimer === leaseTimer) preview._assetLeaseTimer = null;
        }, 30000);
        preview._assetLeaseTimer = leaseTimer;
    }
    video.load();
    const playback = video.play();
    if (playback) {
        playback.catch(() => recoverHoverPreview(preview, delivery.url, hoverSession));
    }
}

function recoverHoverPreview(preview, failedUrl, hoverSession) {
    if (activeHoverPreview !== preview || preview._hoverSession !== hoverSession) return;
    stopHoverPreview(preview);
    const hoverRegion = preview.closest('.history-preview-wrap') || preview;
    if (!preview.isConnected || !hoverRegion.matches(':hover') || !hoverPreviewsEnabled()) return;
    // A card may retain an identity beyond its retirement grace. Reconcile
    // once and retry only a replacement, preserving the intentional hover.
    preview._failedMontageUrl = failedUrl;
    intentionalHoverPreview = preview;
    scheduleAssetDemand({ reconcile: true, interaction: false });
}

function scheduleHoverPreview(preview) {
    if (!hoverPreviewsEnabled() || !hasVideoAssets(collectionSnapshots.library.find(info => String(info.id) === preview.dataset.downloadId))) return;
    if (pendingHoverPreview && pendingHoverPreview !== preview) {
        stopHoverPreview(pendingHoverPreview);
    }
    if (activeHoverPreview === preview || pendingHoverPreview === preview || intentionalHoverPreview === preview) return;
    delete preview._failedMontageUrl;
    pendingHoverPreview = preview;
    hoverPreviewTimer = setTimeout(
        () => startHoverPreview(preview),
        HOVER_PREVIEW_DELAY_MS,
    );
}

document.addEventListener('pointerover', (ev) => {
    const preview = ev.target.closest
        ? ev.target.closest('button.history-preview[data-play-action]')
        : null;
    if (!preview || (ev.relatedTarget && preview.contains(ev.relatedTarget))) return;
    scheduleHoverPreview(preview);
});

document.addEventListener('pointerout', (ev) => {
    const hoverRegion = ev.target.closest
        ? ev.target.closest('.history-preview-wrap')
        : null;
    const preview = hoverRegion
        ? hoverRegion.querySelector('button.history-preview[data-play-action]')
        : null;
    // The favorite control overlays the preview as a sibling, so the wrapper
    // is the stable hover boundary even while the pointer is over that control.
    if (!preview || (ev.relatedTarget && hoverRegion.contains(ev.relatedTarget))) return;
    stopHoverPreview(preview);
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopHoverPreview();
});

document.addEventListener('click', (ev) => {
    const favoriteAction = ev.target.closest('[data-favorite-action]');
    if (favoriteAction) toggleFavorite(favoriteAction);

    const playlistAddAction = ev.target.closest('[data-playlist-add-action]');
    if (playlistAddAction) {
        openPlaylistChooser(
            playlistAddAction.dataset.downloadId, playlistAddAction,
        );
    }

    const endlessAction = ev.target.closest('[data-endless-action]');
    if (endlessAction) {
        closeAllMenus();
        startEndlessPlayback(
            endlessAction.dataset.downloadId,
            endlessAction.dataset.playLabel,
            endlessAction.dataset.playExt,
        );
    }

    const playAction = ev.target.closest('[data-play-action]');
    if (playAction) {
        stopHoverPreview();
        recordView(playAction.dataset.downloadId);
        playVideo(
            playAction.dataset.downloadId,
            playAction.dataset.playLabel,
            playAction.dataset.playExt,
        );
    }
    const fileDownloadAction = ev.target.closest('[data-file-download-action]');
    if (fileDownloadAction) {
        closeAllMenus();
        const link = document.createElement('a');
        link.href = '/api/file/'
            + encodeURIComponent(fileDownloadAction.dataset.downloadId)
            + '?download=1';
        link.download = '';
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }
    const urlAction = ev.target.closest('[data-url-action]');
    if (urlAction) {
        const url = urlAction.dataset.url;
        const id = urlAction.dataset.downloadId;
        switch (urlAction.dataset.urlAction) {
            case 'open':
                openUrl(url);
                break;
            case 'continue':
                continueDownload(id, url, Object.hasOwn(urlAction.dataset, 'commandAttempt') ? urlAction.dataset.commandAttempt || null : undefined);
                break;
            case 'reload':
                reloadDownload(id, url, Object.hasOwn(urlAction.dataset, 'commandAttempt') ? urlAction.dataset.commandAttempt || null : undefined);
                break;
            case 'copy':
                copyToClipboard(url, urlAction);
                break;
        }
    }
    // Local editor transitions may replace the clicked button synchronously.
    // The event path retains its original surface after that node detaches.
    const originalPath = ev.composedPath();
    if (originalPath.some(node => node instanceof Element && node.matches('.history-info-popover'))) return;
    if (originalPath.some(node => node instanceof Element && node.matches('.kebab-menu, .kebab-btn'))) return;
    closeHistoryInfo();
    closeAllMenus();
});

function formatDateTime(epochSeconds) {
    if (epochSeconds == null || isNaN(epochSeconds)) return null;
    const d = new Date(Number(epochSeconds) * 1000);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    });
}

function formatDuration(startEpochSeconds, endEpochSeconds) {
    const start = Number(startEpochSeconds);
    const end = Number(endEpochSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

    let remaining = Math.round(end - start);
    const units = [
        ['Day', 86400],
        ['Hour', 3600],
        ['Minute', 60],
        ['Second', 1],
    ];
    const parts = [];
    for (const [label, seconds] of units) {
        const value = Math.floor(remaining / seconds);
        if (value <= 0) continue;
        parts.push(`${value} ${label}${value === 1 ? '' : 's'}`);
        remaining %= seconds;
        if (parts.length === 2) break;
    }
    return parts.length ? parts.join(' and ') : '0 Seconds';
}

function formatMediaDuration(durationSeconds) {
    const seconds = Math.round(Number(durationSeconds));
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    const minuteText = hours ? String(minutes).padStart(2, '0') : String(minutes);
    return `${hours ? `${hours}:` : ''}${minuteText}:${String(remainder).padStart(2, '0')}`;
}

function formatBytes(n) {
    if (n == null || isNaN(n)) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

function displayFilename(info) {
    const name = info.requested_filename || info.display_filename || info.filename || '';
    return String(name).split('/').pop().split('\\').pop();
}

function formatSpeed(bps) {
    const s = formatBytes(bps);
    return s ? s + '/s' : null;
}

function formatEta(seconds) {
    if (seconds == null || isNaN(seconds) || seconds < 0) return null;
    const s = Math.round(Number(seconds));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return m + 'm ' + rem + 's';
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h + 'h ' + mm + 'm ' + rem + 's';
}

function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function openUrl(url) {
    closeAllMenus();
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
        window.open(parsed.href, '_blank', 'noopener,noreferrer');
    } catch (e) {
        // Invalid or relative download URLs have nowhere safe to open.
    }
}

const COPIED_HTML = '<svg class="menu-icon"><use href="#i-check"/></svg>Copied';

function copyToClipboard(text, btn) {
    const done = () => {
        if (!btn) return;
        if (btn._copyTimer) clearTimeout(btn._copyTimer);
        if (btn._copyOriginalHtml === undefined) {
            btn._copyOriginalHtml = btn.innerHTML;
            btn._copyOriginalLabel = btn.getAttribute('aria-label');
            btn._copyOriginalTitle = btn.getAttribute('title');
        }
        btn.innerHTML = COPIED_HTML;
        btn.setAttribute('aria-label', 'Copied');
        btn.setAttribute('title', 'Copied');
        btn._copyTimer = setTimeout(() => {
            btn.innerHTML = btn._copyOriginalHtml;
            if (btn._copyOriginalLabel === null) btn.removeAttribute('aria-label');
            else btn.setAttribute('aria-label', btn._copyOriginalLabel);
            if (btn._copyOriginalTitle === null) btn.removeAttribute('title');
            else btn.setAttribute('title', btn._copyOriginalTitle);
            delete btn._copyOriginalHtml;
            delete btn._copyOriginalLabel;
            delete btn._copyOriginalTitle;
            btn._copyTimer = null;
        }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
    } else {
        fallback(text, done);
    }
}

function fallback(text, done) {
    const previousFocus = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    // A modal makes the rest of the page inert, including a textarea in body.
    (document.querySelector('dialog:modal') || document.body).appendChild(ta);
    let copied = false;
    try {
        ta.focus();
        ta.select();
        copied = document.execCommand('copy');
    } catch (e) {
        // Browsers can either return false or throw when copying is blocked.
    } finally {
        ta.remove();
        if (previousFocus) previousFocus.focus({ preventScroll: true });
    }
    if (copied) done();
    else showActionError('Could not copy the URL. Please try again.');
}

const PLAYLIST_VIDEO_EXTENSIONS = new Set([
    'mp4', 'm4v', 'webm', 'mkv', 'ogg', 'ogv', 'mov', 'avi',
]);
let playlistSummaries = [];
let visiblePlaylistCount = 0;
let libraryEntries = [];
let playlistEditorDraft = null;
let playlistEditorBaseline = '';
let playlistEditorReturnFocus = null;
let playlistEditorViewToken = 0;
let playlistLocalSequence = 0;
let playlistCollectionGeneration = 0;
let playlistSaveMessage = '';
let playlistReviewVisible = false;
const playlistSubmissions = new Map();
const playlistRetainedDrafts = new Map();
const playlistDeletedIds = new Set();
const playlistActions = new Map();
let playlistActionDialogId = null;
let playlistActionReturnFocus = null;
let playlistChooserDownloadId = null;
let playlistChooserReturnFocus = null;

function libraryTitle(info) {
    if (info && info.title) return info.title;
    if (info && info.filename) {
        return displayFilename(info).replace(/\.[^.]+$/, '');
    }
    return 'Untitled download';
}

function playlistMatchesSearch(playlist) {
    const playlistValues = searchPlaylistValues();
    if (playlistValues.length && !playlistValues.includes('yes')) return false;
    const videoTerms = searchTerms.filter(term => !/^playlists?:/i.test(term));
    const memberIds = new Set(
        (playlist.member_ids || []).map(id => String(id)));
    return libraryEntries.some(info => (
        memberIds.has(String(info.id))
        && matchesSearchFilter(info, videoTerms)
    ));
}

function playlistProgressText(playlist) {
    if (playlist.progress && playlist.progress.completed) return 'Completed';
    if (!playlist.item_count) return 'Empty playlist';
    const item = Math.min(playlist.item_count, Number(playlist.resume_position || 0) + 1);
    const seconds = playlist.progress ? playlist.progress.position_seconds : 0;
    const position = seconds >= 1 ? ` · ${formatMediaDuration(seconds) || '0:00'}` : '';
    return `Episode ${item} of ${playlist.item_count}${position}`;
}

function renderPlaylistMosaic(playlist) {
    const ids = Array.isArray(playlist.mosaic_ids) ? playlist.mosaic_ids : [];
    if (!ids.length) {
        return '<div class="playlist-mosaic-empty"><svg aria-hidden="true"><use href="#i-playlist"/></svg><span>No videos yet</span></div>';
    }
    return ids.map(id => assetImage(id, 'loading="lazy"')).join('');
}

function renderPlaylistCard(playlist) {
    const id = escapeAttr(playlist.id);
    const action = playlistActions.get(playlist.id);
    const blocked = !!action && playlistActionIntent(action)?.status !== 'rejected' || playlistSubmissions.has(playlist.id);
    const duration = formatMediaDuration(playlist.duration_seconds);
    const meta = `${playlist.item_count} ${playlist.item_count === 1 ? 'video' : 'videos'}${duration ? ` · ${duration}` : ''}`;
    const completed = Boolean(playlist.progress && playlist.progress.completed);
    const primary = completed ? 'Replay playlist' : 'Resume playlist';
    return `<article class="playlist-card" data-playlist-id="${id}">
        <button class="playlist-card-primary" type="button" onclick="startPlaylistPlayback('${id}', ${completed})" ${playlist.item_count ? '' : 'disabled'} aria-label="${primary}: ${escapeAttr(playlist.name)}">
            <span class="playlist-mosaic count-${Math.min(4, playlist.mosaic_ids.length)}">${renderPlaylistMosaic(playlist)}</span>
            <span class="playlist-marker"><svg aria-hidden="true"><use href="#i-playlist"/></svg>Playlist</span>
            <span class="playlist-preview-meta">${escapeHtml(meta)}</span>
        </button>
        <div class="playlist-card-caption">
            <div><strong title="${escapeAttr(playlist.name)}">${escapeHtml(playlist.name)}</strong><span class="playlist-resume">${escapeHtml(playlistProgressText(playlist))}</span>${action ? `<span class="playlist-request-status">${escapeHtml((action.entryLabel ? action.entryLabel + ': ' : '') + playlistActionMessage(action))}</span>` : ''}</div>
            <div class="menu-wrap">
                <button class="kebab-btn" type="button" onclick="togglePlaylistMenu('${id}', event)" aria-label="More actions for ${escapeAttr(playlist.name)}"><svg class="icon"><use href="#i-kebab"/></svg></button>
                <div id="playlist-menu-${id}" class="kebab-menu playlist-card-menu">
                    <button type="button" onclick="startPlaylistPlayback('${id}', true)"><svg class="menu-icon"><use href="#i-play"/></svg>Play from beginning</button>
                    <button type="button" onclick="openPlaylistEditor('${id}')"><svg class="menu-icon"><use href="#i-playlist"/></svg>Edit playlist</button>
                    <button type="button" class="danger" onclick="deletePlaylist('${id}')" ${blocked ? 'disabled' : ''}><svg class="menu-icon"><use href="#i-trash"/></svg>Delete playlist</button>
                </div>
            </div>
        </div>
    </article>`;
}

function renderPlaylists() {
    const shelf = document.getElementById('playlistShelf');
    const visible = playlistSummaries.filter(item => playlistActions.has(item.id) || playlistMatchesSearch(item));
    visiblePlaylistCount = visible.length;
    shelf.hidden = visible.length === 0;
    document.getElementById('playlistShelfCount').textContent =
        `${visible.length} ${visible.length === 1 ? 'playlist' : 'playlists'}`;
    reconcileCards(document.getElementById('playlistList'), visible, renderPlaylistCard, 'data-playlist-id');
    updateHistoryEmptyState();
}

function fetchPlaylists() {
    return coordinateRefresh('playlists', async () => {
        const generation = playlistCollectionGeneration;
        const epoch = tagSessionEpoch;
        try {
            const snapshots = await readCollection('/api/playlists');
            if (epoch !== tagSessionEpoch || generation !== playlistCollectionGeneration) return;
            const held = playlistSummaries.filter(item => playlistActions.has(item.id));
            for (const item of snapshots) if (!playlistDeletedIds.has(item.id)) tagState.acceptPlaylist(item);
            playlistSummaries = snapshots.filter(item => !playlistDeletedIds.has(item.id)).map(item => {
                const known = tagState.selectPlaylist(item.id);
                return known && known.revision >= item.revision ? { ...item, ...known } : item;
            });
            // Pending requests retain their initiating card and position even
            // when a background collection omits or reorders the target.
            for (const item of held) {
                playlistSummaries = playlistSummaries.filter(entry => entry.id !== item.id);
                playlistSummaries.splice(Math.min(playlistActions.get(item.id)?.index ?? held.indexOf(item), playlistSummaries.length), 0, tagState.selectPlaylist(item.id) || item);
            }
            renderPlaylists();
            renderPlaylistActionStatus();
            updateCollectionError('playlists');
        } catch (error) {
            if (epoch === tagSessionEpoch && error.name !== 'AbortError') updateCollectionError('playlists', `Could not refresh Playlists. ${error.message}`);
        }
    });
}

function togglePlaylistMenu(id, event) {
    event.stopPropagation();
    const menu = document.getElementById('playlist-menu-' + id);
    const open = menu.classList.contains('open');
    closeAllMenus();
    if (!open) menu.classList.add('open');
}

function playlistEditorSnapshot() {
    if (!playlistEditorDraft) return '';
    return JSON.stringify({
        name: playlistEditorDraft.name,
        ids: playlistEditorDraft.items.map(item => item.id),
    });
}

function markPlaylistEditorDirty() {
    if (!playlistEditorDraft) return;
    playlistEditorDraft.name = document.getElementById('playlistName').value;
    const snapshot = playlistEditorSnapshot();
    if (snapshot !== playlistEditorDraft.lastSnapshot) {
        playlistEditorDraft.generation++;
        playlistEditorDraft.lastSnapshot = snapshot;
    }
    const dirty = snapshot !== playlistEditorBaseline;
    document.getElementById('playlistEditorDirty').hidden = !dirty;
    renderPlaylistSaveStatus();
}

function playableLibraryEntries() {
    return libraryEntries.filter(info => {
        if (info.status !== 'finished' || !info.filename) return false;
        const extension = info.filename.split('.').pop().toLowerCase();
        return PLAYLIST_VIDEO_EXTENSIONS.has(extension);
    });
}

function renderPlaylistEditor() {
    if (!playlistEditorDraft) return;
    const selectedIds = new Set(
        playlistEditorDraft.items.map(item => item.id).filter(Boolean),
    );
    const query = tagSearchKey(document.getElementById('playlistVideoSearch').value);
    const available = playableLibraryEntries().filter(info => (
        !selectedIds.has(String(info.id))
        && (!query || tagSearchKey(libraryTitle(info)).includes(query))
    ));
    document.getElementById('playlistAvailable').innerHTML = available.length
        ? available.map(info => `<button type="button" class="playlist-picker-row" onclick="playlistEditorAdd('${escapeAttr(info.id)}')">${assetImage(info.id)}<span>${escapeHtml(libraryTitle(info))}${renameSurfaceStatus(info)}</span><svg aria-hidden="true"><use href="#i-plus"/></svg></button>`).join('')
        : '<p>No available videos match.</p>';
    document.getElementById('playlistSelected').innerHTML = playlistEditorDraft.items.length
        ? playlistEditorDraft.items.map((item, index) => `<div class="playlist-selected-row${item.unavailable ? ' is-unavailable' : ''}" draggable="${!item.unavailable}" data-playlist-index="${index}">
            <span class="playlist-drag-handle" aria-hidden="true">⋮⋮</span>
            ${item.id ? assetImage(item.id) : '<span class="playlist-unavailable-thumb"><svg><use href="#i-camera"/></svg></span>'}
            <span class="playlist-selected-title"><span>${index + 1}</span>${escapeHtml(item.title || 'Unavailable video')}${item.id ? renameSurfaceStatus(tagState.selectDownload(item.id) || item) : ''}</span>
            <span class="playlist-order-actions">
                <button type="button" onclick="playlistEditorMove(${index}, -1)" ${index === 0 ? 'disabled' : ''} aria-label="Move ${escapeAttr(item.title || 'video')} up">↑</button>
                <button type="button" onclick="playlistEditorMove(${index}, 1)" ${index === playlistEditorDraft.items.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeAttr(item.title || 'video')} down">↓</button>
                <button type="button" onclick="playlistEditorRemove(${index})" aria-label="Remove ${escapeAttr(item.title || 'video')}"><svg><use href="#i-x"/></svg></button>
            </span>
        </div>`).join('')
        : '<p>No videos selected.</p>';
    bindPlaylistDragging();
    markPlaylistEditorDirty();
}

function showPlaylistEditorError(message) {
    const error = document.getElementById('playlistEditorError');
    error.textContent = message || '';
    error.hidden = !message;
}

async function openPlaylistEditor(id = null, initialDownloadId = null) {
    closeAllMenus();
    const viewToken = ++playlistEditorViewToken;
    const epoch = tagSessionEpoch;
    const context = tagState.capture();
    playlistEditorReturnFocus = document.activeElement;
    showPlaylistEditorError('');
    playlistSaveMessage = '';
    playlistReviewVisible = false;
    let detail = null;
    const retained = [...playlistSubmissions.values()].find(entry => entry.key === id || entry.draft.id === id) || playlistRetainedDrafts.get(id);
    if (id && !retained) {
        const response = await apiFetch('/api/playlists/' + encodeURIComponent(id));
        if (viewToken !== playlistEditorViewToken || epoch !== tagSessionEpoch || playlistDeletedIds.has(id)) return;
        if (!response.ok) {
            if ([403, 404].includes(response.status)) tagMutations.fence(`playlist:${id}`);
            showActionError('The playlist could not be opened.'); return;
        }
        detail = await response.json();
        if (viewToken !== playlistEditorViewToken || epoch !== tagSessionEpoch) return;
        if (!tagState.acceptPlaylist(detail, { ...context, authoritative: true })) return;
        detail = tagState.selectPlaylist(id);
    }
    const initial = initialDownloadId ? playableLibraryEntries().find(item => String(item.id) === String(initialDownloadId)) : null;
    playlistEditorDraft = retained ? retained.draft : {
        key: detail ? detail.id : `local-${++playlistLocalSequence}`,
        id: detail ? detail.id : null,
        revision: detail ? detail.revision : 0,
        name: detail ? detail.name : '',
        items: detail ? detail.items.map(item => ({ ...item })) : (initial ? [{ id: String(initial.id), title: libraryTitle(initial), unavailable: false }] : []),
        generation: 0,
    };
    if (!detail && !retained) tagState.acceptPlaylist({ id: null, revision: 0, name: '', items: [] }, {}, playlistEditorDraft.key);
    document.getElementById('playlistEditorTitle').textContent = playlistEditorDraft.id ? 'Edit playlist' : 'Create playlist';
    document.getElementById('playlistName').value = playlistEditorDraft.name;
    document.getElementById('playlistVideoSearch').value = '';
    playlistEditorBaseline = retained ? retained.baseline : playlistEditorSnapshot();
    playlistEditorDraft.lastSnapshot = playlistEditorSnapshot();
    renderPlaylistEditor();
    const dialog = document.getElementById('playlistEditorDialog');
    if (!dialog.open) dialog.showModal();
    renderPlaylistSaveStatus();
    document.getElementById('playlistName').focus();
}

function closePlaylistEditor(force = false) {
    const dialog = document.getElementById('playlistEditorDialog');
    if (!dialog.open) return;
    markPlaylistEditorDirty();
    if (!force && !playlistSubmissions.has(playlistEditorDraft?.key) && !document.getElementById('playlistEditorDirty').hidden && !window.confirm('Discard unsaved playlist changes?')) return;
    ++playlistEditorViewToken;
    if (!playlistSubmissions.has(playlistEditorDraft?.key)) playlistRetainedDrafts.delete(playlistEditorDraft?.key);
    dialog.close();
    playlistEditorDraft = null;
    renderPlaylistSaveStatus();
    if (playlistEditorReturnFocus?.isConnected) playlistEditorReturnFocus.focus();
}

function playlistEditorAdd(id) {
    const info = playableLibraryEntries().find(item => String(item.id) === String(id));
    if (!info || !playlistEditorDraft) return;
    playlistEditorDraft.items.push({
        id: String(info.id), title: libraryTitle(info), unavailable: false,
    });
    renderPlaylistEditor();
}

function playlistEditorRemove(index) {
    if (!playlistEditorDraft) return;
    playlistEditorDraft.items.splice(index, 1);
    renderPlaylistEditor();
}

function playlistEditorMove(index, delta) {
    if (!playlistEditorDraft) return;
    const next = index + delta;
    if (next < 0 || next >= playlistEditorDraft.items.length) return;
    const [item] = playlistEditorDraft.items.splice(index, 1);
    playlistEditorDraft.items.splice(next, 0, item);
    renderPlaylistEditor();
    const rows = document.querySelectorAll('#playlistSelected .playlist-selected-row');
    const focus = rows[next] && rows[next].querySelector('button:not(:disabled)');
    if (focus) focus.focus();
    document.getElementById('playlistMoveStatus').textContent =
        `${item.title || 'Video'} moved to position ${next + 1}.`;
}

function bindPlaylistDragging() {
    let dragged = null;
    document.querySelectorAll('#playlistSelected .playlist-selected-row').forEach(row => {
        row.addEventListener('dragstart', event => {
            dragged = Number(row.dataset.playlistIndex);
            event.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragover', event => event.preventDefault());
        row.addEventListener('drop', event => {
            event.preventDefault();
            const target = Number(row.dataset.playlistIndex);
            if (dragged === null || dragged === target) return;
            const [item] = playlistEditorDraft.items.splice(dragged, 1);
            playlistEditorDraft.items.splice(target, 0, item);
            renderPlaylistEditor();
            document.getElementById('playlistMoveStatus').textContent =
                `${item.title || 'Video'} moved to position ${target + 1}.`;
        });
    });
}

function hasPlaylistProtocol(kind = 'playlist.replace') {
    return tagCapabilities?.mutation_protocol === 1 && tagCapabilities.actions?.includes(kind);
}

function playlistSubmissionIntent(submission) {
    return submission?.intentId ? tagMutations.status(submission.intentId) : submission?.legacy || null;
}

function renderPlaylistSaveStatus() {
    const status = document.getElementById('playlistSaveStatus');
    if (!status) return;
    const submission = playlistEditorDraft && playlistSubmissions.get(playlistEditorDraft.key);
    const intent = playlistSubmissionIntent(submission);
    const currentAction = playlistEditorDraft && playlistActions.get(playlistEditorDraft.key);
    const actionPending = currentAction && playlistActionIntent(currentAction)?.status !== 'rejected';
    const pending = intent && ['queued', 'sending'].includes(intent.status);
    const unknown = intent?.status === 'unconfirmed';
    const conflict = intent?.status === 'conflicted';
    let message = actionPending ? 'A playlist request is unresolved. Your draft remains editable; resolve that request before saving.' : playlistSaveMessage;
    if (pending) message = intent.delayed ? 'Still waiting for playlist confirmation. Your submitted draft is retained.' : submission.kind === 'playlist.create' ? 'Creating playlist…' : 'Saving playlist…';
    if (unknown) message = (submission.legacy ? 'Save not confirmed. This server has no receipt recovery. Reload to read current playlists; the earlier request may still complete.' : 'Save not confirmed. Check its status before replaying the original save.') + (playlistSaveMessage ? ` ${playlistSaveMessage}` : '');
    if (conflict) message = 'Playlist changed elsewhere. Review the current version before saving your draft again.';
    if (intent?.status === 'rejected') { message = intent.message || 'The playlist could not be saved. Your draft is retained.'; showPlaylistEditorError(message); }
    if (pending && submission.generation !== submission.draft.generation) message += ' Newer edits remain unsaved.';
    if (status.textContent !== message) status.textContent = message || '';
    const button = document.getElementById('playlistSaveButton');
    button.disabled = !!pending || !!unknown || !!conflict || !!actionPending;
    button.setAttribute('aria-busy', String(!!pending));
    button.querySelector('span').textContent = pending ? submission.kind === 'playlist.create' ? 'Creating…' : 'Saving…' : 'Save playlist';
    document.getElementById('playlistSavingSpinner').hidden = !pending;
    document.getElementById('playlistRecovery').hidden = !unknown && !conflict;
    document.getElementById('playlistCheck').hidden = !unknown || !!submission?.legacy;
    document.getElementById('playlistReplay').hidden = !unknown || !!submission?.legacy;
    document.getElementById('playlistReview').hidden = !conflict;
    document.getElementById('playlistResubmit').hidden = !conflict || !playlistReviewVisible;
    document.getElementById('playlistUseCurrent').hidden = !conflict && !unknown || !!submission?.legacy && !conflict;
    const current = submission && tagState.selectPlaylist(submission.key);
    const comparison = document.getElementById('playlistCurrentVersion');
    comparison.hidden = !playlistReviewVisible;
    if (playlistReviewVisible) comparison.textContent = current ? `${current.name}\n${current.items.map((item, index) => `${index + 1}. ${item.title || 'Unavailable video'}`).join('\n')}` : 'Playlist unavailable.';
    const error = intent?.fieldErrors?.name;
    document.getElementById('playlistName').setAttribute('aria-invalid', String(!!error));
    if (error) showPlaylistEditorError(error);
    const summary = document.getElementById('playlistMutationSummary');
    const entries = [...playlistSubmissions.values()];
    const closed = entries.filter(entry => entry.key !== playlistEditorDraft?.key);
    const closedDrafts = [...playlistRetainedDrafts.values()].filter(entry => entry.key !== playlistEditorDraft?.key);
    summary.hidden = !closed.length && !closedDrafts.length;
    const summaryMessage = closed.length === 1 && ['queued', 'sending'].includes(playlistSubmissionIntent(closed[0])?.status) ? closed[0].kind === 'playlist.create' ? 'Creating playlist…' : 'Saving playlist…' : closed.length ? `${closed.length} playlist ${closed.length === 1 ? 'save' : 'saves'} ${closed.some(entry => playlistSubmissionIntent(entry)?.status === 'unconfirmed') ? 'not confirmed' : closed.some(entry => playlistSubmissionIntent(entry)?.status === 'conflicted') ? 'in conflict' : 'pending or needing review'}.` : '';
    const closedMessage = summaryMessage + (closedDrafts.length ? ` ${closedDrafts.length} unsaved playlist ${closedDrafts.length === 1 ? 'draft' : 'drafts'}.` : '');
    if (summary.querySelector('span').textContent !== closedMessage) summary.querySelector('span').textContent = closedMessage;
    const aggregate = mutationDiagnosticIntents();
    for (const [field, states] of [['pending', ['queued', 'sending', 'unconfirmed', 'conflicted']], ['unconfirmed', ['unconfirmed']], ['conflicted', ['conflicted']]]) mutationMetrics[field] = aggregate.filter(entry => states.includes(entry.status)).length;
    for (const [field, states] of [['pending', ['queued', 'sending', 'unconfirmed', 'conflicted']], ['unconfirmed', ['unconfirmed']], ['conflicted', ['conflicted']]]) playlistMutationMetrics[field] = entries.filter(entry => states.includes(playlistSubmissionIntent(entry)?.status)).length + [...playlistActions.values()].filter(entry => states.includes(playlistActionIntent(entry)?.status)).length;
}

function handlePlaylistMutationEvent(event) {
    if (event.action === 'playlist.add' || event.action === 'playlist.delete') { handlePlaylistActionEvent(event); return; }
    const submission = [...playlistSubmissions.values()].find(entry => entry.intentId === event.intentId || (event.outcome === 'presented' && !entry.intentId && !entry.legacy));
    if (!submission || submission.epoch !== tagSessionEpoch) return;
    if (event.outcome === 'presented') submission.intentId = event.intentId;
    if (event.outcome === 'confirmed') finishPlaylistSave(submission, tagState.selectPlaylist(submission.key), event.revision);
    else {
        if (event.outcome === 'conflicted') mergeConfirmedPlaylist(tagState.selectPlaylist(submission.key));
        renderPlaylistSaveStatus();
    }
}

function mergeConfirmedPlaylist(playlist) {
    if (!playlist?.id || playlistDeletedIds.has(playlist.id)) return;
    playlistCollectionGeneration++;
    const index = playlistSummaries.findIndex(item => item.id === playlist.id);
    const old = playlistSummaries[index];
    if (old && old.revision > playlist.revision) return;
    const canonical = { ...playlist, item_count: playlist.item_count ?? playlist.items.length,
        member_ids: playlist.member_ids || playlist.items.map(item => item.id).filter(Boolean),
        mosaic_ids: playlist.mosaic_ids || playlist.items.map(item => item.id).filter(Boolean).slice(0, 4) };
    if (index < 0) playlistSummaries.push(canonical);
    else playlistSummaries[index] = { ...old, ...canonical };
    renderPlaylists();
}

function finishPlaylistSave(submission, canonical, acknowledgedRevision = canonical?.revision) {
    if (submission.epoch !== tagSessionEpoch || !canonical?.id) return;
    if (playlistDeletedIds.has(canonical.id)) {
        tagMutations.fence(`playlist:${submission.key}`);
        return;
    }
    if (!tagState.isAvailable(`playlist:${submission.key}`)) return;
    tagState.acceptPlaylist(canonical);
    mergeConfirmedPlaylist(tagState.selectPlaylist(canonical.id) || canonical);
    const latest = tagState.selectPlaylist(canonical.id) || canonical;
    canonical = latest;
    const sameView = playlistEditorDraft === submission.draft && playlistEditorViewToken === submission.viewToken;
    const sameDraft = submission.draft.generation === submission.generation;
    submission.draft.id = canonical.id;
    submission.draft.revision = acknowledgedRevision;
    playlistSubmissions.delete(submission.key);
    // Identity mapping happens once, while later edits retain their own draft.
    submission.draft.key = canonical.id;
    if (!sameDraft) playlistRetainedDrafts.set(canonical.id, { key: canonical.id, draft: submission.draft, baseline: JSON.stringify({ name: canonical.name, ids: canonical.items.map(item => item.id) }) });
    if (sameView && sameDraft) {
        playlistEditorBaseline = playlistEditorSnapshot();
        closePlaylistEditor(true);
    } else if (playlistEditorDraft === submission.draft) {
        playlistEditorBaseline = JSON.stringify({ name: canonical.name, ids: canonical.items.map(item => item.id) });
        playlistSaveMessage = sameDraft ? 'Playlist saved.' : 'Playlist saved. Newer edits remain unsaved.';
        markPlaylistEditorDirty();
    }
    renderPlaylistSaveStatus();
}

function savePlaylistEditor(event) {
    event.preventDefault();
    if (!playlistEditorDraft) return;
    markPlaylistEditorDirty();
    const draft = playlistEditorDraft;
    if (playlistActions.has(draft.key) && playlistActionIntent(playlistActions.get(draft.key))?.status !== 'rejected') { showPlaylistEditorError('Resolve the current playlist request before saving.'); return; }
    const prior = playlistSubmissions.get(draft.key);
    if (prior) {
        if (playlistSubmissionIntent(prior)?.status !== 'rejected') return;
        if (prior.intentId) tagMutations.resolve(prior.intentId);
        playlistSubmissions.delete(draft.key);
    }
    if (draft.items.some(item => !item.id)) { showPlaylistEditorError('Remove unavailable videos before saving this playlist.'); return; }
    const started = performance.now();
    showPlaylistEditorError('');
    playlistSaveMessage = '';
    playlistReviewVisible = false;
    if (playlistActions.size + playlistSubmissions.size + playlistRetainedDrafts.size - (playlistRetainedDrafts.has(draft.key) ? 1 : 0) >= 128) { showPlaylistEditorError('Too many pending edits. Resolve existing playlist saves first.'); return; }
    const priorAction = playlistActions.get(draft.key);
    if (priorAction && playlistActionIntent(priorAction)?.status === 'rejected') { if (priorAction.intentId) tagMutations.resolve(priorAction.intentId); playlistActions.delete(draft.key); }
    const kind = draft.id ? 'playlist.replace' : 'playlist.create';
    const submission = { key: draft.key, draft, kind, generation: draft.generation, viewToken: playlistEditorViewToken,
        epoch: tagSessionEpoch, baseline: playlistEditorBaseline, sentAt: performance.now(),
        value: { name: draft.name, download_ids: draft.items.map(item => item.id) } };
    playlistRetainedDrafts.delete(draft.key);
    playlistSubmissions.set(draft.key, submission);
    if (hasPlaylistProtocol(kind)) {
        const result = tagMutations.submit({ kind, targetId: `playlist:${draft.key}`, value: submission.value, expectedRevision: draft.revision, viewToken: submission.viewToken });
        if (!result.accepted) { playlistSubmissions.delete(draft.key); showPlaylistEditorError(result.message); }
        else submission.intentId = result.intentId;
    } else saveLegacyPlaylist(submission);
    renderPlaylistSaveStatus();
    playlistMutationMetrics.latestLocalFeedbackMs = performance.now() - started;
    mutationMetrics.latestLocalFeedbackMs = playlistMutationMetrics.latestLocalFeedbackMs;
}

async function saveLegacyPlaylist(submission) {
    submission.legacy = { status: 'sending' };
    for (const metrics of [playlistMutationMetrics, mutationMetrics]) metrics.submissions++;
    const alive = () => submission.epoch === tagSessionEpoch && playlistSubmissions.get(submission.key) === submission;
    const delayed = setTimeout(() => { if (alive()) { submission.legacy.delayed = true; renderPlaylistSaveStatus(); } }, 5000);
    const timeout = setTimeout(() => { if (alive() && submission.legacy.status === 'sending') { submission.legacy.status = 'unconfirmed'; renderPlaylistSaveStatus(); } }, 30000);
    renderPlaylistSaveStatus();
    try {
        const response = await apiFetch(submission.draft.id ? `/api/playlists/${encodeURIComponent(submission.draft.id)}` : '/api/playlists', {
            method: submission.draft.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...submission.value, ...(submission.draft.id ? { expected_revision: submission.draft.revision } : {}) }),
        });
        const body = await response.json().catch(() => null);
        if (!alive()) return;
        if ([401, 403, 404].includes(response.status)) { tagMutations.fence(`playlist:${submission.key}`); return; }
        if (response.ok && body?.id && Number.isSafeInteger(body.revision) && Array.isArray(body.items)) {
            tagState.acceptPlaylist(body, {}, submission.key);
            for (const metrics of [playlistMutationMetrics, mutationMetrics]) { metrics.acknowledgements++; metrics.latestAcknowledgementMs = Math.max(0, performance.now() - submission.sentAt); }
            finishPlaylistSave(submission, body);
        } else {
            if (response.status === 409 && submission.draft.id) {
                submission.legacy.status = 'conflicted';
                const currentResponse = await apiFetch(`/api/playlists/${encodeURIComponent(submission.draft.id)}`);
                const current = await currentResponse.json().catch(() => null);
                if (!alive()) return;
                if ([401, 403, 404].includes(currentResponse.status)) { tagMutations.fence(`playlist:${submission.key}`); return; }
                if (currentResponse.ok && current?.id === submission.draft.id) tagState.acceptPlaylist(current, {}, submission.key);
            } else submission.legacy.status = [400, 422].includes(response.status) ? 'rejected' : 'unconfirmed';
            for (const metrics of [playlistMutationMetrics, mutationMetrics]) metrics[submission.legacy.status === 'conflicted' ? 'conflicts' : submission.legacy.status === 'rejected' ? 'rejectedOutcomes' : 'unconfirmedOutcomes']++;
            submission.legacy.message = body?.error || 'The playlist could not be saved. Your draft is retained.';
            renderPlaylistSaveStatus();
        }
    } catch (_) { if (alive()) { submission.legacy.status = 'unconfirmed'; renderPlaylistSaveStatus(); } }
    finally { clearTimeout(delayed); clearTimeout(timeout); }
}

function playlistRecovery(action) {
    const submission = playlistEditorDraft && playlistSubmissions.get(playlistEditorDraft.key);
    const intent = playlistSubmissionIntent(submission);
    if (!intent) return;
    if (action === 'check') return tagMutations.recover(intent.id);
    if (action === 'replay') return tagMutations.recover(intent.id, { replay: true });
    if (action === 'review') { playlistReviewVisible = true; renderPlaylistSaveStatus(); return; }
    if (submission.legacy ? intent.status !== 'conflicted' || !tagState.selectPlaylist(submission.key)?.id : !submission.intentId || !tagMutations.resolve(submission.intentId)) { playlistSaveMessage = 'The original save may still complete. Check its status before using the current version.'; renderPlaylistSaveStatus(); return; }
    const current = tagState.selectPlaylist(submission.key);
    playlistSubmissions.delete(submission.key);
    playlistReviewVisible = false;
    if (current?.id) {
        playlistEditorDraft.id = current.id;
        playlistEditorDraft.revision = current.revision;
        if (action === 'current') {
            playlistEditorDraft.name = current.name;
            playlistEditorDraft.items = current.items.map(item => ({ ...item }));
            document.getElementById('playlistName').value = current.name;
            playlistEditorBaseline = playlistEditorSnapshot();
            renderPlaylistEditor();
        }
    }
    playlistSaveMessage = action === 'current' ? 'Current version loaded.' : 'Current version reviewed. Your draft remains unsaved.';
    renderPlaylistSaveStatus();
    if (action === 'resubmit') savePlaylistEditor({ preventDefault() {} });
}

function openPlaylistRecovery() {
    const submission = [...playlistSubmissions.values(), ...playlistRetainedDrafts.values()].find(entry => entry.key !== playlistEditorDraft?.key);
    if (submission) openPlaylistEditor(submission.key);
}

function fencePlaylistPresentation(key) {
    const submission = playlistSubmissions.get(key);
    playlistSubmissions.delete(key);
    playlistRetainedDrafts.delete(key);
    const action = playlistActions.get(key);
    if (action?.timer) clearTimeout(action.timer);
    if (action?.timeout) clearTimeout(action.timeout);
    if (playlistActionDialogId === key) closePlaylistDelete();
    playlistActions.delete(key);
    const id = submission?.draft.id || key;
    playlistDeletedIds.add(id);
    playlistCollectionGeneration++;
    playlistSummaries = playlistSummaries.filter(item => item.id !== id);
    if (playlistEditorDraft?.key === key) {
        document.getElementById('playlistEditorDialog').close();
        playlistEditorDraft = null;
        ++playlistEditorViewToken;
        document.getElementById('playlistName').value = '';
        document.getElementById('playlistSelected').replaceChildren();
        document.getElementById('playlistCurrentVersion').textContent = '';
    }
    renderPlaylistSaveStatus();
    renderPlaylists();
    renderPlaylistActionStatus();
}

function resetPlaylistSession() {
    ++playlistEditorViewToken;
    ++playlistCollectionGeneration;
    playlistSubmissions.clear(); playlistRetainedDrafts.clear(); playlistDeletedIds.clear();
    for (const action of playlistActions.values()) { if (action.timer) clearTimeout(action.timer); if (action.timeout) clearTimeout(action.timeout); }
    playlistActions.clear(); playlistActionDialogId = null;
    document.getElementById('playlistActionAnnouncement').textContent = '';
    const actionDialog = document.getElementById('playlistDeleteDialog');
    if (actionDialog.open) actionDialog.close();
    playlistEditorDraft = null; playlistSummaries = [];
    playlistSaveMessage = ''; playlistReviewVisible = false;
    const dialog = document.getElementById('playlistEditorDialog');
    if (dialog.open) dialog.close();
    document.getElementById('playlistName').value = '';
    document.getElementById('playlistSelected').replaceChildren();
    document.getElementById('playlistAvailable').replaceChildren();
    document.getElementById('playlistChooserList').replaceChildren();
    document.getElementById('playlistChooserEntry').textContent = '';
    document.getElementById('playlistActionCurrent').textContent = '';
    document.getElementById('playlistVideoSearch').value = '';
    document.getElementById('playlistCurrentVersion').textContent = '';
    playlistChooserDownloadId = null;
    const chooser = document.getElementById('playlistChooserDialog');
    if (chooser.open) chooser.close();
    renderPlaylistSaveStatus();
    renderPlaylists();
    renderPlaylistActionStatus();
}

function openPlaylistChooser(downloadId, opener = null) {
    closeAllMenus();
    playlistChooserDownloadId = String(downloadId);
    playlistChooserReturnFocus = opener || document.activeElement;
    renderPlaylistChooser();
    document.getElementById('playlistChooserDialog').showModal();
    placePlaylistActionAnnouncer();
}

function closePlaylistChooser() {
    const dialog = document.getElementById('playlistChooserDialog');
    if (dialog.open) dialog.close();
    placePlaylistActionAnnouncer();
    if (playlistChooserReturnFocus && playlistChooserReturnFocus.isConnected) {
        playlistChooserReturnFocus.focus();
    }
}

function renderPlaylistChooser() {
    const selected = libraryEntries.find(item => String(item.id) === playlistChooserDownloadId);
    document.getElementById('playlistChooserEntry').textContent = playlistChooserDownloadId ? libraryTitle(selected) : '';
    const list = document.getElementById('playlistChooserList');
    const entries = playlistSummaries;
    reconcileCards(list, entries, playlist => {
        const included = (playlist.member_ids || []).includes(playlistChooserDownloadId);
        const action = playlistActions.get(playlist.id);
        const blocked = !!action && playlistActionIntent(action)?.status !== 'rejected' || playlistSubmissions.has(playlist.id);
        return `<button data-playlist-add-id="${escapeAttr(playlist.id)}" type="button" onclick="quickAddToPlaylist('${escapeAttr(playlist.id)}')" ${included || blocked ? 'disabled' : ''}><span>${escapeHtml(playlist.name)}</span><span>${escapeHtml(action ? (action.entryLabel ? action.entryLabel + ': ' : '') + playlistActionMessage(action) : included ? 'Already added' : `${playlist.item_count} videos`)}</span></button>`;
    }, 'data-playlist-add-id');
    if (!entries.length) list.textContent = 'You have no playlists yet.';
}

function quickAddToPlaylist(playlistId) {
    beginPlaylistAction(playlistId, 'playlist.add', { download_id: playlistChooserDownloadId });
}

function createPlaylistFromChooser() {
    const downloadId = playlistChooserDownloadId;
    closePlaylistChooser();
    openPlaylistEditor(null, downloadId);
}

function deletePlaylist(id) {
    closeAllMenus();
    if (playlistActions.has(id) && playlistActionIntent(playlistActions.get(id))?.status !== 'rejected' || playlistSubmissions.has(id)) return;
    const prior = playlistActions.get(id);
    if (prior?.intentId) tagMutations.resolve(prior.intentId);
    playlistActions.delete(id);
    playlistActionDialogId = id;
    playlistActionReturnFocus = document.activeElement;
    document.getElementById('playlistDeleteDialog').showModal();
    renderPlaylistActionStatus();
}

function confirmPlaylistDelete() {
    if (playlistActionDialogId) beginPlaylistAction(playlistActionDialogId, 'playlist.delete', {});
}

function closePlaylistDelete() {
    const dialog = document.getElementById('playlistDeleteDialog');
    if (dialog.open) dialog.close();
    playlistActionDialogId = null;
    placePlaylistActionAnnouncer();
    if (playlistActionReturnFocus?.isConnected) playlistActionReturnFocus.focus();
}

function playlistActionIntent(action) {
    return action?.intentId ? tagMutations.status(action.intentId) : action?.legacy;
}

function playlistActionMessage(action) {
    const intent = playlistActionIntent(action);
    const noun = action.kind === 'playlist.add' ? 'Add' : 'Delete';
    if (intent?.status === 'unconfirmed') return `${noun} not confirmed. ${action.legacy ? 'This server has no receipt recovery. The earlier request may still complete.' : 'Check its status before replaying the original request.'}`;
    if (intent?.status === 'conflicted') return 'Playlist changed elsewhere. Review the current version before making a new request.';
    if (intent?.status === 'rejected') return intent.message || `${noun} was rejected. Review the current state.`;
    return intent?.delayed ? 'Still waiting for playlist confirmation. The request may still complete.' : action.kind === 'playlist.add' ? 'Adding to playlist…' : 'Deleting playlist…';
}

function placePlaylistActionAnnouncer() {
    const announcer = document.getElementById('playlistActionAnnouncement');
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    const host = document.activeElement?.closest('dialog[open]') || dialogs[dialogs.length - 1] || document.body;
    if (announcer.parentNode !== host) host.appendChild(announcer);
}

function renderPlaylistActionStatus() {
    const summary = document.getElementById('playlistActionSummary');
    if (!summary) return;
    placePlaylistActionAnnouncer();
    summary.hidden = !playlistActions.size;
    if (playlistActions.size) {
        const announcement = [...playlistActions.values()].map(action => `${action.entryLabel ? action.entryLabel + ' → ' : ''}${action.name}: ${playlistActionMessage(action)}`).join(' ');
        const announcer = document.getElementById('playlistActionAnnouncement');
        if (announcer.textContent !== announcement) announcer.textContent = announcement;
    }
    reconcileCards(summary, [...playlistActions.values()].map(action => ({ ...action, id: action.key })), action => `<div data-playlist-action-id="${escapeAttr(action.key)}"><span>${escapeHtml(action.entryLabel ? action.entryLabel + ' → ' : '')}${escapeHtml(action.name)}: ${escapeHtml(playlistActionMessage(action))}</span> <button type="button" onclick="openPlaylistActionRecovery('${escapeAttr(action.key)}')">Review request</button></div>`, 'data-playlist-action-id');
    const action = playlistActions.get(playlistActionDialogId);
    const intent = playlistActionIntent(action);
    const unknown = intent?.status === 'unconfirmed';
    const conflict = intent?.status === 'conflicted';
    document.getElementById('playlistDeleteTitle').textContent = action?.kind === 'playlist.add' ? 'Add to playlist' : 'Delete playlist?';
    const message = action ? (action.entryLabel ? action.entryLabel + ': ' : '') + playlistActionMessage(action) : 'Its videos and media files will remain in your library.';
    const status = document.getElementById('playlistDeleteStatus');
    if (status.textContent !== message) status.textContent = message;
    document.getElementById('playlistDeleteConfirm').hidden = !!action;
    document.getElementById('playlistActionCheck').hidden = !unknown || !!action?.legacy;
    document.getElementById('playlistActionReplay').hidden = !unknown || !!action?.legacy;
    document.getElementById('playlistActionReview').hidden = !conflict;
    document.getElementById('playlistActionDismiss').hidden = !unknown && !conflict && intent?.status !== 'rejected';
    const current = document.getElementById('playlistActionCurrent');
    current.hidden = !action?.reviewed;
    if (!action?.reviewed) current.textContent = '';
    if (action?.reviewed) {
        const canonical = tagState.selectPlaylist(action.key);
        current.textContent = canonical ? `${canonical.name}\n${canonical.items.map(item => item.title).join('\n')}` : 'Playlist unavailable.';
    }
    renderPlaylistChooser();
    const entries = [...playlistActions.values()].map(playlistActionIntent).filter(Boolean);
    const all = tagMutations.pending().concat(uploadDiagnosticIntents()).concat(downloadSubmission?.legacy ? [{ ...downloadSubmission.legacy, kind: 'download.submit' }] : []).concat([...playlistSubmissions.values()].filter(entry => entry.legacy).map(entry => entry.legacy), [...playlistActions.values()].filter(entry => entry.legacy).map(entry => entry.legacy), preferenceSubmission?.legacy ? [preferenceSubmission.legacy] : []);
    for (const [field, statuses] of [['pending', ['queued', 'sending', 'unconfirmed', 'conflicted']], ['unconfirmed', ['unconfirmed']], ['conflicted', ['conflicted']]]) {
        mutationMetrics[field] = all.filter(entry => statuses.includes(entry.status)).length;
        playlistMutationMetrics[field] = entries.concat([...playlistSubmissions.values()].map(playlistSubmissionIntent).filter(Boolean)).filter(entry => statuses.includes(entry.status)).length;
    }
}

function openPlaylistActionRecovery(id) {
    if (!playlistActions.has(id)) return;
    playlistActionDialogId = id;
    playlistActionReturnFocus = document.activeElement;
    const dialog = document.getElementById('playlistDeleteDialog');
    if (!dialog.open) dialog.showModal();
    renderPlaylistActionStatus();
}

async function playlistActionRecovery(mode) {
    const action = playlistActions.get(playlistActionDialogId);
    const intent = playlistActionIntent(action);
    if (!action || !intent) return;
    if (mode === 'check') return tagMutations.recover(action.intentId);
    if (mode === 'replay') return tagMutations.recover(action.intentId, { replay: true });
    if (mode === 'review') { action.reviewed = true; renderPlaylistActionStatus(); return; }
    if (intent.status === 'conflicted' && !action.reviewed) { action.reviewed = true; renderPlaylistActionStatus(); return; }
    if (action.legacy ? intent.status === 'unconfirmed' : !tagMutations.resolve(action.intentId)) {
        document.getElementById('playlistDeleteStatus').textContent = 'The original request may still complete. Check its status before making another request.';
        return;
    }
    playlistActions.delete(action.key);
    if (action.timer) clearTimeout(action.timer);
    if (action.timeout) clearTimeout(action.timeout);
    closePlaylistDelete(); renderPlaylistActionStatus(); renderPlaylists(); renderPlaylistSaveStatus();
}

function beginPlaylistAction(id, kind, value) {
    const prior = playlistActions.get(id);
    if (prior && playlistActionIntent(prior)?.status === 'rejected') {
        if (prior.intentId) tagMutations.resolve(prior.intentId);
        playlistActions.delete(id);
    }
    if (!id || playlistDeletedIds.has(id) || playlistActions.has(id) || playlistSubmissions.has(id)) return;
    const canonical = tagState.selectPlaylist(id) || playlistSummaries.find(item => item.id === id);
    if (!canonical) return;
    const retainedRecords = playlistActions.size + playlistSubmissions.size + playlistRetainedDrafts.size;
    const legacyWork = [...playlistActions.values(), ...playlistSubmissions.values()].filter(entry => entry.legacy).length
        + (preferenceSubmission?.legacy ? 1 : 0);
    if (retainedRecords >= 128 || tagMutations.pending().length + legacyWork >= 128) {
        showActionError('Too many pending edits. Resolve existing requests first.');
        return;
    }
    const started = performance.now();
    tagState.acceptPlaylist(canonical);
    const entryLabel = kind === 'playlist.add' ? libraryTitle(libraryEntries.find(item => String(item.id) === value.download_id)) : null;
    const action = { key: id, kind, value, entryLabel, name: canonical.name, epoch: tagSessionEpoch, sentAt: performance.now(), index: playlistSummaries.findIndex(item => item.id === id) };
    playlistActions.set(id, action);
    if (hasPlaylistProtocol(kind)) {
        const result = tagMutations.submit({ kind, targetId: `playlist:${id}`, value });
        if (result.accepted) action.intentId = result.intentId;
        else { playlistActions.delete(id); showActionError(result.message); }
    } else sendLegacyPlaylistAction(action);
    renderPlaylistActionStatus(); renderPlaylists(); renderPlaylistSaveStatus();
    playlistMutationMetrics.latestLocalFeedbackMs = performance.now() - started;
    mutationMetrics.latestLocalFeedbackMs = playlistMutationMetrics.latestLocalFeedbackMs;
}

function handlePlaylistActionEvent(event) {
    const action = [...playlistActions.values()].find(entry => entry.intentId === event.intentId || (event.outcome === 'presented' && !entry.intentId && !entry.legacy && entry.kind === event.action));
    if (!action || action.epoch !== tagSessionEpoch) {
        if (event.outcome === 'confirmed' && event.action === 'playlist.delete') document.getElementById('playlistActionAnnouncement').textContent = 'Playlist deleted. Its videos remain in your library.';
        return;
    }
    if (event.outcome === 'presented') action.intentId = event.intentId;
    if (event.outcome === 'confirmed') {
        document.getElementById('playlistActionAnnouncement').textContent = action.kind === 'playlist.add' ? 'Added to playlist.' : 'Playlist deleted. Its videos remain in your library.';
        if (action.kind === 'playlist.add') mergeConfirmedPlaylist(tagState.selectPlaylist(action.key));
        playlistActions.delete(action.key);
        if (playlistActionDialogId === action.key) closePlaylistDelete();
    } else if (event.outcome === 'conflicted' || event.outcome === 'rejected') mergeConfirmedPlaylist(tagState.selectPlaylist(action.key));
    renderPlaylistActionStatus(); renderPlaylists(); renderPlaylistSaveStatus();
}

function setLegacyPlaylistActionOutcome(action, status, message = '') {
    if (action.legacy?.status !== status) for (const metrics of [playlistMutationMetrics, mutationMetrics]) metrics[status === 'conflicted' ? 'conflicts' : status === 'rejected' ? 'rejectedOutcomes' : 'unconfirmedOutcomes']++;
    action.legacy = { status, message };
    renderPlaylistActionStatus(); renderPlaylists(); renderPlaylistSaveStatus();
}

async function sendLegacyPlaylistAction(action) {
    action.legacy = { status: 'sending' };
    for (const metrics of [playlistMutationMetrics, mutationMetrics]) metrics.submissions++;
    const current = () => action.epoch === tagSessionEpoch && playlistActions.get(action.key) === action;
    action.timer = setTimeout(() => { if (current() && action.legacy.status === 'sending') { action.legacy.delayed = true; renderPlaylistActionStatus(); renderPlaylists(); } }, 5000);
    action.timeout = setTimeout(() => { if (current() && action.legacy.status === 'sending') { setLegacyPlaylistActionOutcome(action, 'unconfirmed'); } }, 30000);
    try {
        const response = await apiFetch('/api/playlists/' + encodeURIComponent(action.key) + (action.kind === 'playlist.add' ? '/items' : ''), { method: action.kind === 'playlist.add' ? 'POST' : 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action.value) });
        if (!current()) return;
        const body = response.status === 204 ? null : await response.json().catch(() => null);
        if (!current()) return;
        if ([401, 403, 404].includes(response.status)) { tagMutations.fence(`playlist:${action.key}`); return; }
        if (response.ok && (action.kind === 'playlist.delete' ? response.status === 204 : body?.id === action.key && Number.isSafeInteger(body.revision) && Array.isArray(body.items))) {
            for (const metrics of [playlistMutationMetrics, mutationMetrics]) { metrics.acknowledgements++; metrics.latestAcknowledgementMs = Math.max(0, performance.now() - action.sentAt); }
            if (action.kind === 'playlist.delete') tagMutations.fence(`playlist:${action.key}`);
            else { tagState.acceptPlaylist(body); mergeConfirmedPlaylist(tagState.selectPlaylist(action.key)); playlistActions.delete(action.key); }
            if (playlistActionDialogId === action.key) closePlaylistDelete();
        } else {
            setLegacyPlaylistActionOutcome(action, response.status === 409 ? 'conflicted' : response.status >= 400 && response.status < 500 ? 'rejected' : 'unconfirmed', typeof body?.error === 'string' ? body.error : 'Request not confirmed.');
        }
    } catch (_) { if (current()) setLegacyPlaylistActionOutcome(action, 'unconfirmed'); }
    finally { clearTimeout(action.timer); clearTimeout(action.timeout); renderPlaylistActionStatus(); renderPlaylists(); renderPlaylistSaveStatus(); }
}

function renderHistoryCard(info) {
    const id = String(info.id);
    const isFinished = info.status === 'finished';
    const isUpload = info.source_type === 'upload';
    const hasPlay = isFinished && info.filename;
    const safeUrl = escapeAttr(info.url);
    const urlData = `data-url="${safeUrl}"`;

    let displayTitle = info.title || '';
    if (!displayTitle && info.filename) {
        const base = displayFilename(info);
        displayTitle = base.replace(/\.[^.]+$/, '');
    }
    if (!displayTitle) displayTitle = 'Untitled download';

    const menuItems = [
        `<button data-info-action aria-expanded="false" aria-controls="info-${escapeAttr(id)}" onclick="toggleHistoryInfo('${id}', event)"><svg class="menu-icon"><use href="#i-info"/></svg>Info</button>`,
    ];
    if (!isUpload) {
        menuItems.push(`<button data-url-action="open" ${urlData}><svg class="menu-icon"><use href="#i-external"/></svg>Open URL</button>`);
    }
    if (hasPlay) {
        const playLabel = displayFilename(info);
        const playExt = info.filename.split('.').pop().toLowerCase();
        menuItems.push(`<button data-endless-action data-download-id="${escapeAttr(id)}" data-play-label="${escapeAttr(playLabel)}" data-play-ext="${escapeAttr(playExt)}"><svg class="menu-icon"><use href="#i-play"/></svg>Play All</button>`);
        if (PLAYLIST_VIDEO_EXTENSIONS.has(playExt)) {
            menuItems.push(`<button data-playlist-add-action data-download-id="${escapeAttr(id)}"><svg class="menu-icon"><use href="#i-playlist"/></svg>Add to playlist…</button>`);
        }
        menuItems.push(`<button data-file-download-action data-download-id="${escapeAttr(id)}"><svg class="menu-icon"><use href="#i-download"/></svg>Download</button>`);
    }
    if (!isFinished) {
        menuItems.push(`<button data-download-command="retry" data-command-attempt="${escapeAttr(info.current_attempt_id || '')}" data-url-action="reload" data-download-id="${escapeAttr(id)}" ${urlData}><svg class="menu-icon"><use href="#i-sync"/></svg>Reload</button>`);
    }
    menuItems.push(`<button class="danger" data-entry-remove data-download-id="${escapeAttr(id)}" onclick="deleteDownload('${id}')"${removalBlocksWrites(id) ? ' disabled' : ''}><svg class="menu-icon"><use href="#i-trash"/></svg>Delete</button>`);

    const favoriteButton = renderFavoriteControl(info);
    const viewCount = Math.max(0, Number.parseInt(info.view_count, 10) || 0);
    const newBadge = viewCount === 0
        ? '<span class="history-preview-label history-preview-new">new</span>'
        : '';
    const quality = String(info.quality || '');
    const qualityBadge = quality
        ? `<span class="history-preview-label history-preview-quality${quality === '4k' ? ' is-4k' : ''}">${escapeHtml(quality)}</span>`
        : '';
    const mediaDuration = formatMediaDuration(info.duration_seconds);
    const durationBadge = mediaDuration
        ? `<span class="history-preview-label history-preview-duration">${mediaDuration}</span>`
        : '';
    const videoPreview = hasVideoAssets(info);
    const thumbnailState = videoPreview ? (info.assets?.thumbnail || 'queued') : 'failed';
    const thumbnailStatus = thumbnailState === 'failed' ? 'Preview unavailable' : 'Preparing preview';
    let preview;
    if (hasPlay) {
        const playLabel = displayFilename(info);
        const playExt = info.filename.split('.').pop().toLowerCase();
        preview = `
                <div class="history-preview-wrap">
                    <button class="history-preview${thumbnailState === 'ready' ? '' : thumbnailState === 'failed' ? ' thumbnail-unavailable' : ' thumbnail-pending'}${mediaDuration ? ' has-preview-duration' : ''}" type="button" data-play-action data-download-id="${escapeAttr(id)}" data-play-label="${escapeAttr(playLabel)}" data-play-ext="${escapeAttr(playExt)}" aria-label="Play">
                        <span class="history-preview-fallback"><svg><use href="#i-camera"/></svg><span>${thumbnailStatus}</span></span>
                        ${assetImage(id, 'loading="lazy"')}
                        <video class="history-preview-video" muted playsinline loop preload="none" aria-hidden="true"></video>
                        ${newBadge}
                        ${qualityBadge}
                        ${durationBadge}
                    </button>
                    ${favoriteButton}
                </div>`;
    } else {
        preview = `
                <div class="history-preview-wrap">
                    <div class="history-preview thumbnail-unavailable history-preview-error" aria-label="Preview unavailable">
                        <span class="history-preview-fallback"><svg><use href="#i-camera"/></svg><span>Preview unavailable</span></span>
                    </div>
                    ${favoriteButton}
                </div>`;
    }

    let fileControl = '';
    if (info.filename || renameIntent(id) || renameDrafts.has(id)) {
        const base = displayFilename(info);
        fileControl = `
                            <div class="history-info-section history-file-section">
                                <div class="history-info-label">File</div>
                                ${isFinished
        ? renderRenameControl(id, base, true)
        : `<div class="history-file-value filename">${escapeHtml(base)}</div>`}
                            </div>`;
    }

    const sourceControl = isUpload
        ? `<div class="history-info-section history-source-section">
                                <div class="history-info-label">Source</div>
                                <div class="history-source-field"><span>${info.mounted_import ? 'Mounted import' : 'Local upload'}</span></div>
                            </div>`
        : `<div class="history-info-section history-source-section">
                                <div class="history-info-label">Original URL</div>
                                <div class="history-source-field">
                                    <span>${escapeHtml(info.url)}</span>
                                    <button type="button" class="history-source-copy" data-url-action="copy" ${urlData} aria-label="Copy original URL" title="Copy original URL"><svg class="menu-icon"><use href="#i-copy"/></svg>Copy</button>
                                </div>
                            </div>`;

    const metadata = [];
    metadata.push(`<div class="history-status-row"><strong>Status:</strong> ${escapeHtml(info.status.charAt(0).toUpperCase() + info.status.slice(1))}</div>`);
    const viewSummary = viewCount === 0
        ? '<strong class="history-view-new">NEW</strong>'
        : `<span><strong>Views:</strong> ${viewCount}</span>`;
    metadata.push(`<div class="history-owner-row"><span><strong>Downloaded by:</strong> ${escapeHtml(info.downloaded_by || 'Unknown user')}</span> &middot; ${viewSummary}</div>`);
    const sizeStr = formatBytes(info.filesize);
    const requestedFormat = formatRequestedFormat(info);
    const mediaParts = [];
    if (info.resolution) mediaParts.push(`<strong>Quality:</strong> ${escapeHtml(info.resolution)}`);
    if (sizeStr) mediaParts.push(`<strong>Size:</strong> ${sizeStr}`);
    if (requestedFormat) mediaParts.push(`<strong>Requested format:</strong> ${escapeHtml(requestedFormat)}`);
    if (mediaParts.length) metadata.push(`<div class="history-media-row">${mediaParts.join(' &middot; ')}</div>`);

    const timingParts = [];
    const startedStr = formatDateTime(info.created_at);
    if (startedStr) timingParts.push(
        `<strong>${isUpload ? 'Added' : 'Started'}:</strong> ${startedStr}`);
    const durationStr = isUpload
        ? null
        : formatDuration(info.created_at, info.finished_at);
    if (durationStr) timingParts.push(`<strong>Duration:</strong> ${durationStr}`);
    if (timingParts.length) metadata.push(`<div class="history-timing-row">${timingParts.join(' &middot; ')}</div>`);

    let errorBlock = '';
    if (info.status === 'error' && info.progress) {
        const detail = String(info.progress);
        const openAttr = openErrorIds.has(id) ? ' open' : '';
        const showFormats = /--list-formats/i.test(detail);
        errorBlock = `
                        <details class="error-details"${openAttr} ontoggle="onErrorDetailsToggle('${id}', this)">
                            <summary><svg class="chev"><use href="#i-chevron"/></svg><strong>Error details</strong></summary>
                            <pre class="error-text">${escapeHtml(detail)}</pre>
                            ${showFormats ? renderFormatsTable(info) : ''}
                        </details>`;
    }

    const visibilityControl = renderVisibilityControl(info);

    return `
                <article class="history-card" id="history-item-${escapeAttr(id)}" data-row-id="${escapeAttr(id)}">
                    ${preview}
                    <div class="history-card-caption">
                        <div class="history-card-title" title="${escapeAttr(displayTitle)}">${escapeHtml(displayTitle)}${renameSurfaceStatus(info)}</div>
                        <div class="menu-wrap">
                            <button class="kebab-btn" onclick="toggleMenu('${id}', event)" aria-label="More actions"><svg class="icon"><use href="#i-kebab"/></svg></button>
                            <div id="menu-${escapeAttr(id)}" class="kebab-menu">${menuItems.join('')}</div>
                        </div>
                    </div>
                    ${uploadStatusSlot(id)}
                    ${downloadCommandStatusSlot(id)}
                    ${removalStatusSlot(id)}
                    <div id="info-${escapeAttr(id)}" class="history-info-popover" role="dialog" aria-label="Download information">
                        <div class="history-info-content">
                            <div class="history-info-header">
                                <span class="history-info-heading"><svg aria-hidden="true"><use href="#i-info"/></svg><strong>INFO</strong></span>
                                <button type="button" class="history-info-close" onclick="closeHistoryInfo()" aria-label="Close info"><svg><use href="#i-x"/></svg></button>
                            </div>
                            <div class="history-info-title">${escapeHtml(displayTitle)}</div>
                            <div class="history-info-section">
                                <div class="history-info-label">Tags</div>
                                ${renderTagControl(info)}
                            </div>
                            <div class="history-info-section"><div class="history-info-label">Favorite</div>${renderFavoriteControl(info, true)}</div>
                            ${fileControl}
                            ${visibilityControl}
                            ${sourceControl}
                            <div class="meta history-info-meta">${metadata.join('')}</div>
                            ${errorBlock}
                        </div>
                    </div>
                </article>`;
}

function renderItem(info, inHistoryView = false) {
    if (inHistoryView) return renderHistoryCard(info);

    const id = info.id;
    const isRunning = RUNNING_STATUSES.has(info.status);
    const isPaused = info.status === 'paused';
    const isCancelled = info.status === 'cancelled';
    const isTerminal = TERMINAL_STATUSES.has(info.status);
    const isFinished = info.status === 'finished';
    const isUpload = info.source_type === 'upload';
    const isCurrentTabStopped = !inHistoryView && (isCancelled || info.status === 'interrupted');

    // URLs stay in data attributes and are read through dataset by the
    // delegated click handler. Putting them inside inline JavaScript would
    // let HTML entity decoding turn an apostrophe back into executable code.
    const safeUrl = escapeAttr(info.url);
    const urlData = `data-url="${safeUrl}"`;

    let primary = '';
    const menuItems = [];

    if (isRunning && (!isUpload || info.can_manage_upload !== false)) {
        primary = `<button class="stop-btn icon-only" data-download-command="stop" data-command-attempt="${escapeAttr(info.current_attempt_id || '')}" data-download-id="${escapeAttr(id)}" onclick="stopDownload('${id}', this.dataset.commandAttempt || null)" aria-label="Stop" title="Stop">${renderActionProgressIcon('i-pause', info)}</button>`;
    } else if (isPaused) {
        primary = `<button class="continue-btn" data-download-command="unpause" data-command-attempt="${escapeAttr(info.current_attempt_id || '')}" data-download-id="${escapeAttr(id)}" onclick="unpauseDownload('${id}', this.dataset.commandAttempt || null)">${renderActionProgressIcon('i-play', info)}Resume</button>`;
    } else if (!isUpload && info.browser_authenticated
            && (isCancelled || info.status === 'interrupted')) {
        primary = '<span class="firefox-resend" title="Open the source page while signed in, then click the VDL Companion toolbar action.">Re-send from Firefox</span>';
    } else if (!isUpload && (isCancelled || info.status === 'interrupted')) {
        primary = `<button class="continue-btn icon-only" data-download-command="resume" data-command-attempt="${escapeAttr(info.current_attempt_id || '')}" data-url-action="continue" data-download-id="${id}" ${urlData} aria-label="Continue" title="Continue">${renderActionProgressIcon('i-play', info)}</button>`;
    }

    if (!isUpload) {
        menuItems.push(`<button data-url-action="open" ${urlData}><svg class="menu-icon"><use href="#i-external"/></svg>Open URL</button>`);
    }

    if (isRunning && !isUpload) {
        menuItems.push(`<button data-download-command="pause" data-command-attempt="${escapeAttr(info.current_attempt_id || '')}" data-download-id="${escapeAttr(id)}" onclick="pauseDownload('${id}', this.dataset.commandAttempt || null)"><svg class="menu-icon"><use href="#i-pause"/></svg>Pause</button>`);
    }

    if (isPaused) {
        menuItems.push(`<button data-download-command="stop" data-command-attempt="${escapeAttr(info.current_attempt_id || '')}" data-download-id="${escapeAttr(id)}" onclick="stopDownload('${id}', this.dataset.commandAttempt || null)"><svg class="menu-icon"><use href="#i-stop"/></svg>Stop</button>`);
    }

    if (isTerminal) {
        if (!isUpload && !isFinished && !isCancelled && info.status !== 'interrupted') {
            menuItems.push(`<button data-download-command="retry" data-command-attempt="${escapeAttr(info.current_attempt_id || '')}" data-url-action="reload" data-download-id="${id}" ${urlData}><svg class="menu-icon"><use href="#i-sync"/></svg>Reload</button>`);
        }
        if (!isUpload) {
            menuItems.push(`<button data-url-action="copy" ${urlData}><svg class="menu-icon"><use href="#i-copy"/></svg>Copy URL</button>`);
        }
        menuItems.push(`<button class="danger" data-entry-remove data-download-id="${escapeAttr(id)}" onclick="deleteDownload('${id}')"${removalBlocksWrites(id) ? ' disabled' : ''}><svg class="menu-icon"><use href="#i-trash"/></svg>Delete</button>`);
    } else if (!isUpload) {
        menuItems.push(`<button data-url-action="copy" ${urlData}><svg class="menu-icon"><use href="#i-copy"/></svg>Copy URL</button>`);
    }

    const hasPlay = isFinished && info.filename;
    let playBtn = '';
    if (hasPlay) {
        const playLabel = displayFilename(info);
        const playExt = info.filename.split('.').pop().toLowerCase();
        // Filenames stay in data attributes so HTML entity decoding cannot
        // turn stored text into executable inline JavaScript.
        playBtn = `<button data-play-action data-download-id="${escapeAttr(id)}" data-play-label="${escapeAttr(playLabel)}" data-play-ext="${escapeAttr(playExt)}" aria-label="Play" title="Play"><svg class="icon"><use href="#i-camera"/></svg></button>`;
    }

    const kebabInner = menuItems.length ? `
                <div class="menu-wrap">
                    <button class="kebab-btn" onclick="toggleMenu('${id}', event)" aria-label="More actions"><svg class="icon"><use href="#i-kebab"/></svg></button>
                    <div id="menu-${id}" class="kebab-menu">${menuItems.join('')}</div>
                </div>` : '';

    const leading = primary || playBtn;
    const actions = (leading || menuItems.length)
        ? `<div class="action-group">${leading}${kebabInner}</div>`
        : '';

    const isCurrentRow = !inHistoryView && CURRENT_TAB_STATUSES.has(info.status);
    const etaStr = isRunning ? formatEta(info.eta) : '';
    const downloadedPercent = itemProgressPercent(info);
    const workerStatusLabel = ({ starting: 'Starting', downloading: 'Downloading', paused: 'Paused', cancelled: 'Cancelled', interrupted: 'Interrupted', finished: 'Finished', error: 'Failed' })[info.status] || info.status;
    const downloadSummaryParts = [`<strong>Status:</strong> <span class="download-worker-status">${escapeHtml(workerStatusLabel)}</span>`];
    if ((info.status === 'starting' && info.progress)
            || ((isRunning || isPaused) && String(info.progress).startsWith('Stopping download;'))) {
        downloadSummaryParts.push(escapeHtml(info.progress));
    }
    const summarySize = formatBytes(info.filesize);
    if (isUpload && info.upload_detail) downloadSummaryParts.push(escapeHtml(info.upload_detail));
    if (summarySize) downloadSummaryParts.push(`<strong>Total size:</strong> ${summarySize}`);
    if (isUpload) downloadSummaryParts.push(`<strong>Bytes uploaded:</strong> ${formatBytes(info.downloaded_bytes) || '0 B'}`);
    else downloadSummaryParts.push(`<strong>Bytes downloaded:</strong> ${formatBytes(info.downloaded_bytes) || '0 B'}`);
    if (info.resolution) downloadSummaryParts.push(`<strong>Quality:</strong> ${info.resolution}`);
    downloadSummaryParts.push(`<strong>${isUpload ? 'Uploaded' : 'Downloaded'}:</strong> ${downloadedPercent === null ? '&mdash;' : `${downloadedPercent}%`}`);
    const downloadSummaryRow = isCurrentRow
        ? `<div class="meta download-summary-row">
                        <span>${downloadSummaryParts.join(' &middot; ')}</span>
                        ${etaStr ? `<span class="eta-right">${etaStr}</span>` : ''}
                    </div>`
        : '';

    let bottom = '';
    if (!isRunning && !isCurrentTabStopped) {
        if (!isFinished && info.status !== 'error' && !isPaused) {
            let barClass = 'progress-bar-fill';
            if (info.status === 'cancelled') barClass += ' cancelled';
            else if (info.status === 'interrupted') barClass += ' interrupted';
            let width = String(info.progress).replace('%', '');
            if (isNaN(width)) width = 0;
            bottom += `
                        <div class="progress-bar-bg">
                            <div class="${barClass}" style="width: ${width}%;"></div>
                        </div>`;
        }
        const meta = [];
        if (info.filename || renameIntent(id) || renameDrafts.has(id)) {
            const base = displayFilename(info);
            if (isFinished) {
                meta.push(`<div class="file-meta-row"><strong>File:</strong>${renderRenameControl(id, base)}</div>`);
            } else {
                meta.push(`<div><strong>File:</strong> <span class="filename">${escapeHtml(base)}</span></div>`);
            }
        }
        const sizeStr = formatBytes(info.filesize);
        const startedStr = formatDateTime(info.created_at);
        const requestedFormat = formatRequestedFormat(info);
        if (inHistoryView) {
            const mediaParts = [];
            if (info.resolution) mediaParts.push(`<strong>Quality:</strong> ${info.resolution}`);
            if (sizeStr) mediaParts.push(`<strong>Size:</strong> ${sizeStr}`);
            if (requestedFormat) mediaParts.push(`<strong>Requested format:</strong> ${escapeHtml(requestedFormat)}`);
            if (mediaParts.length) {
                meta.push(`<div class="history-media-row">${mediaParts.join(' &middot; ')}</div>`);
            }

            const timingParts = [];
            if (startedStr) timingParts.push(`<strong>Started:</strong> ${startedStr}`);
            const durationStr = formatDuration(info.created_at, info.finished_at);
            if (durationStr) timingParts.push(`<strong>Duration:</strong> ${durationStr}`);
            if (timingParts.length) {
                meta.push(`<div class="history-timing-row">${timingParts.join(' &middot; ')}</div>`);
            }
        } else if (startedStr) {
            meta.push(`<div><strong>Started:</strong> ${startedStr}</div>`);
        }
        if (!inHistoryView && requestedFormat) {
            meta.push(`<div><strong>Requested format:</strong> ${escapeHtml(requestedFormat)}</div>`);
        }
        if (meta.length) bottom += `<div class="meta">${meta.join('')}</div>`;
    }

    let errorBlock = '';
    if (info.status === 'error' && info.progress) {
        const detail = String(info.progress);
        const openAttr = openErrorIds.has(id) ? ' open' : '';
        const showFormats = /--list-formats/i.test(detail);
        errorBlock = `
                    <details class="error-details"${openAttr} ontoggle="onErrorDetailsToggle('${id}', this)">
                        <summary><svg class="chev"><use href="#i-chevron"/></svg><strong>Error details</strong></summary>
                        <pre class="error-text">${escapeHtml(detail)}</pre>
                        ${showFormats ? renderFormatsTable(info) : ''}
                    </details>`;
    }

    let displayTitle = info.title || '';
    if (!displayTitle && info.filename) {
        const base = displayFilename(info);
        displayTitle = base.replace(/\.[^.]+$/, '');
    }
    const authenticatedLabel = info.browser_authenticated
        ? '<span class="firefox-session-label">Firefox session</span>'
        : '';
    const titleRow = displayTitle
        ? `<div class="item-title" title="${escapeAttr(displayTitle)}">${escapeHtml(displayTitle)}${authenticatedLabel}${renameSurfaceStatus(info)}</div>`
        : '';
    const tagRow = renderTagControl(info);

    return `
                <div class="history-item" data-row-id="${id}">
                    <div class="row-actions">${actions}</div>
                    ${titleRow}
                    ${renderFavoriteControl(info, true)}
                    ${tagRow}
                    ${bottom}
                    ${downloadSummaryRow}
                    ${uploadStatusSlot(id)}
                    ${downloadCommandStatusSlot(id)}
                    ${removalStatusSlot(id)}
                    ${errorBlock}
                </div>
            `;
}

const DEFAULT_HISTORY_PAGE_SIZE = 10;
const HISTORY_PAGE_SIZES = new Set([5, 10, 20, 50]);
const HISTORY_ENDLESS_MODE = 'endless';
const HISTORY_ENDLESS_BATCH_SIZE = 10;
const HISTORY_ENDLESS_PREFETCH_MARGIN = 160;
const ENDLESS_PLAYBACK_PAGE_SIZE = 100;
let historyPageSize = DEFAULT_HISTORY_PAGE_SIZE;
let historyPage = 0;
let historyTotal = 0;
let historyEndlessVisibleCount = HISTORY_ENDLESS_BATCH_SIZE;
let historyEndlessLoadPending = false;
let historyOrderIds = [];
let historyOrdering = 'favorites_first';
let historyPageItems = [];
let _renderedActiveIds  = new Set();
let _renderedHistoryIds = new Set();
const pendingActiveAnimations = new Set();
const pendingHistoryAnimations = new Set();
let libraryView = 'history';
let duplicatesRequest = 0;

let attemptHistoryOpen = false;
let attemptPage = 1;
let attemptRequest = 0;
let attemptSnapshotVersion = 0;
let libraryScrollPosition = 0;
let attemptScrollPosition = 0;
const attemptRows = new Map();

function openAttemptHistory() {
    closeAccountMenu();
    closeHistoryInfo();
    closeAllMenus();
    if (!attemptHistoryOpen) libraryScrollPosition = window.scrollY;
    attemptHistoryOpen = true;
    document.getElementById('settingsPage').hidden = true;
    document.body.classList.remove('settings-open');
    document.body.classList.add('history-open');
    document.getElementById('tab-history').hidden = true;
    scheduleAssetDemand();
    document.getElementById('attemptHistoryPage').hidden = false;
    window.scrollTo({ top: attemptScrollPosition });
    document.getElementById('attemptHistoryTitle').focus({ preventScroll: true });
    setLibraryView(libraryView);
}

function closeAttemptHistory() {
    attemptScrollPosition = window.scrollY;
    attemptHistoryOpen = false;
    ++attemptRequest;
    document.getElementById('attemptHistoryPage').hidden = true;
    document.getElementById('tab-history').hidden = false;
    scheduleAssetDemand({ reconcile: true });
    document.body.classList.remove('history-open');
    window.scrollTo({ top: libraryScrollPosition });
    document.getElementById('accountMenuButton').focus({ preventScroll: true });
}

function attemptRowHtml(info) {
    const statusLabels = {
        starting: 'Starting', downloading: 'Downloading', paused: 'Paused',
        finished: 'Finished', error: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
    };
    const sourceLabels = { url: 'URL', companion: 'Companion', upload: 'Upload', mounted_import: 'Mounted import' };
    let host = '';
    try { host = new URL(info.source_reference).host; } catch (_error) { }
    const active = ACTIVE_PROGRESS_STATUSES.has(info.status);
    const timing = `Started ${formatDateTime(info.started_at)} · ${info.ended_at
        ? `Completed ${formatDateTime(info.ended_at)}`
        : `Elapsed ${formatDuration(info.started_at, Date.now() / 1000)}`}`;
    let result = info.error_summary || ({ cancelled: 'Stopped by user', interrupted: 'Work was interrupted' }[info.status]) || '';
    if (info.status === 'finished') {
        result = [info.filename, formatBytes(info.filesize), info.resolution,
            info.library_id ? '' : info.media_state === 'removed' ? 'Media removed' : 'File unavailable',
        ].filter(Boolean).join(' · ');
    } else if (active) {
        result = [info.progress, formatSpeed(info.speed), info.eta == null ? '' : `ETA ${formatEta(info.eta)}`].filter(Boolean).join(' · ');
    }
    const image = info.library_id
        ? assetImage(info.library_id, 'class="attempt-thumbnail" loading="lazy"')
        : '<span class="attempt-placeholder" aria-hidden="true"><svg><use href="#i-download"/></svg></span>';
    const action = (name, label) => `<button type="button" data-attempt-action="${name}" data-attempt-id="${escapeAttr(info.id)}">${label}</button>`;
    return `${image}<div class="attempt-copy">
        <div class="attempt-title"><strong>${escapeHtml(info.title || info.filename || 'Untitled attempt')}</strong><span class="attempt-status">${escapeHtml(statusLabels[info.status] || info.status)}</span></div>
        <div class="attempt-source">${escapeHtml([sourceLabels[info.source_type] || info.source_type, host].filter(Boolean).join(' · '))}${info.legacy ? ' · Legacy record' : ''}</div>
        <div class="attempt-timing">${escapeHtml(timing)}</div>
        <div class="attempt-result">${escapeHtml(result)}</div>
        <div class="attempt-actions">${info.library_id ? action('library', 'View in Library') : ''}${info.can_resume ? action('resume', 'Resume') : ''}${info.can_retry ? action('retry', 'Retry') : ''}${info.source_reference ? action('copy', 'Copy source URL') : ''}</div>
        ${info.download_id ? downloadCommandStatusSlot(info.download_id, info.id) : ''}
        <details><summary>Details</summary><div class="attempt-details">${escapeHtml([info.source_reference, info.error_details].filter(Boolean).join('\n') || 'No additional details.')}</div></details>
    </div>`;
}

let attemptIntent = '';
function fetchAttemptHistory() {
    const intent = JSON.stringify([attemptPage, document.getElementById('attemptSearchInput').value, libraryView]);
    if (intent !== attemptIntent) {
        ++attemptRequest;
        attemptIntent = intent;
    }
    return coordinateRefresh('attempts', loadAttemptHistory);
}

async function loadAttemptHistory() {
    if (!attemptHistoryOpen || libraryView === 'duplicates') return;
    const generation = attemptRequest;
    const epoch = tagSessionEpoch;
    const filter = document.getElementById('attemptSearchInput').value;
    try {
        const response = await apiFetch(`/api/history?${new URLSearchParams({ filter, page: attemptPage, page_size: 20 })}`);
        if (!response.ok) throw new Error('Could not load download history.');
        const data = await response.json();
        if (epoch !== tagSessionEpoch || generation !== attemptRequest || !attemptHistoryOpen) return;
        renderAttemptHistorySnapshot(data, filter);
    } catch (_error) {
        if (epoch === tagSessionEpoch && generation === attemptRequest) document.getElementById('attemptHistoryStatus').textContent = 'Could not load download history. Try again.';
    }
}

function renderAttemptHistorySnapshot(data, filter) {
    attemptSnapshotVersion++;
    attemptPage = data.page;
    const list = document.getElementById('attemptHistoryList');
    const retained = new Set();
    const items = data.items.filter(info => !bulkRemovedAttemptIds.has(info.id));
    const clear = bulkClears.get('history');
    if (bulkClearPending('history') && clear.page === data.page && clear.filter === filter) {
        const ids = new Set(items.map(info => info.id));
        for (const [id, record] of clear.rows) if (!ids.has(id) && !bulkRemovedAttemptIds.has(id)) items.push(record.info);
    }
    for (const info of items) {
        if (info.download_id && tagState.isFenced(String(info.download_id))) { info.media_state = 'removed'; info.library_id = null; info.can_retry = false; info.can_resume = false; }
        if (info.download_id && typeof info.command_revision === 'string') tagState.acceptDownload({ id: info.download_id, command_revision: info.command_revision, current_attempt_id: info.current_attempt_id });
        retained.add(info.id);
        let row = document.getElementById(`attempt-${info.id}`);
        if (!row) {
            row = document.createElement('article');
            row.id = `attempt-${info.id}`;
            row.className = 'attempt-row';
            row.tabIndex = -1;
        }
        const html = attemptRowHtml(info);
        if (attemptRows.get(info.id)?.html !== html) {
            const opened = row.querySelector('details')?.open;
            const focused = row.contains(document.activeElement) ? document.activeElement : null;
            const focusedAction = focused?.dataset.attemptAction;
            const focusedSummary = focused?.tagName === 'SUMMARY';
            row.innerHTML = html;
            row.querySelector('details').open = Boolean(opened);
            const thumbnail = row.querySelector('img');
            if (thumbnail) thumbnail.addEventListener('error', () => {
                const placeholder = document.createElement('span');
                placeholder.className = 'attempt-placeholder';
                placeholder.setAttribute('aria-hidden', 'true');
                thumbnail.replaceWith(placeholder);
            }, { once: true });
            if (focusedAction) (row.querySelector(`[data-attempt-action="${focusedAction}"]`) || row).focus({ preventScroll: true });
            else if (focusedSummary) row.querySelector('summary').focus({ preventScroll: true });
        }
        attemptRows.set(info.id, { info, html });
        // Insert only when order changes: moving a focused node can blur it.
        const position = [...retained].length - 1;
        if (list.children[position] !== row) list.insertBefore(row, list.children[position] || null);
    }
    for (const row of [...list.children]) {
        const id = row.id.slice('attempt-'.length);
        if (!retained.has(id)) {
            if (row.contains(document.activeElement)) document.getElementById('attemptHistoryTitle').focus({ preventScroll: true });
            row.remove();
            attemptRows.delete(id);
        }
    }
    document.getElementById('attemptHistoryStatus').textContent = data.total
        ? `${data.total} ${data.total === 1 ? 'attempt' : 'attempts'}`
        : filter.trim() ? 'No attempts match this filter.' : 'No download attempts yet.';
    document.getElementById('attemptPageInfo').textContent = `Page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.page_size))} · ${data.total} attempts`;
    document.getElementById('attemptPagePrev').disabled = data.page <= 1;
    document.getElementById('attemptPageNext').disabled = data.page * data.page_size >= data.total;
    refreshDownloadCommandPresentations();
}

const attemptSearch = document.getElementById('attemptSearch');
const attemptSearchInput = document.getElementById('attemptSearchInput');
function expandAttemptSearch(expanded) {
    attemptSearch.classList.toggle('expanded', expanded);
    document.getElementById('attemptSearchToggle').setAttribute('aria-expanded', String(expanded));
}
function applyAttemptFilter() {
    attemptPage = 1;
    document.getElementById('attemptSearchClear').hidden = !attemptSearchInput.value;
    fetchAttemptHistory();
}
document.getElementById('attemptSearchToggle').addEventListener('click', () => {
    const expanded = !attemptSearch.classList.contains('expanded');
    expandAttemptSearch(expanded);
    if (expanded) attemptSearchInput.focus();
});
attemptSearchInput.addEventListener('input', applyAttemptFilter);
attemptSearchInput.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    attemptSearchInput.value = '';
    applyAttemptFilter();
    expandAttemptSearch(false);
    document.getElementById('attemptSearchToggle').focus();
});
document.getElementById('attemptSearchClear').addEventListener('click', () => {
    attemptSearchInput.value = '';
    applyAttemptFilter();
    attemptSearchInput.focus();
});
document.getElementById('attemptPagePrev').addEventListener('click', () => { attemptPage--; fetchAttemptHistory(); });
document.getElementById('attemptPageNext').addEventListener('click', () => { attemptPage++; fetchAttemptHistory(); });
document.getElementById('attemptHistoryList').addEventListener('click', async event => {
    const button = event.target.closest('[data-attempt-action]');
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    const info = attemptRows.get(button.dataset.attemptId)?.info;
    if (!info) return;
    const action = button.dataset.attemptAction;
    if (action === 'copy') { copyToClipboard(info.source_reference, button); return; }
    if (action === 'library') { showDuplicateHistoryItem(info.library_id); return; }
    submitDownloadCommand(action, info.download_id, info.id);
});
document.querySelector('#attemptHistoryPage [role="tablist"]').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    tabs[next].focus();
});

function setLibraryView(view) {
    if (view === 'logs' && !document.getElementById('logsViewButton')) view = 'history';
    libraryView = view;
    for (const [name, buttonId, panelId] of [
        ['history', 'historyViewButton', 'attemptHistoryMain'],
        ['duplicates', 'duplicatesViewButton', 'duplicatesPanel'],
        ['logs', 'logsViewButton', 'systemLogsPanel'],
    ]) {
        const button = document.getElementById(buttonId);
        if (!button) continue;
        const active = name === view;
        document.getElementById(panelId).hidden = !active;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
    }
    if (view === 'duplicates') fetchDuplicates();
    else if (view === 'logs') fetchSystemLogs();
    else fetchAttemptHistory();
}

let systemLogPage = 1;
let systemLogSnapshot = null;
let systemLogRequest = 0;
let systemLogsLoaded = false;

function systemLogsVisible() {
    return attemptHistoryOpen && libraryView === 'logs'
        && Boolean(document.getElementById('logsViewButton'));
}

function maintenanceStatusText(data) {
    const campaign = data.campaign || data;
    const counts = campaign.counters || campaign;
    const state = campaign.state || campaign.status || 'idle';
    if (state === 'idle' || campaign.id === null) return 'No preview cache updates are pending.';
    const labels = {
        scanning: 'Scanning Library; total not yet known',
        discovering: 'Scanning Library; total not yet known',
        running: 'Updating cached preview sequences',
        active: 'Updating cached preview sequences',
        paused: 'Preview cache updates paused for shutdown',
        interrupted: 'Previous preview update run was interrupted',
        completed: 'Finished updating cached preview sequences',
        completed_with_warnings: 'Cached preview update pass finished with warnings',
        superseded: 'Preview cache update pass superseded',
    };
    const summary = [`${Number(counts.updated) || 0} updated`, `${Number(counts.left) || 0} left`];
    if (counts.failed) summary.push(`${counts.failed} failed`);
    if (counts.skipped) summary.push(`${counts.skipped} skipped`);
    if (campaign.discovery_complete === false || campaign.discovery_done === false) {
        return `Scanning Library; total not yet known. ${summary.join(', ')}.`;
    }
    return `${labels[state] || 'Preview cache updates'}: ${summary.join(', ')}.`;
}

function logDateTime(value) {
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function renderSystemLogEntries(items) {
    const list = document.getElementById('systemLogsList');
    const previous = new Map([...list.children].map(node => [node.dataset.logId, node]));
    items.forEach((entry, index) => {
        const id = String(entry.id);
        let row = previous.get(id);
        if (!row) {
            row = document.createElement('li');
            row.className = 'system-log-entry';
            row.dataset.logId = id;
            const meta = document.createElement('div');
            meta.className = 'system-log-meta';
            const time = document.createElement('time');
            const date = logDateTime(entry.created_at ?? entry.timestamp);
            if (date) {
                time.dateTime = date.toISOString();
                time.textContent = date.toLocaleString();
            } else time.textContent = 'Time unavailable';
            const severity = document.createElement('span');
            severity.className = 'system-log-severity';
            const levels = { info: 'Info', warning: 'Warning', error: 'Error' };
            severity.textContent = levels[entry.severity] || entry.severity;
            const component = document.createElement('span');
            component.textContent = entry.component === 'preview_cache' ? 'Preview cache' : entry.component;
            meta.append(time, severity, component);
            const message = document.createElement('p');
            message.textContent = entry.message;
            row.append(meta, message);
        }
        // Retain unchanged nodes so incoming hints preserve text selection.
        if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
        previous.delete(id);
    });
    for (const row of previous.values()) row.remove();
}

function fetchSystemLogs() {
    if (!systemLogsVisible()) return;
    return coordinateRefresh('systemLogs', loadSystemLogs);
}

async function loadSystemLogs() {
    if (!systemLogsVisible()) return;
    const generation = ++systemLogRequest;
    const page = systemLogPage;
    const filter = document.getElementById('systemLogFilter').value;
    const severity = document.getElementById('systemLogSeverity').value;
    const query = new URLSearchParams({ page, page_size: 50, filter, severity });
    // New events may appear while reading an older page. An upper event ID
    // keeps the page's entries and their selection stable across reconciliation.
    if (page > 1 && systemLogSnapshot !== null) query.set('snapshot_id', systemLogSnapshot);
    const status = document.getElementById('systemLogsStatus');
    const list = document.getElementById('systemLogsList');
    list.setAttribute('aria-busy', 'true');
    if (!systemLogsLoaded) status.textContent = 'Loading system logs…';
    try {
        const [logsResponse, maintenanceResponse] = await Promise.all([
            apiFetch('/api/system/logs?' + query), apiFetch('/api/preview-maintenance'),
        ]);
        if (!logsResponse.ok || !maintenanceResponse.ok) throw new Error('Could not load system logs.');
        const [data, maintenance] = await Promise.all([logsResponse.json(), maintenanceResponse.json()]);
        if (generation !== systemLogRequest || !systemLogsVisible()) return;
        systemLogPage = data.page;
        if (data.snapshot_id !== undefined) systemLogSnapshot = data.snapshot_id;
        renderSystemLogEntries(data.items);
        systemLogsLoaded = true;
        document.getElementById('previewMaintenanceStatus').textContent = maintenanceStatusText(maintenance);
        status.textContent = data.total ? `${data.total} ${data.total === 1 ? 'entry' : 'entries'}`
            : filter.trim() || severity ? 'No system logs match these filters.' : 'No system logs yet.';
        document.getElementById('systemLogPageInfo').textContent = `Page ${data.page} of ${data.pages || Math.max(1, Math.ceil(data.total / data.page_size))}`;
        document.getElementById('systemLogPrev').disabled = data.page <= 1;
        document.getElementById('systemLogNext').disabled = data.page * data.page_size >= data.total;
    } catch (_error) {
        if (generation === systemLogRequest && systemLogsVisible()) {
            status.textContent = 'Could not load system logs. Use Refresh logs to try again.';
        }
    } finally {
        if (generation === systemLogRequest) list.setAttribute('aria-busy', 'false');
    }
}

function changeSystemLogFilter() {
    systemLogPage = 1;
    systemLogSnapshot = null;
    systemLogsLoaded = false;
    ++systemLogRequest;
    document.getElementById('systemLogsList').replaceChildren();
    fetchSystemLogs();
}

document.getElementById('logsViewButton')?.addEventListener('click', () => setLibraryView('logs'));
document.getElementById('systemLogFilter')?.addEventListener('input', changeSystemLogFilter);
document.getElementById('systemLogSeverity')?.addEventListener('change', changeSystemLogFilter);
document.getElementById('systemLogsRefresh')?.addEventListener('click', fetchSystemLogs);
document.getElementById('systemLogPrev')?.addEventListener('click', () => { ++systemLogRequest; systemLogPage--; fetchSystemLogs(); });
document.getElementById('systemLogNext')?.addEventListener('click', () => { ++systemLogRequest; systemLogPage++; fetchSystemLogs(); });
window.addEventListener('focus', fetchSystemLogs);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchSystemLogs(); });

function duplicateSourceLabel(info) {
    if (info.mounted_import) return 'Mounted import';
    if (info.source_type === 'upload') return 'Local upload';
    return 'URL download';
}

function renderDuplicateMember(info) {
    info = projectTagEntry(info);
    const id = String(info.id);
    const name = displayFilename(info);
    const title = info.title || name.replace(/\.[^.]+$/, '') || 'Untitled download';
    const tags = Array.isArray(info.tags) ? info.tags : [];
    const details = [duplicateSourceLabel(info), info.resolution, formatBytes(info.filesize)]
        .filter(Boolean).map(value => `<span>${escapeHtml(value)}</span>`).join('');
    return `<article class="duplicate-member" data-duplicate-id="${escapeAttr(id)}">
                ${assetImage(id, 'loading="lazy"')}
                <div class="duplicate-member-detail">
                    <div class="duplicate-member-title">${escapeHtml(title)}</div>
                    <div class="duplicate-member-filename"><span data-rename-filename="${escapeAttr(id)}">${escapeHtml(name)}</span>${renameSurfaceStatus(info)}</div>
                    <div class="duplicate-member-meta">${details}</div>
                    ${tags.length ? `<div class="tag-row">${tags.map(tag => tagChipHtml(tag, false)).join('')}</div>` : ''}
                    <a class="duplicate-history-link" href="#history-item-${escapeAttr(id)}" data-duplicate-history-link="${escapeAttr(id)}">View in Library</a>
                </div>
            </article>`;
}

function renderDuplicates(data) {
    const groups = Array.isArray(data.groups) ? data.groups : [];
    const pending = Math.max(0, Number(data.pending_count) || 0);
    const unavailable = Math.max(0, Number(data.unavailable_count) || 0);
    const count = groups.length;
    const summary = `${count} confirmed ${count === 1 ? 'group' : 'groups'} · ${pending} pending · ${unavailable} unavailable`;
    document.getElementById('duplicatesStatus').textContent = summary;
    document.getElementById('duplicatesList').innerHTML = groups.length
        ? groups.map(group => {
            const items = Array.isArray(group.items) ? group.items : [];
            const byteSize = formatBytes(group.byte_size) || 'Unknown size';
            return `<section class="duplicate-group">
                        <h3>${items.length} ${items.length === 1 ? 'item' : 'items'} · ${escapeHtml(byteSize)} each</h3>
                        <div class="duplicate-members">${items.map(renderDuplicateMember).join('')}</div>
                    </section>`;
        }).join('')
        : `<p class="history-empty">${pending || unavailable
            ? 'No confirmed duplicates yet. Some files are still pending or unavailable for indexing.'
            : 'No duplicate media found.'}</p>`;
}

function fetchDuplicates() {
    return coordinateRefresh('duplicates', loadDuplicates);
}

async function loadDuplicates() {
    if (libraryView !== 'duplicates') return;
    const request = ++duplicatesRequest;
    try {
        const response = await apiFetch('/api/duplicates');
        if (!response.ok) throw new Error('Could not load duplicate media.');
        const data = await response.json();
        if (request === duplicatesRequest && libraryView === 'duplicates') {
            renderDuplicates(data);
        }
    } catch (_error) {
        if (request === duplicatesRequest && libraryView === 'duplicates') {
            document.getElementById('duplicatesStatus').textContent =
                'Could not load duplicate media. Try again.';
        }
    }
}

async function showDuplicateHistoryItem(id) {
    closeAttemptHistory();
    const input = document.getElementById('historySearchInput');
    input.value = '';
    document.getElementById('historySearchClear').hidden = true;
    searchTerms = [];
    await fetchHistory();
    const index = historyOrderIds.indexOf(String(id));
    if (index < 0) return;
    if (endlessHistoryEnabled()) {
        historyEndlessVisibleCount = Math.max(historyEndlessVisibleCount, index + 1);
    } else {
        historyPage = Math.floor(index / historyPageSize);
    }
    await fetchHistory();
    const card = document.getElementById(`history-item-${id}`);
    if (card) card.scrollIntoView({ block: 'center' });
}

document.getElementById('historyViewButton').addEventListener('click', () => setLibraryView('history'));
document.getElementById('duplicatesViewButton').addEventListener('click', () => setLibraryView('duplicates'));
document.getElementById('duplicatesList').addEventListener('click', event => {
    const link = event.target.closest('[data-duplicate-history-link]');
    if (!link) return;
    event.preventDefault();
    showDuplicateHistoryItem(link.dataset.duplicateHistoryLink);
});
document.getElementById('duplicatesRefresh').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const response = await apiFetch('/api/duplicates/refresh', { method: 'POST' });
        if (!response.ok) throw new Error('Could not start the duplicate index refresh.');
        document.getElementById('duplicatesStatus').textContent = 'Refreshing duplicate index…';
        await fetchDuplicates();
    } catch (_error) {
        document.getElementById('duplicatesStatus').textContent =
            'Could not start the duplicate index refresh. Try again.';
    } finally {
        button.disabled = false;
    }
});

let historyRefreshError = '';

function updateHistoryEmptyState() {
    if (!libraryLoaded && !historyRefreshError) {
        document.getElementById('historyEmptyTitle').textContent = 'Loading Library…';
        document.getElementById('historyEmptyMessage').textContent = 'Fetching your downloads.';
        document.getElementById('historyEmptyAction').hidden = true;
        document.getElementById('historyEmpty').style.display = '';
        return;
    }
    if (historyRefreshError) {
        document.getElementById('historyEmptyTitle').textContent = 'Could not load downloads';
        document.getElementById('historyEmptyMessage').textContent = historyRefreshError;
        document.getElementById('historyEmptyAction').hidden = true;
        document.getElementById('historyEmpty').style.display =
            historyTotal || visiblePlaylistCount ? 'none' : '';
        return;
    }
    const hasFilter = searchTerms.length > 0;
    const playlistValues = searchPlaylistValues();
    const playlistOnly = playlistValues.includes('yes')
        && !playlistValues.includes('no');
    document.getElementById('historyEmptyTitle').textContent = playlistOnly
        ? 'No matching playlists'
        : hasFilter
            ? 'No matching downloads'
            : 'No downloads yet';
    document.getElementById('historyEmptyMessage').textContent = playlistOnly
        ? 'No playlists contain videos matching these search terms.'
        : hasFilter
            ? 'No download history matches these search terms.'
            : 'Add a video URL or drop a local video here to get started.';
    const emptyRotation = !hasFilter && libraryOrder.kind === 'rotation'
        && collectionSnapshots.library.length === 0;
    if (emptyRotation) {
        document.getElementById('historyEmptyTitle').textContent = 'No videos in the current rotation.';
        document.getElementById('historyEmptyMessage').textContent = 'New videos join the next rotation.';
    }
    document.getElementById('historyEmptyAction').hidden = hasFilter || emptyRotation;
    document.getElementById('historyEmpty').style.display =
        emptyRotation ? '' : historyTotal || visiblePlaylistCount ? 'none' : '';
}

function endlessHistoryEnabled() {
    return historyPageSize === HISTORY_ENDLESS_MODE;
}

async function loadNextEndlessHistoryBatch() {
    if (!endlessHistoryEnabled() || historyEndlessLoadPending
            || historyEndlessVisibleCount >= historyTotal) return;
    historyEndlessLoadPending = true;
    try {
        // A scroll/observer trigger can arrive after Library renders but before
        // Current Downloads finishes refreshing. Recheck after each batch so
        // that trigger is not lost behind the pending-load guard.
        while (endlessHistoryEnabled() && historyEndlessVisibleCount < historyTotal) {
            // Entrance animations temporarily collapse the library. Wait for its
            // layout to settle, including any cards added by a concurrent refresh.
            while (true) {
                const animations = document.getElementById('historyList')
                    .getAnimations({ subtree: true })
                    .filter(animation => animation.animationName === 'item-fade-in'
                        && animation.playState !== 'finished');
                if (!animations.length) break;
                await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
            }
            // Observer entries describe an earlier frame; navigation and animation
            // completion can both move the sentinel before this callback resumes.
            if (!endlessHistoryEnabled() || historyEndlessVisibleCount >= historyTotal
                    || !historyEndlessSentinel.getClientRects().length) return;
            const bounds = historyEndlessSentinel.getBoundingClientRect();
            if (bounds.top > window.innerHeight + HISTORY_ENDLESS_PREFETCH_MARGIN
                    || bounds.bottom < 0) return;
            historyEndlessVisibleCount = Math.min(
                historyTotal,
                historyEndlessVisibleCount + HISTORY_ENDLESS_BATCH_SIZE,
            );
            await fetchHistory();
        }
    } finally {
        historyEndlessLoadPending = false;
    }
}

const historyEndlessSentinel = document.getElementById('historyEndlessSentinel');
if ('IntersectionObserver' in window) {
    const historyEndlessObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
            loadNextEndlessHistoryBatch();
        }
    }, { rootMargin: `0px 0px ${HISTORY_ENDLESS_PREFETCH_MARGIN}px` });
    historyEndlessObserver.observe(historyEndlessSentinel);
} else {
    window.addEventListener('scroll', loadNextEndlessHistoryBatch, { passive: true });
}

function animateInsertedItem(element, pendingAnimations, id) {
    // Hidden collections have no layout to measure. Animating them from a
    // zero-height target on return can expose the endless-scroll sentinel.
    if (!element.getClientRects().length) {
        pendingAnimations.delete(id);
        return;
    }
    // A second collection can reconcile before animationstart; the retained
    // node already owns its natural height and must not measure its collapse.
    if (element.classList.contains('item-fade-in')) return;
    // Rows vary with their metadata, so animate toward the natural box size
    // instead of leaving every completed row under a guessed height limit.
    const style = getComputedStyle(element);
    element.style.setProperty('--item-expanded-height', `${element.getBoundingClientRect().height}px`);
    element.style.setProperty('--item-expanded-padding-top', style.paddingTop);
    element.style.setProperty('--item-expanded-padding-bottom', style.paddingBottom);
    element.style.setProperty('--item-expanded-margin-bottom', style.marginBottom);
    element.style.setProperty('--item-expanded-border-top-width', style.borderTopWidth);
    element.style.setProperty('--item-expanded-border-bottom-width', style.borderBottomWidth);
    pendingAnimations.add(id);
    element.classList.add('item-fade-in');

    const started = event => {
        if (event.target !== element || event.animationName !== 'item-fade-in') return;
        pendingAnimations.delete(id);
        element.removeEventListener('animationstart', started);
    };
    const finish = event => {
        if (event.target !== element || event.animationName !== 'item-fade-in') return;
        pendingAnimations.delete(id);
        element.removeEventListener('animationstart', started);
        element.removeEventListener('animationend', finish);
        element.classList.remove('item-fade-in');
        for (const property of [
            '--item-expanded-height',
            '--item-expanded-padding-top',
            '--item-expanded-padding-bottom',
            '--item-expanded-margin-bottom',
            '--item-expanded-border-top-width',
            '--item-expanded-border-bottom-width',
        ]) {
            element.style.removeProperty(property);
        }
    };
    element.addEventListener('animationstart', started);
    element.addEventListener('animationend', finish);
}

function changePage(delta) {
    if (endlessHistoryEnabled()) return;
    const maxPage = Math.max(0, Math.ceil(historyTotal / historyPageSize) - 1);
    const next = Math.min(maxPage, Math.max(0, historyPage + delta));
    if (next === historyPage) return;
    historyPage = next;
    fetchHistory();
}

function goToPage(target) {
    if (endlessHistoryEnabled()) return;
    const maxPage = Math.max(0, Math.ceil(historyTotal / historyPageSize) - 1);
    const next = Math.min(maxPage, Math.max(0, target));
    if (next === historyPage) return;
    historyPage = next;
    fetchHistory();
}

function fetchHistory({ sortFavorites = false } = {}) {
    requestedFavoriteSort ||= sortFavorites;
    if (historyRefreshBlocked()) {
        historyFetchDeferred = true;
        historyFavoriteSortDeferred ||= sortFavorites;
        return Promise.resolve();
    }
    updateHistoryEmptyState();
    return Promise.all([fetchDownloadCollection('library'), fetchDownloadCollection('current')]);
}

async function checkTagAvailability(id, { authoritative = false } = {}) {
    if (checkingTagAvailability.has(id)) return;
    checkingTagAvailability.add(id);
    if (tagState.selectDownload(String(id))?.visibility_revision || visibilityIntent(id)) visibilityMutationMetrics.reconciliationReads++;
    const epoch = tagSessionEpoch;
    const context = tagState.capture();
    mutationMetrics.reconciliationReads++;
    try {
        const response = await apiFetch(`/api/downloads/${encodeURIComponent(id)}/editable-state`);
        if (epoch !== tagSessionEpoch) return;
        if ([403, 404].includes(response.status)) tagMutations.fence(id);
        else if (response.ok) {
            const snapshot = await response.json();
            if (epoch !== tagSessionEpoch) return;
            const known = tagState.writer.confirmed(String(id));
            // Collections expose public basenames. A targeted read can arrive
            // first; its physical path must not poison equal-revision merges.
            const current = typeof snapshot.filename === 'string'
                    && (!known || typeof known.filename !== 'string' || !/[/\\]/.test(known.filename))
                ? { ...snapshot, filename: snapshot.display_filename || snapshot.filename.split('/').pop().split('\\').pop() }
                : snapshot;
            if (tagState.acceptDownload(current, { ...context, authoritative })) {
                unavailableTagIds.delete(id);
            }
        }
    } catch (_) { /* Absence from a collection alone does not establish deletion. */ }
    finally { checkingTagAvailability.delete(id); }
}

function checkMissingTagTargets(previous, next) {
    const present = new Set(next.map(info => String(info.id)));
    for (const id of present) {
        // Collection membership can suggest restored access; only a fresh,
        // authorized targeted read may lift an existing availability fence.
        if (unavailableTagIds.has(id)) checkTagAvailability(id, { authoritative: true });
    }
    for (const entry of previous) {
        const id = String(entry.id);
        if (present.has(id) || removalIntent(id)) continue;
        const model = tagState.selectDownload(id);
        if (!model?.visibility_revision && !model?.visibility_intents.length && !compatibilityVisibility.has(id) && !model?.tag_chips.some(chip => chip.status !== 'confirmed') && !model?.favorite_intents.length && !model?.rename_intents.length && !model?.command_intents.length && !compatibilityCommands.has(id) && !compatibilityRenames.has(id) && !renameDrafts.has(id) && !editingTagIds.has(id)) continue;
        checkTagAvailability(id);
    }
}

function recoverUnconfirmedTags() {
    for (const entry of tagMutations.pending().filter(entry => (entry.kind.startsWith('download.') || entry.kind === 'entry.remove') && entry.status === 'unconfirmed')) {
        if (recoveredTagIntents.has(entry.id)) continue;
        recoveredTagIntents.add(entry.id);
        tagMutations.recover(entry.id);
    }
    for (const intentId of submittedTagIntents) {
        if (recoveredTagIntents.has(intentId)) continue;
        if (tagMutations.status(intentId)?.status !== 'unconfirmed') continue;
        recoveredTagIntents.add(intentId);
        tagMutations.recover(intentId);
    }
}

function fetchDownloadCollection(key) {
    return coordinateRefresh(key, async () => {
        const requestEpoch = libraryRequestEpoch;
        const authEpoch = tagSessionEpoch;
        const tagContext = tagState.capture();
        tagMutationMetrics.reconciliationReads++;
        renameMutationMetrics.reconciliationReads++;
        favoriteMutationMetrics.reconciliationReads++;
        visibilityMutationMetrics.reconciliationReads++;
        mutationMetrics.reconciliationReads++;
        try {
            const snapshot = await readCollection(key === 'library'
                ? '/api/library?include_order=true' : '/api/current-downloads', { ordered: key === 'library' });
            if (authEpoch !== tagSessionEpoch || (key === 'library' && requestEpoch !== libraryRequestEpoch)) return;
            const previousEntries = collectionSnapshots[key];
            const data = key === 'library' ? snapshot.items : snapshot;
            if (key === 'library') {
                const changed = libraryOrder.kind !== snapshot.order.kind
                    || libraryOrder.generation_id !== snapshot.order.generation_id;
                if (changed && (historyRefreshBlocked() || renameDrafts.size || renameEditPositions.size || editingTagIds.size || favoriteEditPositions.size || removalPositions.size)) {
                    historyFetchDeferred = true;
                    return;
                }
                const complete = snapshot.order.kind === 'rotation'
                    ? await readCollection('/api/library-catalog') : data;
                if (authEpoch !== tagSessionEpoch || requestEpoch !== libraryRequestEpoch) return;
                if (changed && (historyRefreshBlocked() || renameDrafts.size || renameEditPositions.size || editingTagIds.size || favoriteEditPositions.size || removalPositions.size)) {
                    historyFetchDeferred = true;
                    return;
                }
                if (changed) {
                    historyPage = 0;
                    historyEndlessVisibleCount = HISTORY_ENDLESS_BATCH_SIZE;
                    historyOrderIds = [];
                    if (snapshot.order.kind === 'library') requestedFavoriteSort = true;
                }
                libraryOrder = snapshot.order;
                allLibraryEntries = complete;
                renderLibraryRotationStatus();
            }
            const removedCurrent = key === 'current' && collectionSnapshots.current.some(
                previous => !data.some(info => info.id === previous.id));
            acceptingTagSnapshots = true;
            try {
                for (const info of data) {
                    if (info.can_manage_upload === false && droppedUploads.get(String(info.id))?.registered) {
                        tagMutations.fence(String(info.id));
                        continue;
                    }
                    tagState.acceptDownload(info.upload && VDL.validUploadState(info.upload) ? { ...info, upload_revision: info.upload.revision } : info, tagContext);
                }
                if (key === 'library') for (const info of allLibraryEntries) tagState.acceptDownload(info, tagContext);
            } finally { acceptingTagSnapshots = false; }
            collectionSnapshots[key] = data;
            if (key === 'library') librarySnapshotVersion++;
            adoptServerUploads(data);
            checkMissingTagTargets(previousEntries, data);
            if (key === 'library') libraryLoaded = true;
            else currentLoaded = true;
            updateCollectionError(key);
            const sortFavorites = key === 'library' && requestedFavoriteSort;
            if (sortFavorites) requestedFavoriteSort = false;
            renderDownloadCollections({ sortFavorites });
            if (removedCurrent) {
                fetchDownloadCollection('library');
                fetchPlaylists();
            }
        } catch (error) {
            if (authEpoch !== tagSessionEpoch || error.name === 'AbortError' || (key === 'library' && requestEpoch !== libraryRequestEpoch)) return;
            const name = key === 'library' ? 'Library' : 'Current Downloads';
            updateCollectionError(key, `Could not refresh ${name}. ${error.message || 'Try again shortly.'}`);
            if (key === 'current') document.getElementById('currentEmpty').textContent = collectionErrors.get(key);
        }
    });
}

function renderDownloadCollections({ sortFavorites = false } = {}) {
    updateTagMutationSummary();
    updateDurationSearchFeedback();
    const collectionData = uploadCollectionData();
    const existingIds = new Set(collectionData.map(info => String(info.id)));
    const retainedPositions = new Map([...removalPositions, ...bulkLibraryRetainedPositions()]);
    for (const id of retainedPositions.keys()) {
        const confirmed = tagState.writer.confirmed(id);
        if (confirmed && !existingIds.has(id)) collectionData.push(confirmed);
    }
    const data = collectionData.filter(info => !unavailableTagIds.has(String(info.id)) && !tagState.isFenced(String(info.id))).map(projectTagEntry);
    const itemCount = document.getElementById('itemCount');
    itemCount.textContent = `${data.length} ${data.length === 1 ? 'item' : 'items'}`;
    if (historyRefreshBlocked()) {
        historyFetchDeferred = true;
        historyFavoriteSortDeferred ||= sortFavorites;
        return;
    }
    updateProgressIndicators(data);
    const active = data.filter(i => CURRENT_TAB_STATUSES.has(i.status));
    let historyEntries = data.filter(i => HISTORY_TAB_STATUSES.has(i.status));
    if (libraryOrder.kind === 'rotation') {
        const members = new Set(collectionSnapshots.library.map(info => String(info.id)));
        historyEntries = historyEntries.filter(info => members.has(String(info.id)) || retainedPositions.has(String(info.id)));
    }
    libraryEntries = libraryOrder.kind === 'rotation' ? allLibraryEntries.filter(info => !unavailableTagIds.has(String(info.id))).map(projectTagEntry) : historyEntries.slice();
    renderPlaylists();
    if (libraryOrder.kind === 'rotation') {
        const byId = new Map(historyEntries.map(info => [String(info.id), info]));
        historyEntries = collectionSnapshots.library.map(info => byId.get(String(info.id))).filter(Boolean).concat(historyEntries.filter(info => !collectionSnapshots.library.some(member => String(member.id) === String(info.id)) && retainedPositions.has(String(info.id))));
    } else if (sortFavorites) {
        historyOrdering = 'favorites_first';
        // The API is newest-first, and modern stable sorting preserves
        // that date order inside each favorite group.
        historyEntries = historyEntries.slice().sort(
            (left, right) => Number(Boolean(right.favorite))
                - Number(Boolean(left.favorite)));
    } else if (historyOrderIds.length) {
        // Reconciliation must not make a card jump when its star changes.
        // Newly completed downloads still enter first; known cards retain
        // the order last chosen by the user or by a filter execution.
        const knownIds = new Set(historyOrderIds);
        const byId = new Map(historyEntries.map(info => [String(info.id), info]));
        const unseen = historyEntries.filter(info => !knownIds.has(String(info.id)));
        const known = historyOrderIds.map(id => byId.get(id)).filter(Boolean);
        historyEntries = unseen.concat(known);
    }
    historyOrderIds = historyEntries.map(info => String(info.id));
    refreshAvailableTags(historyEntries);
    const done = historyEntries.filter(info => matchesSearchFilter(info) || editingTagIds.has(String(info.id)) || renameEditPositions.has(String(info.id)) || favoriteEditPositions.has(String(info.id)) || retainedPositions.has(String(info.id)));
    for (const [id, position] of new Map([...tagEditPositions, ...renameEditPositions, ...favoriteEditPositions, ...retainedPositions])) {
        const index = done.findIndex(info => String(info.id) === id);
        if (index < 0 || position < 0) continue;
        const [entry] = done.splice(index, 1);
        const offset = endlessHistoryEnabled() ? 0 : historyPage * historyPageSize;
        done.splice(Math.min(done.length, offset + position), 0, entry);
    }

    historyTotal = done.length;
    const endless = endlessHistoryEnabled();
    const maxPage = endless
        ? 0
        : Math.max(0, Math.ceil(historyTotal / historyPageSize) - 1);
    if (historyPage > maxPage) historyPage = maxPage;
    const start = endless ? 0 : historyPage * historyPageSize;
    const visibleCount = endless ? historyEndlessVisibleCount : historyPageSize;
    const pageItems = done.slice(start, start + visibleCount);
    historyPageItems = pageItems;
    const sequentialAvailable = pageItems.some(
        info => info.status === 'finished' && info.filename,
    );
    const shuffleAvailable = libraryEntries.some(
        info => info.status === 'finished' && info.filename,
    );
    document.getElementById('playbackMenuPlayAll').disabled = !sequentialAvailable;
    document.getElementById('playbackMenuShuffle').disabled = !shuffleAvailable;
    document.getElementById('playbackMenuShuffleClips').disabled = !shuffleAvailable;
    renderRememberedPlaybackMode();
    document.getElementById('playbackModeToggle').disabled =
        !sequentialAvailable && !shuffleAvailable;
    if (document.getElementById('playbackModeToggle').disabled) {
        closePlaybackModeMenu();
    }

    let focusRestore = null;
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('rename-input')) {
        const wrap = ae.closest('.rename-wrap');
        if (wrap && wrap.dataset.renameId) {
            focusRestore = {
                id: wrap.dataset.renameId,
                selStart: ae.selectionStart,
                selEnd: ae.selectionEnd,
                value: ae.value,
            };
            const cur = renameDrafts.get(focusRestore.id);
            if (cur) cur.value = ae.value;
        }
    } else if (ae && ae.classList && ae.classList.contains('tag-entry-input')) {
        const shell = ae.closest('.tag-editor-shell');
        if (shell && shell.dataset.tagId) {
            focusRestore = {
                tagId: shell.dataset.tagId,
                selStart: ae.selectionStart,
                selEnd: ae.selectionEnd,
            };
            tagDrafts.set(focusRestore.tagId, ae.value);
        }
    }

    const currentDrawerVisible = document.getElementById('currentDownloadsDrawer').open;

    const newActiveIds  = new Set(active.map(i => String(i.id)));
    const newHistoryIds = new Set(pageItems.map(i => String(i.id)));
    // An SSE burst can replace a newly inserted node before animationstart.
    // Retry only that pre-start window; restarting an animation already in
    // progress makes successive reconciliations keep cards in motion.
    pendingActiveAnimations.forEach(id => {
        if (!newActiveIds.has(id)) pendingActiveAnimations.delete(id);
    });
    pendingHistoryAnimations.forEach(id => {
        if (!newHistoryIds.has(id)) pendingHistoryAnimations.delete(id);
    });

    reconcileCards(document.getElementById('activeList'), active, info => renderItem(info, false), 'data-row-id');
    reconcileCards(document.getElementById('historyList'), pageItems, info => renderItem(info, true), 'data-row-id');
    updateAssetViewport();
    refreshDownloadCommandPresentations();
    refreshRemovalPresentations();

    if (currentDrawerVisible) {
        newActiveIds.forEach(id => {
            if (!_renderedActiveIds.has(id) || pendingActiveAnimations.has(id)) {
                const el = document.querySelector(`#activeList [data-row-id="${id}"]`);
                if (el) animateInsertedItem(el, pendingActiveAnimations, id);
            }
        });
    }
    newHistoryIds.forEach(id => {
        if (!_renderedHistoryIds.has(id) || pendingHistoryAnimations.has(id)) {
            const el = document.querySelector(`#historyList [data-row-id="${id}"]`);
            if (el) animateInsertedItem(el, pendingHistoryAnimations, id);
        }
    });

    _renderedActiveIds  = newActiveIds;
    _renderedHistoryIds = newHistoryIds;

    bindRenameInputs();
    bindTagEditors();
    restoreOpenHistoryInfo();

    if (focusRestore) {
        const newInput = focusRestore.tagId
            ? document.querySelector(
                `.tag-editor-shell[data-tag-id="${CSS.escape(focusRestore.tagId)}"] .tag-entry-input`)
            : document.querySelector(
                `.rename-wrap[data-rename-id="${focusRestore.id}"] .rename-input`);
        if (newInput) {
            newInput.focus();
            try {
                newInput.setSelectionRange(
                    focusRestore.selStart, focusRestore.selEnd);
            } catch (e) { }
        }
    }

    document.getElementById('currentEmpty').textContent = collectionErrors.get('current')
        || (currentLoaded ? 'No current downloads.' : 'Loading Current Downloads…');
    document.getElementById('currentEmpty').style.display = active.length ? 'none' : '';
    updateHistoryEmptyState();

    const pager = document.getElementById('historyPager');
    historyEndlessSentinel.hidden = !endless || pageItems.length >= historyTotal;
    if (!endless && historyTotal > historyPageSize) {
        pager.style.display = '';
        document.getElementById('pagerInfo').textContent =
            `Page ${historyPage + 1} of ${maxPage + 1} · ${historyTotal} items`;
        document.getElementById('pagerPrev').disabled = historyPage <= 0;
        document.getElementById('pagerNext').disabled = historyPage >= maxPage;
        const showJump = maxPage >= 3;
        const first = document.getElementById('pagerFirst');
        const last = document.getElementById('pagerLast');
        first.style.display = showJump ? '' : 'none';
        last.style.display  = showJump ? '' : 'none';
        first.disabled = historyPage <= 0;
        last.disabled  = historyPage >= maxPage;
    } else {
        pager.style.display = 'none';
    }

    const badge = document.getElementById('currentBadge');
    const currentButton = document.getElementById('currentDownloadsButton');
    const currentLabel = `${active.length} ${active.length === 1 ? 'item' : 'items'}`;
    document.getElementById('currentDrawerCount').textContent = currentLabel;
    currentButton.hidden = active.length === 0;
    currentButton.setAttribute(
        'aria-label', active.length
            ? `Current downloads, ${currentLabel}`
            : 'Current downloads, no items',
    );
    badge.textContent = active.length;
    if (active.length) {
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
}

let playerMode = 'overlay';
let startVideosFullscreen = false;
let skipVideoEdges = false;
let playerStartedFullscreen = false;

// MIME types for <source type="..."> — tells the browser the codec upfront so
// it doesn't have to sniff, which is required for WEBM on some browsers.
const _VIDEO_MIME = {
    mp4: 'video/mp4', m4v: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    ogg: 'video/ogg', ogv: 'video/ogg',
    mov: 'video/quicktime',
    m4a: 'audio/mp4', mp3: 'audio/mpeg',
    opus: 'audio/ogg; codecs=opus',
    flac: 'audio/flac', wav: 'audio/wav',
};

const PLAYER_CONTROLS_IDLE_MS = 3000;
const PLAYER_HANDOFF_TIMEOUT_MS = 20_000;
const PLAYBACK_KEEPALIVE_MS = 5 * 60 * 1000;
const PLAYLIST_PROGRESS_SAVE_MS = 10 * 1000;
const MAX_AUTOMATIC_SKIPS = 10;
let playerControlsTimer = null;
let playerMediaCleanup = null;

const endlessPlayback = {
    active: false,
    mode: 'sequential',
    phase: 'idle',
    presentation: 'original',
    launchProvenance: 'original',
    epoch: 0,
    loadGeneration: 0,
    sessionId: null,
    sequence: 0,
    currentDownloadId: null,
    currentItem: null,
    advancePending: false,
    handoffInProgress: false,
    returnFullscreenNeeded: false,
    failureCount: 0,
    failedGeneration: null,
    watchdogTimer: null,
    keepaliveTimer: null,
    playlistId: null,
    playlistRevision: null,
    playlistQueue: [],
    playlistPosition: null,
    progressSequence: 0,
    progressTimer: null,
    lastSavedPosition: null,
    failedClipIds: new Set(),
    clipOccurrences: new Map(),
};

const PLAYER_PRELOAD_SECONDS = 10;
const PLAYER_FADE_SECONDS = 3;
let playerPreparation = null;
const playerMediaWaiting = new WeakSet();
const playerMediaTimes = new WeakMap();
const playerMediaProgressing = new WeakSet();

// Each media load owns its preference snapshot and original-timeline bounds.
// Keeping this on the element also preserves the incoming clock across a fade.
const playerBoundaries = new WeakMap();

// Listening choices belong to the page session, independently of fade gains.
const playerListening = { volume: 1, muted: false, rate: 1 };
let playerControlsReady = false;
let playerSeekDrag = null;
let playerSliderInteraction = false;
let playerReturnFocus = null;
let playerVolumeSupported = true;
let playerFullscreenRequest = 0;
let playerRepeatCurrent = false;
// Pointer activation leaves buttons focused without an ongoing interaction.
let playerPointerFocus = false;

function playerControl(id) { return document.getElementById(id); }
function playerIsOpen() { return playerControl('playerBackdrop').classList.contains('open'); }
function playerInFullscreen() {
    return Boolean(document.fullscreenElement && [playerControl('playerContainer'), playerControl('playerMediaStage'), playerControl('playerVideo')]
        .includes(document.fullscreenElement)) || endlessPlayback.presentation === 'webkit-fullscreen';
}
function playerClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const whole = Math.floor(seconds);
    const second = String(whole % 60).padStart(2, '0');
    const minutes = Math.floor(whole / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${second}`
        : `${minutes}:${second}`;
}
function playerSpokenTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return 'unavailable';
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole % 3600 / 60);
    const remaining = whole % 60;
    return [hours && `${hours} ${hours === 1 ? 'hour' : 'hours'}`,
        minutes && `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`,
        (!hours && !minutes || remaining) && `${remaining} ${remaining === 1 ? 'second' : 'seconds'}`]
        .filter(Boolean).join(' ');
}
function playerNavigationBusy() {
    return endlessPlayback.advancePending || Boolean(playerPreparation?.committing
        || playerPreparation?.starting || (playerPreparation?.response && !playerPreparation.fade));
}
function playerRecoveryActive() {
    return !playerControl('playerTransition').hidden
        && ['playerContinue', 'playerRetry', 'playerRestart', 'playerSkip', 'playerStopEndless',
            'playerPlaybackSettings'].some(id => !playerControl(id).hidden);
}
function adjacentPlaylistItem(direction) {
    if (endlessPlayback.playlistPosition === null) return null;
    for (let index = endlessPlayback.playlistPosition + direction;
        index >= 0 && index < endlessPlayback.playlistQueue.length; index += direction) {
        const item = endlessPlayback.playlistQueue[index];
        if (item.id && !item.unavailable) return item;
    }
    return null;
}
function playerCanSeek(video) {
    return Number.isFinite(video.duration) && video.duration > 0
        && video.readyState >= HTMLMediaElement.HAVE_METADATA && video.seekable.length > 0;
}
function syncPlayerControls() {
    if (!playerControlsReady || !playerIsOpen()) return;
    const video = playerControl('playerVideo');
    const paused = video.paused || video.ended;
    const play = playerControl('playerPlayPause');
    play.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    play.title = paused ? 'Play' : 'Pause';
    play.querySelector('use')?.setAttribute('href', paused ? '#i-play' : '#i-pause');
    play.disabled = playerRecoveryActive() || (endlessPlayback.active
        && ['opening', 'advancing', 'create-failed'].includes(endlessPlayback.phase));
    const repeat = playerControl('playerRepeat');
    repeat.setAttribute('aria-pressed', String(playerRepeatCurrent));
    repeat.disabled = play.disabled || (playerNavigationBusy() && !playerPreparation?.fade)
        || !endlessPlayback.currentItem;
    playerControl('playerTitle').textContent = currentPlayerDisplayTitle();
    const mode = playerControl('playerModeLabel');
    mode.textContent = endlessPlayback.active ? ({ sequential: 'Play All', shuffle: 'Shuffle',
        shuffle_clips: 'Shuffle Clips', playlist: 'Playlist' })[endlessPlayback.mode] || '' : '';
    mode.hidden = !mode.textContent;
    const seek = playerControl('playerSeek');
    if (playerSeekDrag && (playerSeekDrag.video !== video
            || playerSeekDrag.generation !== endlessPlayback.loadGeneration)) playerSeekDrag = null;
    const position = playerSeekDrag ? Number(seek.value) : video.currentTime;
    seek.disabled = !playerCanSeek(video) || playerRecoveryActive();
    for (const id of ['playerRewind', 'playerForward']) {
        playerControl(id).disabled = seek.disabled || play.disabled || playerNavigationBusy();
    }
    seek.max = Number.isFinite(video.duration) && video.duration > 0 ? String(video.duration) : '0';
    if (!playerSeekDrag) seek.value = Number.isFinite(position) ? String(position) : '0';
    seek.setAttribute('aria-valuetext', `${playerSpokenTime(position)} of ${playerSpokenTime(video.duration)}`);
    playerControl('playerTime').textContent = `${playerClock(position)} / ${playerClock(video.duration)}`;
    playerControl('playerVolume').value = String(Math.round(playerListening.volume * 100));
    playerControl('playerVolume').setAttribute('aria-valuetext', `${Math.round(playerListening.volume * 100)}%`);
    playerControl('playerVolume').disabled = !playerVolumeSupported;
    playerControl('playerVolumeHint').hidden = playerVolumeSupported;
    const mute = playerControl('playerMute');
    // Fade gain callbacks can briefly report a backend's implicit startup mute.
    // Its control represents the listening choice that the envelope restores.
    const muted = playerPreparation?.fade ? playerListening.muted : video.muted;
    mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    mute.title = muted ? 'Unmute' : 'Mute';
    mute.querySelector('use')?.setAttribute('href', muted ? '#i-muted' : '#i-volume');
    const speed = playerControl('playerSpeed');
    if (![...speed.options].some(option => option.value === String(video.playbackRate))) {
        for (const option of speed.querySelectorAll('[data-actual-rate]')) option.remove();
        const option = new Option(`${video.playbackRate}×`, String(video.playbackRate));
        option.dataset.actualRate = 'true';
        speed.add(option);
    }
    speed.value = String(video.playbackRate);
    const previous = playerControl('playerPrevious');
    const next = playerControl('playerNext');
    previous.hidden = !endlessPlayback.active || endlessPlayback.mode !== 'playlist';
    next.hidden = !endlessPlayback.active;
    const busy = playerNavigationBusy() || playerRecoveryActive() || !endlessPlayback.sessionId;
    previous.disabled = busy || !adjacentPlaylistItem(-1);
    next.disabled = busy || (endlessPlayback.mode === 'playlist' && !adjacentPlaylistItem(1));
    for (const button of playerControl('playlistQueueItems').querySelectorAll('button')) button.disabled = busy;
    const queueToggle = playerControl('playerQueueToggle');
    queueToggle.hidden = !endlessPlayback.active || endlessPlayback.mode !== 'playlist';
    queueToggle.setAttribute('aria-expanded', String(!playerControl('playlistQueue').hidden));
    queueToggle.setAttribute('aria-label', playerControl('playlistQueue').hidden ? 'Show playlist queue' : 'Hide playlist queue');
    const fullscreen = playerControl('playerFullscreen');
    const supported = Boolean((document.fullscreenEnabled !== false
        && (playerControl('playerContainer').requestFullscreen || video.requestFullscreen))
        || video.webkitEnterFullscreen);
    fullscreen.disabled = !supported;
    const fullscreenHint = playerControl('playerFullscreenHint');
    if (fullscreenHint) fullscreenHint.hidden = supported;
    fullscreen.setAttribute('aria-label', playerInFullscreen() ? 'Exit fullscreen' : 'Enter fullscreen');
    fullscreen.title = supported ? fullscreen.getAttribute('aria-label') : 'Fullscreen is unavailable in this browser';
    fullscreen.querySelector('use')?.setAttribute('href', playerInFullscreen() ? '#i-exit-fullscreen' : '#i-fullscreen');
}
function applyPlayerListening(video) {
    try { video.volume = playerListening.volume; } catch (_error) { playerVolumeSupported = false; }
    // WebKit restores the default mute state when a new source starts playing.
    video.defaultMuted = playerListening.muted;
    video.muted = playerListening.muted;
    try { video.defaultPlaybackRate = playerListening.rate; video.playbackRate = playerListening.rate; } catch (_error) { /* Retain the engine's accepted rate. */ }
}
function updatePlayerListening({ volume, muted, rate } = {}) {
    const active = playerControl('playerVideo');
    if (volume !== undefined) playerListening.volume = Math.max(0, Math.min(1, volume));
    if (muted !== undefined) playerListening.muted = muted;
    if (rate !== undefined) {
        try { active.playbackRate = rate; } catch (_error) { /* Read back the accepted value below. */ }
        playerListening.rate = active.playbackRate;
    }
    const preparation = playerPreparation;
    if (preparation?.fade) {
        preparation.baseVolume = playerListening.volume;
        preparation.muted = playerListening.muted;
        // The next envelope write must not interpret its old gain as user input.
        preparation.newVolume = NaN;
        preparation.incoming.defaultMuted = preparation.outgoing.defaultMuted = playerListening.muted;
        preparation.incoming.muted = preparation.outgoing.muted = playerListening.muted;
        preparation.incoming.defaultPlaybackRate = preparation.outgoing.defaultPlaybackRate = playerListening.rate;
        preparation.incoming.playbackRate = preparation.outgoing.playbackRate = playerListening.rate;
        applyPlayerFade(preparation);
    } else {
        for (const video of playerControl('playerMediaStage').querySelectorAll('video')) applyPlayerListening(video);
        if (Math.abs(active.volume - playerListening.volume) > 0.01) playerVolumeSupported = false;
        playerListening.volume = active.volume;
    }
    syncPlayerControls();
    showPlayerControls();
}
function commitPlayerSeek(value, drag = null) {
    const video = playerControl('playerVideo');
    if (drag && (drag.video !== video || drag.generation !== endlessPlayback.loadGeneration)) return;
    if (!playerCanSeek(video)) { syncPlayerControls(); return; }
    let target = Math.max(0, Math.min(video.duration, Number(value)));
    if (!Number.isFinite(target)) { syncPlayerControls(); return; }
    let nearest = null;
    let distance = Infinity;
    for (let index = 0; index < video.seekable.length; index++) {
        const start = Math.max(0, video.seekable.start(index));
        const end = Math.min(video.duration, video.seekable.end(index));
        const candidate = Math.max(start, Math.min(end, target));
        if (Math.abs(candidate - target) < distance) {
            nearest = candidate;
            distance = Math.abs(candidate - target);
        }
    }
    if (nearest === null) { syncPlayerControls(); return; }
    if (playerPreparation?.fade) finishPlayerFade();
    try { video.currentTime = nearest; } catch (_error) { /* Keep the actual media clock on failure. */ }
    syncPlayerControls();
}
function navigatePlayer(direction) {
    if (!endlessPlayback.active || playerNavigationBusy() || playerRecoveryActive()) return;
    if (playerPreparation?.fade) finishPlayerFade();
    if (endlessPlayback.mode === 'playlist') {
        const item = adjacentPlaylistItem(direction);
        if (item) selectPlaylistQueueItem(item.id);
    } else if (direction === 1) advanceEndlessPlayback();
    syncPlayerControls();
}
function togglePlayerFullscreen() {
    if (!playerInFullscreen()) { requestPlayerFullscreen(); return; }
    if (document.fullscreenElement) {
        try { Promise.resolve(document.exitFullscreen()).catch(() => {}); } catch (_error) { /* Browser owns exit. */ }
    } else playerControl('playerVideo').webkitExitFullscreen?.();
}
function resetPlayerListening() {
    closePlayer();
    Object.assign(playerListening, { volume: 1, muted: false, rate: 1 });
    for (const video of playerControl('playerMediaStage').querySelectorAll('video')) applyPlayerListening(video);
}
function initializePlayerControls() {
    const container = playerControl('playerContainer');
    const controls = playerControl('playerControls');
    const ids = ['playerTitle', 'playerModeLabel', 'playerPlayPause', 'playerMute', 'playerPrevious',
        'playerNext', 'playerFullscreen', 'playerQueueToggle', 'playerSeek', 'playerVolume',
        'playerSpeed', 'playerTime', 'playerVolumeHint', 'playerRepeat', 'playerRewind', 'playerForward'];
    if (!container || !controls || ids.some(id => !playerControl(id))) return;
    const abort = new AbortController();
    const listen = (node, type, callback, options = {}) => node.addEventListener(type, callback,
        { ...options, signal: abort.signal });
    try {
        listen(playerControl('playerPlayPause'), 'click', () => togglePlayerPlayback());
        listen(playerControl('playerRepeat'), 'click', togglePlayerRepeat);
        for (const [id, offset] of [['playerRewind', -10], ['playerForward', 10]]) {
            listen(playerControl(id), 'click', () => {
                if (playerControl(id).disabled) return;
                const video = playerControl('playerVideo');
                const target = video.currentTime + offset;
                // WebKit can emit ended on a paused seek to exact EOF, which
                // would advance the session instead of retaining this video.
                commitPlayerSeek(target >= video.duration ? Math.max(0, video.duration - 0.001) : target);
                showPlayerControls();
            });
        }
        listen(playerControl('playerMediaStage'), 'click', event => {
            if (event.button !== 0 || event.target !== playerControl('playerVideo')) return;
            container.focus({ preventScroll: true });
            togglePlayerPlayback();
        });
        listen(playerControl('playerMute'), 'click', () => updatePlayerListening({
            muted: playerPreparation?.fade ? !playerListening.muted : !playerControl('playerVideo').muted,
        }));
        listen(playerControl('playerVolume'), 'input', event => updatePlayerListening({ volume: Number(event.target.value) / 100 }));
        const volume = playerControl('playerMute').closest('.player-volume-control');
        listen(playerControl('playerMute'), 'pointerdown', event => {
            if (event.pointerType === 'touch') volume.classList.add('volume-touch-open');
        });
        listen(document, 'pointerdown', event => {
            volume.classList.remove('volume-keyboard-open');
            if (!volume.contains(event.target)) volume.classList.remove('volume-touch-open');
        });
        listen(volume, 'focusin', () => {
            if (!playerPointerFocus) volume.classList.add('volume-keyboard-open');
        });
        listen(volume, 'focusout', () => {
            // Keep the range in the tab order while focus crosses from speaker
            // to slider; hiding it during blur causes browsers to skip it.
            setTimeout(() => {
                if (!volume.contains(document.activeElement)) volume.classList.remove('volume-keyboard-open');
            }, 0);
        });
        listen(playerControl('playerVolume'), 'pointerdown', () => volume.classList.add('volume-adjusting'));
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            listen(document, name, () => volume.classList.remove('volume-adjusting'));
        }
        listen(playerControl('playerSpeed'), 'change', event => {
            updatePlayerListening({ rate: Number(event.target.value) });
            if (playerPointerFocus) container.focus({ preventScroll: true });
        });
        listen(playerControl('playerSpeed'), 'keyup', showPlayerControls);
        listen(playerControl('playerPrevious'), 'click', () => navigatePlayer(-1));
        listen(playerControl('playerNext'), 'click', () => navigatePlayer(1));
        listen(playerControl('playerFullscreen'), 'click', togglePlayerFullscreen);
        listen(playerControl('playerQueueToggle'), 'click', () => {
            const queue = playerControl('playlistQueue');
            queue.hidden = !queue.hidden;
            container.classList.toggle('playlist-queue-collapsed', queue.hidden);
            syncPlayerControls();
            showPlayerControls();
        });
        const seek = playerControl('playerSeek');
        let pointerSeekCommitted = false;
        listen(seek, 'keydown', () => { pointerSeekCommitted = false; });
        listen(seek, 'pointerdown', event => {
            if (seek.disabled) return;
            pointerSeekCommitted = true;
            playerSeekDrag = { video: playerControl('playerVideo'), generation: endlessPlayback.loadGeneration,
                pointerId: event.pointerId };
            showPlayerControls();
        });
        listen(seek, 'input', () => {
            if (playerSeekDrag) syncPlayerControls();
        });
        listen(seek, 'change', () => {
            if (!playerSeekDrag && !pointerSeekCommitted) commitPlayerSeek(seek.value);
        });
        // Native ranges own thumb capture. Explicit capture prevents WebKit's
        // thumb from moving; observing the document still handles outside release.
        listen(document, 'pointerup', event => {
            if (!playerSeekDrag || event.pointerId !== playerSeekDrag.pointerId) return;
            const drag = playerSeekDrag;
            const target = seek.value;
            playerSeekDrag = null;
            pointerSeekCommitted = true;
            commitPlayerSeek(target, drag);
        });
        for (const [target, name] of [[document, 'pointercancel'], [seek, 'lostpointercapture']]) {
            listen(target, name, event => {
                if (!playerSeekDrag || event.pointerId !== playerSeekDrag.pointerId) return;
                playerSeekDrag = null;
                pointerSeekCommitted = true;
                syncPlayerControls();
            });
        }
        for (const range of controls.querySelectorAll('input[type="range"]')) {
            listen(range, 'pointerdown', () => { playerSliderInteraction = true; showPlayerControls(); });
            for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
                listen(range, name, () => { playerSliderInteraction = false; showPlayerControls(); });
            }
        }
        for (const name of ['pointerup', 'pointercancel']) {
            listen(document, name, () => {
                if (!playerSliderInteraction) return;
                playerSliderInteraction = false;
                showPlayerControls();
            });
        }
        listen(container, 'pointermove', handlePlayerPointerMove);
        listen(container, 'pointerdown', () => {
            playerPointerFocus = true;
            showPlayerControls();
        });
        listen(container, 'keydown', event => {
            playerPointerFocus = false;
            if (volume.contains(document.activeElement)) volume.classList.add('volume-keyboard-open');
            showPlayerControls();
            if (event.key !== 'Tab') return;
            const focusable = [...container.querySelectorAll('button, input, select, [tabindex="0"]')]
                .filter(node => !node.disabled && !node.closest('[hidden], [inert]') && node.getClientRects().length);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first) { event.preventDefault(); container.focus(); }
            else if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === container)) {
                event.preventDefault(); first.focus();
            }
        });
        listen(container, 'focusin', showPlayerControls);
        listen(container, 'focusout', () => {
            setTimeout(() => {
                if (playerIsOpen() && container.classList.contains('player-controls-visible')) showPlayerControls();
            }, 0);
        });
        listen(document, 'focusin', event => {
            if (playerIsOpen() && !container.contains(event.target)) {
                showPlayerControls(); container.focus({ preventScroll: true });
            }
        });
        for (const video of playerControl('playerMediaStage').querySelectorAll('video')) {
            for (const name of ['loadedmetadata', 'loadeddata', 'durationchange', 'progress', 'timeupdate',
                'play', 'playing', 'pause', 'ended', 'waiting', 'stalled', 'canplay', 'seeking', 'seeked', 'emptied', 'error']) {
                listen(video, name, () => {
                    if (video.id !== 'playerVideo') return;
                    updatePlayerBuffering(video, name);
                    syncPlayerControls();
                    if (['play', 'playing', 'pause', 'ended', 'waiting', 'error', 'seeked', 'canplay'].includes(name)
                            || (name === 'stalled' && !playerMediaProgressing.has(video))) showPlayerControls();
                });
            }
        }
        listen(document, 'fullscreenchange', () => { syncPlayerControls(); showPlayerControls(); });
        const logout = document.querySelector('form.logout-form');
        if (logout) listen(logout, 'submit', resetPlayerListening);
        playerControlsReady = true;
        controls.hidden = false;
        container.classList.add('custom-controls-ready');
        for (const video of playerControl('playerMediaStage').querySelectorAll('video')) video.controls = false;
        // Some mobile engines expose volume but ignore writes. A reversible
        // capability probe keeps the initial listening level at 100 percent.
        const video = playerControl('playerVideo');
        try { video.volume = 0.5; playerVolumeSupported = video.volume === 0.5; video.volume = 1; }
        catch (_error) { playerVolumeSupported = false; }
    } catch (_error) {
        abort.abort();
        playerControlsReady = false;
        controls.hidden = true;
        container.classList.remove('custom-controls-ready');
        playerControl('playerVideo').controls = true;
    }
}

function playerBoundaryCurrent(video, state) {
    return playerBoundaries.get(video) === state
        && (state.current() || (playerPreparation?.outgoing === video
            && currentPreparation(playerPreparation)));
}

function updateSkipVideoEdges(enabled) {
    if (skipVideoEdges === enabled) return;
    skipVideoEdges = enabled;
    // A preloaded item has not become current yet. Reload it with the saved
    // setting, or retain an already committed response for an ordinary handoff.
    if (endlessPlayback.mode !== 'shuffle_clips' && playerPreparation && !playerPreparation.fade) {
        if (playerPreparation.committing || playerPreparation.response) {
            playerPreparation.disabled = true;
        } else {
            clearPlayerPreparation();
        }
    }
}

function playPlayerVideo(video, generation = endlessPlayback.loadGeneration) {
    const play = () => {
        if (generation !== endlessPlayback.loadGeneration) return;
        try {
            observePlaybackPromise(video.play(), generation);
        } catch (_error) {
            handlePlaybackFailure(generation, 'This video could not be played.');
        }
    };
    const boundary = playerBoundaries.get(video);
    if (boundary) boundary.playWhenReady(play);
    else play();
}

function playerEffectiveEnd(video) {
    const state = playerBoundaries.get(video);
    // Repeating a video takes precedence over sampled Shuffle Clips bounds.
    if (state?.clip && repeatingPlayerVideo(video)) return video.duration;
    return state?.valid && (state.clip || !state.tail) ? state.end : video.duration;
}

function repeatingPlayerVideo(video) {
    return playerRepeatCurrent && video.id === 'playerVideo';
}

function togglePlayerRepeat() {
    if (playerControl('playerRepeat').disabled) return;
    playerRepeatCurrent = !playerRepeatCurrent;
    // A fade has already made its incoming video current. Settle onto that
    // video before discarding the reserved successor and its async callbacks.
    if (playerRepeatCurrent) {
        finishPlayerFade();
        clearPlayerPreparation();
        const state = playerBoundaries.get(playerControl('playerVideo'));
        if (state) state.finished = false;
    } else {
        const video = playerControl('playerVideo');
        const state = playerBoundaries.get(video);
        if (state?.clip && (video.currentTime < state.start || video.currentTime >= state.end)) {
            seekPlayerBoundary(video, state, state.start);
        }
        maybePreparePlayer();
    }
    syncPlayerControls();
    showPlayerControls();
}

function sampleShuffleClip(duration, random = Math.random) {
    if (!Number.isFinite(duration) || duration < 7.5) return null;
    const earliest = duration / 3;
    const latest = Math.min(7 * duration / 8, duration - 5);
    const start = earliest + random() * (latest - earliest);
    const maximumLength = Math.min(20, duration - start);
    const length = 5 + random() * (maximumLength - 5);
    return { start, length, end: start + length };
}

function shuffleClipOccurrence(item, sequence = endlessPlayback.sequence) {
    if (!endlessPlayback.active || endlessPlayback.mode !== 'shuffle_clips') return null;
    const key = JSON.stringify([endlessPlayback.sessionId, sequence, String(item.id),
        item.source_revision || null]);
    // Keep retries for this occurrence, but release completed sequence history.
    for (const previous of endlessPlayback.clipOccurrences.keys()) {
        if (JSON.parse(previous)[1] < endlessPlayback.sequence - 1) {
            endlessPlayback.clipOccurrences.delete(previous);
        }
    }
    if (!endlessPlayback.clipOccurrences.has(key)) {
        endlessPlayback.clipOccurrences.set(key, { key, id: String(item.id) });
    }
    return endlessPlayback.clipOccurrences.get(key);
}

function createShuffleClipBoundary(video, { current, clipOccurrence, onFailure }) {
    const state = {
        enabled: true, clip: true, current, occurrence: clipOccurrence, onFailure,
        metadata: false, started: false, valid: false, ready: false,
        start: 0, end: NaN, finished: false, ownSeek: false, tail: false,
    };
    playerBoundaries.set(video, state);
    video.style.visibility = 'hidden';
    const alive = () => playerBoundaryCurrent(video, state);
    const fail = () => {
        if (!alive() || state.failed) return;
        state.failed = true;
        state.ready = false;
        state.play = null;
        clearTimeout(state.timer);
        video.pause();
        if (playerPreparation?.fade && playerPreparation.outgoing === video) {
            finishPlayerFade();
        } else {
            state.onFailure?.();
        }
    };
    const resume = () => {
        if (!alive() || state.failed || state.finished || !state.valid || state.ownSeek || video.seeking
                || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
        if (!repeatingPlayerVideo(video) && (video.currentTime < state.start - 0.05
                || (!state.started && video.currentTime > state.end + 0.05))) return;
        state.ready = true;
        clearTimeout(state.timer);
        video.style.removeProperty('visibility');
        const play = state.play;
        state.play = null;
        play?.();
    };
    const update = event => {
        if (!alive() || state.failed) return;
        if (event.type === 'loadedmetadata') state.metadata = true;
        if (!state.metadata) return;
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration < 7.5) {
            // A transient unknown duration may settle; an actual short file cannot.
            if (state.valid || Number.isFinite(duration)) fail();
            return;
        }
        if (!clipOccurrence.bounds) clipOccurrence.bounds = sampleShuffleClip(duration);
        const bounds = clipOccurrence.bounds;
        if (!bounds || bounds.start + 0.000001 < duration / 3
                || bounds.start > 7 * duration / 8 + 0.000001
                || bounds.end > duration + 0.000001) {
            fail();
            return;
        }
        state.valid = true;
        state.start = bounds.start;
        state.end = bounds.end;
        if (!state.initialApplied) {
            state.initialApplied = true;
            seekPlayerBoundary(video, state, state.start);
        }
        resume();
    };
    const onSeeking = () => {
        if (!alive() || state.failed || state.finished || !state.valid) return;
        if (state.ownSeek && Math.abs(video.currentTime - state.target) < 0.05) return;
        state.ownSeek = false;
        state.ready = false;
        if (repeatingPlayerVideo(video)) return;
        if (video.currentTime < state.start) {
            seekPlayerBoundary(video, state, state.start);
        } else if (video.currentTime >= state.end) {
            completePlayerItem(video);
        }
    };
    const onSeeked = () => {
        if (!alive() || state.failed || state.finished) return;
        if (state.ownSeek && Math.abs(video.currentTime - state.target) > 0.05) {
            fail();
            return;
        }
        state.ownSeek = false;
        if (!repeatingPlayerVideo(video) && video.currentTime < state.start - 0.05) {
            seekPlayerBoundary(video, state, state.start);
            return;
        }
        if (!repeatingPlayerVideo(video) && state.valid && video.currentTime >= state.end) completePlayerItem(video);
        else resume();
    };
    const listeners = {
        loadedmetadata: update, durationchange: update, seeking: onSeeking,
        seeked: onSeeked, canplay: resume, loadeddata: resume,
        play: () => {
            if (!alive() || (state.ready && !state.finished && !state.failed)) return;
            video.pause();
            if (!state.failed && !state.finished && video.id === 'playerVideo') {
                state.play = () => playPlayerVideo(video);
            }
        },
        playing: () => {
            if (!alive()) return;
            if (state.ready && !state.finished && !state.failed) state.started = true;
            else video.pause();
        },
    };
    for (const [name, listener] of Object.entries(listeners)) video.addEventListener(name, listener);
    state.timer = setTimeout(fail, PLAYER_HANDOFF_TIMEOUT_MS);
    const frame = () => {
        if (!alive() || state.failed) return;
        checkPlayerBoundary(video);
        if (video.id === 'playerVideo') maybePreparePlayer();
        state.frame = requestAnimationFrame(frame);
    };
    state.frame = requestAnimationFrame(frame);
    state.fail = fail;
    state.cleanup = () => {
        clearTimeout(state.timer);
        cancelAnimationFrame(state.frame);
        state.play = null;
        for (const [name, listener] of Object.entries(listeners)) video.removeEventListener(name, listener);
        video.style.removeProperty('visibility');
        if (playerBoundaries.get(video) === state) playerBoundaries.delete(video);
    };
    state.playWhenReady = play => {
        if (state.failed || state.finished) return;
        if (state.ready) play();
        else state.play = play;
    };
    return state;
}

function seekPlayerBoundary(video, state, position) {
    if (Math.abs(video.currentTime - position) < 0.01) return;
    state.ownSeek = true;
    state.target = position;
    state.ready = false;
    state.seekFailed = false;
    try {
        video.currentTime = position;
    } catch (_error) {
        state.seekFailed = true;
        if (state.clip) {
            state.fail();
            return;
        }
        // Ordinary playback can still use media that does not support seeking.
    }
    if (!video.seeking || state.seekFailed) {
        state.ownSeek = false;
        state.ready = !state.clip;
    }
}

function createPlayerBoundary(video, { current, seekSeconds = null, clipOccurrence = null, onFailure = null } = {}) {
    playerBoundaries.get(video)?.cleanup();
    if (clipOccurrence) return createShuffleClipBoundary(video, { current, clipOccurrence, onFailure });
    const state = {
        enabled: skipVideoEdges, current, metadata: false, started: false,
        valid: false, start: 0, end: NaN, tail: false, finished: false,
        initialApplied: false, unreliable: false, ownSeek: false,
        ready: !skipVideoEdges, resume: seekSeconds, play: null,
    };
    playerBoundaries.set(video, state);
    const alive = () => playerBoundaryCurrent(video, state);
    const resumePlayback = () => {
        if (!alive() || !state.ready || !state.play) return;
        const play = state.play;
        state.play = null;
        play();
    };
    const update = event => {
        if (!alive() || !state.enabled) return;
        if (event.type === 'loadedmetadata') state.metadata = true;
        if (!state.metadata) return;
        const duration = video.duration;
        const reliable = Number.isFinite(duration) && duration > 0;
        if (!reliable && state.started) state.unreliable = true;
        const hadBounds = state.valid;
        state.valid = reliable && duration > 20 && !state.unreliable;
        state.start = state.valid ? 10 : 0;
        state.end = state.valid ? duration - 10 : duration;
        if (hadBounds && !state.valid && playerPreparation?.fade
                && playerPreparation.outgoing === video) {
            failPlayerFade(playerPreparation);
        }
        state.ready = !state.ownSeek;
        if (reliable && !state.initialApplied) {
            state.initialApplied = true;
            const resume = state.resume !== null && Number.isFinite(Number(state.resume));
            let position = resume ? Math.max(0, Number(state.resume))
                : state.started ? video.currentTime : 0;
            if (state.valid) {
                position = position < state.start || (resume && position >= state.end)
                    ? state.start : position;
            } else {
                position = Math.min(position, duration);
            }
            seekPlayerBoundary(video, state, position);
        }
        resumePlayback();
    };
    const onSeeking = () => {
        if (!alive() || !state.enabled) return;
        if (state.ownSeek && Math.abs(video.currentTime - state.target) < 0.1) return;
        state.ownSeek = false;
        state.ready = false;
        state.finished = false;
        state.tail = state.valid && video.currentTime >= state.end;
        if (state.tail && playerPreparation?.outgoing === video) {
            if (playerPreparation.committing || playerPreparation.response) {
                playerPreparation.disabled = true;
            } else {
                clearPlayerPreparation();
            }
        }
    };
    const onSeeked = () => {
        if (!alive()) return;
        state.ownSeek = false;
        state.ready = true;
        resumePlayback();
    };
    const onPlay = () => {
        if (!alive() || !state.enabled || !state.finished) return;
        state.finished = false;
        state.tail = false;
        if (state.valid) seekPlayerBoundary(video, state, state.start);
    };
    const onPlaying = () => { if (alive()) state.started = true; };
    const listeners = {
        loadedmetadata: update, durationchange: update, seeking: onSeeking,
        seeked: onSeeked, play: onPlay, playing: onPlaying,
    };
    for (const [name, listener] of Object.entries(listeners)) video.addEventListener(name, listener);
    state.cleanup = () => {
        state.play = null;
        for (const [name, listener] of Object.entries(listeners)) video.removeEventListener(name, listener);
        if (playerBoundaries.get(video) === state) playerBoundaries.delete(video);
    };
    state.playWhenReady = play => {
        if (!state.enabled || state.ready) play();
        else state.play = play;
    };
    return state;
}

function completePlayerItem(video, natural = false) {
    const state = playerBoundaries.get(video);
    if (state && (!playerBoundaryCurrent(video, state) || state.finished)) return;
    // An ended event queued for the previous source must not finish a new load.
    if (natural && state?.enabled && (!state.metadata
            || (!video.ended && (!state.valid || video.currentTime < state.end)))) return;
    if (playerPreparation?.fade && video === playerPreparation.outgoing) {
        if (state) state.finished = true;
        finishPlayerFade();
        return;
    }
    if (video.id !== 'playerVideo') return;
    if (repeatingPlayerVideo(video)) {
        if (state) {
            state.finished = false;
            state.tail = false;
            state.play = null;
        }
        video.pause();
        const start = state?.valid && !state.clip ? state.start : 0;
        if (state) seekPlayerBoundary(video, state, start);
        else video.currentTime = start;
        playPlayerVideo(video);
        return;
    }
    if (natural && state?.clip && playerPreparation && !playerPreparation.disabled) {
        // At EOF there is no more moving footage; retain the last picture while
        // the reserved successor finishes loading instead of replacing its source.
        playerPreparation.ended = true;
        maybeCommitPlayerFade(playerPreparation);
        return;
    }
    if (natural && state?.clip && playerPreparation?.disabled
            && !playerPreparation.response) return;
    if (state) {
        state.finished = true;
        state.play = null;
    }
    if (!natural) {
        if (state?.valid) seekPlayerBoundary(video, state, state.end);
        video.pause();
    }
    if (usePreparedPlayerHandoff()) return;
    if (endlessPlayback.active && (endlessPlayback.phase === 'playing' || state?.clip)) {
        advanceEndlessPlayback(endlessPlayback.mode === 'playlist');
    }
}

function checkPlayerBoundary(video) {
    const state = playerBoundaries.get(video);
    if (!state?.valid || !playerBoundaryCurrent(video, state) || state.finished
            || state.tail || state.ownSeek || video.paused || video.seeking
            || playerMediaWaiting.has(video)
            || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    // A clip endpoint schedules a transition, not a hard stop. The fade owns
    // completion once its successor is playable, even if loading ran past E.
    if (state.clip) return;
    if (video.currentTime >= state.end) completePlayerItem(video);
}

function canPreparePlayer() {
    return !playerRepeatCurrent && endlessPlayback.active && endlessPlayback.sessionId
        && ['sequential', 'shuffle', 'shuffle_clips'].includes(endlessPlayback.mode);
}

function currentPreparation(preparation) {
    return playerPreparation === preparation && endlessPlayback.active
        && preparation.epoch === endlessPlayback.epoch
        && preparation.sessionId === endlessPlayback.sessionId
        && preparation.generation === endlessPlayback.loadGeneration;
}

function unloadPlayerMedia(video) {
    playerMediaProgressing.delete(video);
    playerMediaTimes.delete(video);
    playerMediaWaiting.delete(video);
    playerBoundaries.get(video)?.cleanup();
    video.pause();
    video.removeAttribute('src');
    video.replaceChildren();
    video.load();
    video.style.removeProperty('opacity');
    video.style.removeProperty('z-index');
}

function setPlayerStandby(video, standby) {
    video.classList.toggle('player-standby', standby);
    video.controls = !standby && !playerControlsReady;
    video.controlsList?.toggle('nofullscreen', endlessPlayback.active
        && ['sequential', 'shuffle', 'shuffle_clips'].includes(endlessPlayback.mode)
        && Boolean(document.getElementById('playerMediaStage').requestFullscreen));
    video.autoplay = !standby;
    if (standby) {
        video.setAttribute('aria-hidden', 'true');
        video.setAttribute('tabindex', '-1');
    } else {
        video.removeAttribute('aria-hidden');
        if (playerControlsReady) video.setAttribute('tabindex', '-1');
        else video.removeAttribute('tabindex');
    }
}

function clearPlayerPreparation() {
    const preparation = playerPreparation;
    playerPreparation = null;
    if (!preparation) return;
    preparation.controller.abort();
    clearTimeout(preparation.timer);
    cancelAnimationFrame(preparation.frame);
    clearTimeout(preparation.resumeTimer);
    preparation.cleanup?.();
    const standby = document.getElementById('playerStandby');
    unloadPlayerMedia(standby);
    setPlayerStandby(standby, true);
}

function finishPlayerFade() {
    const preparation = playerPreparation;
    if (!preparation?.fade) return;
    const { incoming, outgoing, baseVolume, muted } = preparation;
    preparation.fade = false;
    cancelAnimationFrame(preparation.frame);
    incoming.volume = baseVolume;
    incoming.muted = muted;
    incoming.style.removeProperty('opacity');
    incoming.style.removeProperty('z-index');
    outgoing.volume = baseVolume;
    outgoing.muted = muted;
    clearPlayerPreparation();
    endlessPlayback.handoffInProgress = false;
    syncPlayerControls();
    if (endlessPlayback.mode === 'shuffle_clips') maybePreparePlayer();
}

function playerFadeVolumeIsGain(preparation, volume) {
    return preparation.volumeGains?.some(gain => Math.abs(gain - volume) <= 0.0001) || false;
}

function applyPlayerFade(preparation) {
    if (!currentPreparation(preparation) || !preparation.fade) return;
    let frozen = Boolean(preparation.controlPaused);
    if (preparation.resumePending) {
        const { outgoing, incoming } = preparation;
        const progressing = ![outgoing, incoming].some(video => video.paused || video.seeking
                || playerMediaWaiting.has(video) || !playerMediaProgressing.has(video))
            && outgoing.currentTime >= preparation.resumeOutgoingTime + 0.05
            && incoming.currentTime >= preparation.resumeIncomingTime + 0.05;
        if (progressing) {
            preparation.resumePending = false;
            clearTimeout(preparation.resumeTimer);
            // A resume can briefly rebuffer in WebKit. Retain the frozen envelope
            // until both clocks move, then continue it from the same media-time gain.
            if (preparation.resumeBuffered) {
                preparation.startTime = outgoing.currentTime - preparation.progress * preparation.fadeDuration;
            }
        } else if (preparation.resumeBuffered) frozen = true;
    }
    const { outgoing, incoming, startTime, fadeDuration } = preparation;
    const progress = frozen ? preparation.progress : outgoing.ended ? 1 : Math.max(0, Math.min(1,
        (outgoing.currentTime - startTime) / fadeDuration,
    ));
    if (Number.isFinite(preparation.newVolume)
            && Math.abs(incoming.volume - preparation.newVolume) > 0.0001
            && !playerFadeVolumeIsGain(preparation, incoming.volume)) {
        preparation.baseVolume = incoming.volume;
        playerListening.volume = incoming.volume;
        playerListening.muted = incoming.muted;
    }
    // Native volume callbacks may carry an earlier gain and its old mute. The
    // envelope must retain the listening choices supplied through the controls.
    preparation.muted = playerListening.muted;
    preparation.progress = progress;
    incoming.style.opacity = preparation.reducedMotion ? '1' : String(progress);
    const oldVolume = preparation.baseVolume * Math.cos(Math.PI * progress / 2);
    const newVolume = preparation.baseVolume * Math.sin(Math.PI * progress / 2);
    preparation.oldVolume = oldVolume;
    preparation.newVolume = newVolume;
    preparation.volumeGains ||= [];
    const previousGain = preparation.volumeGains[preparation.volumeGains.length - 1];
    if (!Number.isFinite(previousGain) || Math.abs(previousGain - newVolume) > 0.0001) {
        preparation.volumeGains.push(newVolume);
        if (preparation.volumeGains.length > 512) preparation.volumeGains.shift();
    }
    // Media backends may round gains to float precision. Avoid rewriting an
    // unchanged gain from its own volumechange callback and queueing it again.
    if (Math.abs(outgoing.volume - oldVolume) > 0.000001) outgoing.volume = oldVolume;
    if (Math.abs(incoming.volume - newVolume) > 0.000001) incoming.volume = newVolume;
    if (outgoing.muted !== preparation.muted) outgoing.muted = preparation.muted;
    if (incoming.muted !== preparation.muted) incoming.muted = preparation.muted;
    if (Math.abs(outgoing.volume - oldVolume) > 0.01
            || Math.abs(incoming.volume - newVolume) > 0.01) {
        failPlayerFade(preparation);
        return;
    }
    if (progress >= 1) finishPlayerFade();
}

function playerPauseAborted(error, preparation = playerPreparation) {
    return error?.name === 'AbortError' && preparation?.fade && currentPreparation(preparation)
        && preparation.controlPaused && preparation.incoming.paused && preparation.outgoing.paused;
}

function resumeBufferedClipFade(preparation) {
    if (!currentPreparation(preparation) || !preparation.fade || !preparation.buffering
            || !preparation.resumeAfterBuffer) return;
    const { incoming, outgoing } = preparation;
    if ([incoming, outgoing].some(video => playerMediaWaiting.has(video)
            || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)) return;
    preparation.buffering = false;
    Promise.all([incoming.play(), outgoing.play()]).catch(error => {
        if (!playerPauseAborted(error, preparation)) failPlayerFade(preparation);
    });
}

function playerFadeFrame(preparation) {
    if (!currentPreparation(preparation) || !preparation.fade) return;
    applyPlayerFade(preparation);
    if (preparation.fade) {
        preparation.frame = requestAnimationFrame(() => playerFadeFrame(preparation));
    }
}

function failPlayerFade(preparation) {
    if (!currentPreparation(preparation)) return;
    clearTimeout(preparation.timer);
    clearTimeout(preparation.resumeTimer);
    preparation.resumePending = false;
    if (endlessPlayback.mode === 'shuffle_clips' && preparation.item) {
        endlessPlayback.failedClipIds.add(String(preparation.item.id));
    }
    if (preparation.fade) {
        // The server has committed. Restore the outgoing picture until ended,
        // then retry that committed item without drawing another Shuffle choice.
        preparation.fade = false;
        preparation.failedDuringFade = true;
        preparation.disabled = true;
        cancelAnimationFrame(preparation.frame);
        clearPlayerMediaCallbacks();
        const { outgoing, incoming } = preparation;
        incoming.id = 'playerStandby';
        outgoing.id = 'playerVideo';
        const boundary = playerBoundaries.get(outgoing);
        if (boundary) {
            const epoch = endlessPlayback.epoch;
            const generation = endlessPlayback.loadGeneration;
            boundary.current = () => epoch === endlessPlayback.epoch
                && generation === endlessPlayback.loadGeneration;
        }
        setPlayerStandby(outgoing, false);
        setPlayerStandby(incoming, true);
        outgoing.volume = preparation.baseVolume;
        outgoing.muted = preparation.muted;
        incoming.pause();
        incoming.style.opacity = '0';
        endlessPlayback.currentItem = preparation.outgoingItem;
        endlessPlayback.currentDownloadId = String(preparation.outgoingItem.id);
        endlessPlayback.phase = 'playing';
        endlessPlayback.handoffInProgress = true;
        if (outgoing.ended) usePreparedPlayerHandoff();
    } else {
        preparation.disabled = true;
        unloadPlayerMedia(preparation.incoming);
        preparation.incoming.style.opacity = '0';
        if (endlessPlayback.mode === 'shuffle_clips' && !preparation.response && !preparation.committing) {
            clearPlayerPreparation();
            queueMicrotask(maybePreparePlayer);
        } else if (endlessPlayback.mode === 'shuffle_clips') {
            showPlayerTransition('The next clip could not be played. Retry or stop playback.',
                ['retry', 'stop', 'close']);
        }
    }
}

function usePreparedPlayerHandoff() {
    const preparation = playerPreparation;
    if (!preparation || preparation.fade) return false;
    if (preparation.committing) {
        preparation.ended = true;
        return true;
    }
    if (!preparation.response) return false;
    const response = preparation.response;
    const recoverPrepared = preparation.failedDuringFade;
    clearPlayerPreparation();
    advanceEndlessPlayback(false, response, recoverPrepared);
    return true;
}

function playerFadeLimit(preparation) {
    const outgoing = playerBoundaries.get(preparation.outgoing);
    const incoming = playerBoundaries.get(preparation.incoming);
    if (!outgoing?.clip || !incoming?.clip) return PLAYER_FADE_SECONDS;
    return Math.min(PLAYER_FADE_SECONDS, (outgoing.end - outgoing.start) / 2,
        (incoming.end - incoming.start) / 2);
}

function beginPlayerFade(preparation) {
    if (!currentPreparation(preparation) || preparation.disabled) return;
    const { outgoing, incoming } = preparation;
    const clip = endlessPlayback.mode === 'shuffle_clips';
    if (clip && ((outgoing.paused && !outgoing.ended) || incoming.seeking
            || !playerBoundaries.get(incoming)?.ready
            || incoming.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)) {
        clearTimeout(preparation.timer);
        incoming.pause();
        preparation.starting = false;
        preparation.playing = preparation.playResolved = false;
        return;
    }
    clearTimeout(preparation.timer);
    const remaining = (clip ? outgoing.duration : playerEffectiveEnd(outgoing)) - outgoing.currentTime;
    if (!clip && (outgoing.paused || outgoing.ended || !Number.isFinite(remaining)
            || remaining < 1 || remaining > playerFadeLimit(preparation)
            || endlessPlayback.presentation === 'webkit-fullscreen'
            || document.fullscreenElement === outgoing)) {
        failPlayerFade(preparation);
        if (outgoing.ended || preparation.ended) usePreparedPlayerHandoff();
        return;
    }
    preparation.baseVolume = outgoing.volume;
    preparation.muted = outgoing.muted;
    incoming.muted = outgoing.muted;
    incoming.playbackRate = outgoing.playbackRate;
    preparation.startTime = outgoing.currentTime;
    preparation.fadeDuration = Math.min(playerFadeLimit(preparation), remaining);
    const immediate = clip && (outgoing.ended || remaining < 1
        || endlessPlayback.presentation === 'webkit-fullscreen'
        || document.fullscreenElement === outgoing);
    preparation.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    preparation.fade = true;
    preparation.progress = 0;
    clearPlayerMediaCallbacks();
    const moveFocus = document.activeElement === outgoing;
    outgoing.id = 'playerStandby';
    incoming.id = 'playerVideo';
    setPlayerStandby(outgoing, true);
    setPlayerStandby(incoming, false);
    // The outgoing picture stays opaque underneath the incoming picture.
    outgoing.classList.add('player-fade-outgoing');
    incoming.style.zIndex = '1';
    loadPlaybackItem(preparation.data.item, { adopt: true });
    if (moveFocus) incoming.focus({ preventScroll: true });
    preparation.generation = endlessPlayback.loadGeneration;
    endlessPlayback.sequence = preparation.data.sequence;
    markPlaybackStarted(preparation.generation);
    endlessPlayback.handoffInProgress = true;
    if (immediate) finishPlayerFade();
    else playerFadeFrame(preparation);
}

function startPreparedClip(preparation) {
    if (!currentPreparation(preparation) || preparation.disabled || preparation.fade
            || preparation.starting || !preparation.data) return;
    const { incoming, outgoing } = preparation;
    const boundary = playerBoundaries.get(incoming);
    if ((outgoing.paused && !outgoing.ended) || outgoing.seeking
            || (playerMediaWaiting.has(outgoing) && !outgoing.ended)
            || !boundary?.ready || boundary.failed || incoming.seeking
            || incoming.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
    preparation.baseVolume = outgoing.volume;
    preparation.muted = outgoing.muted;
    incoming.volume = 0;
    if (incoming.volume !== 0) {
        failPlayerFade(preparation);
        return;
    }
    incoming.muted = outgoing.muted;
    incoming.playbackRate = outgoing.playbackRate;
    preparation.starting = true;
    preparation.playResolved = preparation.playing = false;
    preparation.timer = setTimeout(() => failPlayerFade(preparation), PLAYER_HANDOFF_TIMEOUT_MS);
    Promise.resolve().then(() => {
        if (!currentPreparation(preparation)) return;
        return incoming.play();
    }).then(() => {
        if (!currentPreparation(preparation)) return;
        // Pause may have happened while play() or authorization was pending.
        if (outgoing.paused && !outgoing.ended) {
            clearTimeout(preparation.timer);
            incoming.pause();
            preparation.starting = false;
            preparation.playing = false;
            return;
        }
        preparation.playResolved = true;
        if (preparation.playing) beginPlayerFade(preparation);
    }).catch(() => failPlayerFade(preparation));
}

function loadPreparedPlayer(preparation, item) {
    const { incoming } = preparation;
    playerMediaProgressing.delete(incoming);
    playerMediaTimes.delete(incoming);
    playerMediaWaiting.delete(incoming);
    playerBoundaries.get(incoming)?.cleanup();
    preparation.item = item;
    applyPlayerListening(incoming);
    incoming.preload = 'auto';
    incoming.autoplay = false;
    incoming.style.opacity = '0';
    const source = document.createElement('source');
    source.src = '/api/file/' + encodeURIComponent(item.id);
    if (_VIDEO_MIME[item.extension]) source.type = _VIDEO_MIME[item.extension];
    incoming.replaceChildren(source);
    createPlayerBoundary(incoming, {
        current: () => currentPreparation(preparation),
        clipOccurrence: shuffleClipOccurrence(item, preparation.sequence),
        onFailure: () => failPlayerFade(preparation),
    });
    incoming.load();
}

async function commitPlayerFade(preparation) {
    preparation.committing = true;
    endlessPlayback.handoffInProgress = true;
    syncPlayerControls();
    preparation.timer = setTimeout(() => preparation.controller.abort(), PLAYER_HANDOFF_TIMEOUT_MS);
    try {
        const response = await apiFetch(
            '/api/playback-sessions/' + encodeURIComponent(endlessPlayback.sessionId) + '/advance',
            {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    expected_download_id: preparation.expectedId,
                    sequence: preparation.sequence,
                    ...(endlessPlayback.mode === 'shuffle_clips'
                        ? { failed_download_ids: Array.from(endlessPlayback.failedClipIds) } : {}),
                }),
                signal: preparation.controller.signal,
            },
        );
        if (!currentPreparation(preparation)) return;
        // Detach the completed response body from the abort signal: cleanup
        // must not invalidate the committed item needed by the ended fallback.
        const body = await response.text();
        if (!currentPreparation(preparation)) return;
        preparation.response = new Response(body || null, {
            status: response.status, headers: response.headers,
        });
        preparation.data = response.ok && response.status !== 204
            ? JSON.parse(body) : null;
        if (!currentPreparation(preparation)) return;
        preparation.committing = false;
        syncPlayerControls();
        clearTimeout(preparation.timer);
        const clip = endlessPlayback.mode === 'shuffle_clips';
        if (!clip && (preparation.ended || preparation.outgoing.ended)) {
            usePreparedPlayerHandoff();
            return;
        }
        const changed = preparation.data && ((endlessPlayback.mode === 'sequential'
                    && (preparation.order?.kind !== preparation.data.order?.kind
                        || preparation.order?.generation_id !== preparation.data.order?.generation_id))
                || String(preparation.data.item.id) !== String(preparation.item.id)
                || preparation.data.item.extension !== preparation.item.extension
                || (clip
                    && (!preparation.data.item.source_revision
                        || preparation.data.item.source_revision !== preparation.item.source_revision)));
        if (clip && preparation.data && !preparation.disabled) {
            if (changed) loadPreparedPlayer(preparation, preparation.data.item);
            startPreparedClip(preparation);
            return;
        }
        if (!preparation.data || changed || preparation.disabled
                || playerEffectiveEnd(preparation.outgoing) - preparation.outgoing.currentTime < 1) {
            failPlayerFade(preparation);
            return;
        }
        const { incoming, outgoing } = preparation;
        preparation.baseVolume = outgoing.volume;
        preparation.muted = outgoing.muted;
        incoming.volume = 0;
        if (incoming.volume !== 0) {
            preparation.disabled = true;
            return;
        }
        incoming.muted = outgoing.muted;
        incoming.playbackRate = outgoing.playbackRate;
        preparation.starting = true;
        const playback = incoming.play();
        await playback;
        if (!currentPreparation(preparation)) return;
        preparation.playResolved = true;
        if (preparation.playing) beginPlayerFade(preparation);
    } catch (error) {
        if (!currentPreparation(preparation)) return;
        clearTimeout(preparation.timer);
        preparation.committing = false;
        failPlayerFade(preparation);
        if (preparation.ended || preparation.outgoing.ended) {
            if (!usePreparedPlayerHandoff()) advanceEndlessPlayback();
        }
    }
}

function maybeCommitPlayerFade(preparation) {
    if (!currentPreparation(preparation)) return;
    if (endlessPlayback.mode === 'shuffle_clips' && preparation.response) {
        startPreparedClip(preparation);
        return;
    }
    if (preparation.disabled || preparation.committing
            || preparation.response || !preparation.item || preparation.fade) return;
    const { incoming, outgoing } = preparation;
    if (playerBoundaries.get(outgoing)?.tail) return;
    const boundary = playerBoundaries.get(incoming);
    const remaining = playerEffectiveEnd(outgoing) - outgoing.currentTime;
    const clip = endlessPlayback.mode === 'shuffle_clips';
    if ((outgoing.paused && !(clip && outgoing.ended)) || (!clip && outgoing.ended)
            || (playerMediaWaiting.has(outgoing) && !outgoing.ended)
            || remaining > playerFadeLimit(preparation) || (!clip && remaining < 1)
            || (!clip && (endlessPlayback.presentation === 'webkit-fullscreen'
                || document.fullscreenElement === outgoing))
            || incoming.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
            || !Number.isFinite(incoming.duration)
            || (!boundary?.clip && playerEffectiveEnd(incoming) - (boundary?.start || 0) <= PLAYER_FADE_SECONDS)
            || (boundary?.valid && boundary.seekFailed)
            || !boundary?.ready || incoming.seeking) return;
    commitPlayerFade(preparation);
}

function maybePreparePlayer() {
    if (!canPreparePlayer()) return;
    const outgoing = document.getElementById('playerVideo');
    if (playerBoundaries.get(outgoing)?.tail) return;
    const remaining = playerEffectiveEnd(outgoing) - outgoing.currentTime;
    const clip = endlessPlayback.mode === 'shuffle_clips';
    if ((outgoing.paused && !(clip && outgoing.ended)) || (!clip && outgoing.ended)
            || outgoing.seeking || outgoing.playbackRate <= 0
            || playerMediaWaiting.has(outgoing)
            || !Number.isFinite(remaining) || (!clip && remaining <= 0) || remaining > PLAYER_PRELOAD_SECONDS) return;
    if (playerPreparation) {
        maybeCommitPlayerFade(playerPreparation);
        return;
    }
    const preparation = {
        epoch: endlessPlayback.epoch, generation: endlessPlayback.loadGeneration,
        sessionId: endlessPlayback.sessionId,
        expectedId: endlessPlayback.currentDownloadId, sequence: endlessPlayback.sequence + 1,
        outgoing, incoming: document.getElementById('playerStandby'),
        outgoingItem: endlessPlayback.currentItem, controller: new AbortController(),
    };
    if (!preparation.expectedId || endlessPlayback.advancePending) return;
    playerPreparation = preparation;
    preparation.timer = setTimeout(() => preparation.controller.abort(), PLAYER_HANDOFF_TIMEOUT_MS);
    const { incoming } = preparation;
    const onReady = () => {
        // Boundary metadata handlers run before this readiness check.
        queueMicrotask(() => maybeCommitPlayerFade(preparation));
    };
    const onPlaying = () => {
        if (!currentPreparation(preparation) || !preparation.starting || preparation.disabled) return;
        preparation.playing = true;
        if (preparation.playResolved && !preparation.fade) beginPlayerFade(preparation);
    };
    const onFailure = () => failPlayerFade(preparation);
    incoming.addEventListener('loadedmetadata', onReady);
    incoming.addEventListener('canplay', onReady);
    incoming.addEventListener('seeked', onReady);
    incoming.addEventListener('playing', onPlaying);
    incoming.addEventListener('error', onFailure);
    const onWaiting = () => {
        if (preparation.resumePending) preparation.resumeBuffered = true;
        if (preparation.fade && endlessPlayback.mode !== 'shuffle_clips'
                && !preparation.resumePending && !preparation.controlPaused) failPlayerFade(preparation);
    };
    incoming.addEventListener('waiting', onWaiting);
    preparation.cleanup = () => {
        incoming.removeEventListener('loadedmetadata', onReady);
        incoming.removeEventListener('canplay', onReady);
        incoming.removeEventListener('seeked', onReady);
        incoming.removeEventListener('playing', onPlaying);
        incoming.removeEventListener('error', onFailure);
        incoming.removeEventListener('waiting', onWaiting);
        outgoing.classList.remove('player-fade-outgoing');
    };
    apiFetch('/api/playback-sessions/' + encodeURIComponent(endlessPlayback.sessionId) + '/prepare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_download_id: preparation.expectedId, sequence: preparation.sequence,
            ...(endlessPlayback.mode === 'shuffle_clips'
                ? { failed_download_ids: Array.from(endlessPlayback.failedClipIds) } : {}),
        }),
        signal: preparation.controller.signal,
    }).then(async response => {
        if (!response.ok || response.status === 204) throw new Error('No prepared item');
        const data = await response.json();
        if (!currentPreparation(preparation) || preparation.disabled) return;
        if (data.session_id !== preparation.sessionId || data.sequence !== preparation.sequence
                || data.prepared !== true || !data.item?.id) {
            preparation.disabled = true;
            return;
        }
        clearTimeout(preparation.timer);
        preparation.order = data.order;
        loadPreparedPlayer(preparation, data.item);
        maybeCommitPlayerFade(preparation);
    }).catch(() => {
        if (currentPreparation(preparation)) {
            clearTimeout(preparation.timer);
            preparation.disabled = true;
            if (endlessPlayback.mode === 'shuffle_clips') {
                showPlayerTransition('No next clip could be loaded. Retry or stop playback.',
                    ['retry', 'stop', 'close']);
            }
        }
    });
}

function playerVolumeChanged(video) {
    if (!playerIsOpen() || video.id !== 'playerVideo') return;
    const preparation = playerPreparation;
    if (preparation?.fade) {
        if (Math.abs(video.volume - preparation.newVolume) > 0.0001
                && !playerFadeVolumeIsGain(preparation, video.volume)) {
            playerListening.volume = video.volume;
            preparation.baseVolume = playerListening.volume;
            playerListening.muted = video.muted;
        }
        preparation.muted = playerListening.muted;
        applyPlayerFade(preparation);
    } else {
        playerListening.volume = video.volume;
        playerListening.muted = video.muted;
    }
    video.defaultMuted = playerListening.muted;
    syncPlayerControls();
}

function hidePlayerControls({ force = false } = {}) {
    clearTimeout(playerControlsTimer);
    playerControlsTimer = null;
    const video = playerControl('playerVideo');
    const container = playerControl('playerContainer') || document.querySelector('.player-box');
    const controls = playerControl('playerControls');
    const speed = playerControl('playerSpeed');
    let choosingRate = document.activeElement === speed;
    // Closing a native picker on its current value emits no change event.
    // Engines without :open retain the focused-selector accessibility fallback.
    try { choosingRate = speed.matches(':open'); } catch (_error) { /* Older selector engine. */ }
    if (!force && playerIsOpen() && (video.paused || video.ended || video.seeking
            || (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
                && !(video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && playerMediaProgressing.has(video)))
            || playerMediaWaiting.has(video)
            || !playerControl('playerTransition').hidden || playerSeekDrag || playerSliderInteraction
            || (!playerPointerFocus && container.querySelector(
                '.player-chrome :focus, #playerControls :focus, #playlistQueue :focus'))
            || choosingRate)) {
        // Native picker cancellation can consume every closing input event.
        if (choosingRate) playerControlsTimer = setTimeout(hidePlayerControls, PLAYER_CONTROLS_IDLE_MS);
        return;
    }
    container.classList.remove('player-controls-visible');
    if (playerControlsReady) {
        controls.inert = true;
        const chrome = container.querySelector('.player-chrome');
        if (chrome) chrome.inert = true;
    }
}

function handlePlayerPointerMove(event) {
    const container = playerControl('playerContainer');
    // The last four pixels are toolbar padding, outside every control's hit
    // area. Share this path with mousemove so its compatibility event cannot
    // immediately reveal bars that pointermove just hid.
    const bounds = container.getBoundingClientRect();
    if (playerInFullscreen() && event.pointerType !== 'touch'
            && event.clientY >= bounds.bottom - 4 && event.clientY < bounds.bottom
            && !event.target.closest('button, input, select, a, [role="slider"]')) {
        hidePlayerControls();
        return;
    }
    showPlayerControls();
}

function showPlayerControls() {
    if (!playerIsOpen()) return;
    const container = playerControl('playerContainer') || document.querySelector('.player-box');
    container.classList.add('player-controls-visible');
    if (playerControlsReady) {
        playerControl('playerControls').inert = false;
        const chrome = container.querySelector('.player-chrome');
        if (chrome) chrome.inert = false;
    }
    clearTimeout(playerControlsTimer);
    playerControlsTimer = setTimeout(hidePlayerControls, PLAYER_CONTROLS_IDLE_MS);
}

function showPlayerBuffering() {
    showPlayerTransition('Buffering', [], null, { buffering: true });
}

function updatePlayerBuffering(video, event) {
    if (!playerIsOpen()) return;
    const buffering = playerControl('playerTransition').classList.contains('player-buffering');
    if (buffering && (['playing', 'canplay', 'ended', 'error'].includes(event)
            || (event === 'pause' && !playerPreparation?.buffering)
            || (event === 'seeked' && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA))) {
        showPlayerTransition('', []);
        return;
    }
    // Recovery messages own the panel until their action succeeds. A stalled
    // network request alone is not buffering while cached media still advances.
    if (video.paused || video.ended || video.error || playerRecoveryActive()
            || endlessPlayback.failedGeneration === endlessPlayback.loadGeneration
            || (!buffering && !playerControl('playerTransition').hidden)) return;
    if (event === 'waiting' || (['play', 'seeking', 'stalled'].includes(event)
            && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
            && !playerMediaProgressing.has(video))) showPlayerBuffering();
}

function showPlayerTransition(message, actions = [], focusAction = null, { buffering = false } = {}) {
    const transition = document.getElementById('playerTransition');
    const status = document.getElementById('playerStatus');
    const actionIds = {
        continue: 'playerContinue',
        fullscreen: 'playerReturnFullscreen',
        retry: 'playerRetry',
        restart: 'playerRestart',
        skip: 'playerSkip',
        stop: 'playerStopEndless',
        settings: 'playerPlaybackSettings',
        close: 'playerTransitionClose',
    };
    // Repeated media events must not repeat the same live-region announcement.
    if (status.textContent !== (message || '')) status.textContent = message || '';
    playerControl('playerBufferingSpinner').hidden = !buffering;
    transition.classList.toggle('player-buffering', buffering);
    Object.entries(actionIds).forEach(([name, id]) => {
        document.getElementById(id).hidden = !actions.includes(name);
    });
    transition.hidden = !message && actions.length === 0;
    syncPlayerControls();
    if (!transition.hidden) showPlayerControls();
    if (focusAction && actionIds[focusAction]) {
        const epoch = endlessPlayback.epoch;
        const generation = endlessPlayback.loadGeneration;
        setTimeout(() => {
            if (!playerIsOpen() || epoch !== endlessPlayback.epoch
                    || generation !== endlessPlayback.loadGeneration) return;
            const button = document.getElementById(actionIds[focusAction]);
            if (!transition.hidden && !button.hidden) button.focus();
        }, 0);
    }
}

function clearPlaybackWatchdog() {
    clearTimeout(endlessPlayback.watchdogTimer);
    endlessPlayback.watchdogTimer = null;
}

function armPlaybackWatchdog(generation) {
    clearPlaybackWatchdog();
    if (!endlessPlayback.active || document.hidden
            || endlessPlayback.failedGeneration === generation) return;
    endlessPlayback.watchdogTimer = setTimeout(() => {
        if (generation !== endlessPlayback.loadGeneration) return;
        handlePlaybackFailure(generation, 'The next video did not become ready in time.');
    }, PLAYER_HANDOFF_TIMEOUT_MS);
}

function applyOriginalPlayerSize(generation) {
    if (generation !== endlessPlayback.loadGeneration) return;
    const video = document.getElementById('playerVideo');
    if (!video.videoWidth || !video.videoHeight) return;
    video.style.width = `${video.videoWidth}px`;
    video.style.height = `${video.videoHeight}px`;
}

function clearPlayerMediaCallbacks() {
    clearPlaybackWatchdog();
    if (playerMediaCleanup) playerMediaCleanup();
    playerMediaCleanup = null;
}

function markPlaybackStarted(generation) {
    if (generation !== endlessPlayback.loadGeneration) return;
    const boundary = playerBoundaries.get(document.getElementById('playerVideo'));
    if (endlessPlayback.mode === 'shuffle_clips') {
        if (!boundary?.clip || !boundary.ready || boundary.failed || boundary.finished) return;
        endlessPlayback.failedClipIds.clear();
        if (endlessPlayback.sequence === 0 && !boundary.occurrence.viewRecorded) {
            boundary.occurrence.viewRecorded = true;
            recordView(endlessPlayback.currentDownloadId);
        }
    }
    clearPlaybackWatchdog();
    endlessPlayback.phase = 'playing';
    endlessPlayback.handoffInProgress = Boolean(playerPreparation?.fade
        || playerPreparation?.committing || playerPreparation?.response);
    endlessPlayback.failureCount = 0;
    endlessPlayback.failedGeneration = null;
    if (endlessPlayback.returnFullscreenNeeded) {
        showPlayerTransition(
            'Playback continued in the overlay.', ['fullscreen'], 'fullscreen',
        );
    } else {
        showPlayerTransition('', []);
    }
}

function handlePlaybackFailure(generation, message) {
    if (generation !== endlessPlayback.loadGeneration
            || endlessPlayback.failedGeneration === generation) return;
    if (!endlessPlayback.active) {
        if (playerIsOpen()) showPlayerTransition(message, ['close']);
        return;
    }
    clearPlaybackWatchdog();
    if (endlessPlayback.mode === 'shuffle_clips') {
        const video = document.getElementById('playerVideo');
        video.pause();
        if (endlessPlayback.currentDownloadId) {
            endlessPlayback.failedClipIds.add(String(endlessPlayback.currentDownloadId));
        }
        clearPlayerPreparation();
    }
    endlessPlayback.failedGeneration = generation;
    endlessPlayback.phase = 'failed';
    endlessPlayback.handoffInProgress = false;
    endlessPlayback.failureCount += 1;
    const selectionSize = endlessPlayback.mode === 'playlist'
        ? endlessPlayback.playlistQueue.length
        : historyTotal;
    const currentLimit = Math.max(1, Math.min(MAX_AUTOMATIC_SKIPS, selectionSize || 1));
    if (endlessPlayback.mode !== 'shuffle_clips' && endlessPlayback.failureCount >= currentLimit) {
        showPlayerTransition(
            message,
            ['retry', 'skip', 'stop', 'close'],
            'retry',
        );
        return;
    }
    showPlayerTransition(`${message} Skipping to the next video.`, []);
    const epoch = endlessPlayback.epoch;
    setTimeout(() => {
        if (epoch === endlessPlayback.epoch && generation === endlessPlayback.loadGeneration) {
            advanceEndlessPlayback();
        }
    }, 0);
}

function observePlaybackPromise(playback, generation) {
    if (!playback || typeof playback.then !== 'function') return;
    playback.then(
        () => markPlaybackStarted(generation),
        error => {
            if (generation !== endlessPlayback.loadGeneration || playerPauseAborted(error)) return;
            if (!endlessPlayback.active) {
                if (playerIsOpen()) showPlayerTransition(
                    error?.name === 'NotAllowedError' ? 'Your browser paused playback. Press Play to continue.'
                        : 'Playback could not start. Press Play to try again.', [],
                );
                return;
            }
            if (error && error.name === 'NotAllowedError') {
                clearPlaybackWatchdog();
                endlessPlayback.phase = 'awaiting-user';
                endlessPlayback.handoffInProgress = false;
                showPlayerTransition(
                    'Your browser paused automatic playback.',
                    ['continue', 'stop', 'close'],
                    'continue',
                );
                return;
            }
            handlePlaybackFailure(
                generation,
                'This video could not be played.',
            );
        },
    );
}

function loadPlaybackItem(item, { automatic = false, seekSeconds = null, adopt = false, waitForRetry = false } = {}) {
    playerRepeatCurrent = false;
    if (!adopt) clearPlayerPreparation();
    const video = document.getElementById('playerVideo');
    if (!adopt) {
        playerMediaProgressing.delete(video);
        playerMediaTimes.delete(video);
        playerMediaWaiting.delete(video);
    }
    clearPlayerMediaCallbacks();
    playerSeekDrag = null;
    playerSliderInteraction = false;
    const volume = playerControl('playerMute').closest('.player-volume-control');
    volume.classList.remove('volume-adjusting', 'volume-touch-open');
    volume.classList.toggle('volume-keyboard-open', !playerPointerFocus && volume.contains(document.activeElement));
    showPlayerTransition('', []);
    const generation = ++endlessPlayback.loadGeneration;
    const epoch = endlessPlayback.epoch;
    const boundary = adopt ? playerBoundaries.get(video)
        : createPlayerBoundary(video, {
            seekSeconds, clipOccurrence: shuffleClipOccurrence(item),
            onFailure: () => handlePlaybackFailure(generation, 'This video cannot supply a valid clip.'),
            current: () => epoch === endlessPlayback.epoch
                && generation === endlessPlayback.loadGeneration,
        });
    if (adopt && boundary) {
        boundary.current = () => epoch === endlessPlayback.epoch
            && generation === endlessPlayback.loadGeneration;
        if (boundary.clip) boundary.onFailure = () => handlePlaybackFailure(
            generation, 'This video cannot supply a valid clip.',
        );
    }
    endlessPlayback.phase = 'loading';
    endlessPlayback.failedGeneration = null;
    endlessPlayback.currentItem = item;
    endlessPlayback.currentDownloadId = String(item.id);
    setPlayerStandby(video, false);
    if (!adopt) applyPlayerListening(video);
    syncPlayerControls();
    showPlayerControls();
    video.style.removeProperty('width');
    video.style.removeProperty('height');

    const current = callback => event => {
        if (epoch === endlessPlayback.epoch
                && generation === endlessPlayback.loadGeneration) callback(event);
    };
    const onMetadata = current(() => {
        if (!boundary?.enabled && Number.isFinite(Number(seekSeconds))) {
            const requested = Math.max(0, Number(seekSeconds));
            const duration = Number(video.duration);
            video.currentTime = Number.isFinite(duration)
                ? Math.min(requested, duration)
                : requested;
        }
        applyOriginalPlayerSize(generation);
        if (!boundary?.clip) armPlaybackWatchdog(generation);
    });
    const onResize = current(() => applyOriginalPlayerSize(generation));
    const onCanPlay = current(() => { if (!boundary?.clip) armPlaybackWatchdog(generation); });
    let listeningPending = !adopt;
    const onPlaying = current(() => {
        // WebKit can restore its prior output mute on source startup, after
        // metadata. Reconcile once, then let ordinary mute events stay authoritative.
        if (listeningPending) {
            listeningPending = false;
            if (playerListening.muted && !video.muted) video.muted = true;
        }
        markPlaybackStarted(generation);
    });
    const onError = current(() => {
        if (playerPreparation?.fade) failPlayerFade(playerPreparation);
        else handlePlaybackFailure(
            generation, 'This video is missing or uses an unsupported format.',
        );
    });
    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('resize', onResize);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('error', onError);
    playerMediaCleanup = () => {
        video.removeEventListener('loadedmetadata', onMetadata);
        video.removeEventListener('resize', onResize);
        video.removeEventListener('canplay', onCanPlay);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('error', onError);
    };

    video.setAttribute('aria-label', item.title || 'Video playback');
    if (adopt) {
        applyOriginalPlayerSize(generation);
        return generation;
    }

    // Clear any previous <source> children and src attribute before reloading.
    // Setting video.src directly doesn't carry a type hint; using a <source>
    // element with an explicit type lets the browser decide playability before
    // fetching, which is what makes WEBM work on browsers that need the hint.
    video.removeAttribute('src');
    video.innerHTML = '';
    const source = document.createElement('source');
    // With <source> children, an unsupported response can fail on the child
    // without a video error event. It must replace buffering with recovery too.
    source.addEventListener('error', onError, { once: true });
    source.src = '/api/file/' + encodeURIComponent(item.id);
    const mime = _VIDEO_MIME[item.extension] || null;
    if (mime) source.type = mime;
    video.appendChild(source);
    video.autoplay = !waitForRetry && !boundary.enabled;
    video.load();
    if (!waitForRetry) showPlayerBuffering();
    if (endlessPlayback.active) armPlaybackWatchdog(generation);
    if (automatic || (boundary.enabled && !waitForRetry)) {
        playPlayerVideo(video, generation);
    }
    return generation;
}

function requestPlayerFullscreen({ launch = false } = {}) {
    const epoch = endlessPlayback.epoch;
    const requestId = ++playerFullscreenRequest;
    const current = () => playerIsOpen() && epoch === endlessPlayback.epoch
        && requestId === playerFullscreenRequest;
    const video = document.getElementById('playerVideo');
    try {
        if (playerInFullscreen()) return;
        const container = playerControl('playerContainer');
        const target = document.fullscreenEnabled === false ? null
            : container?.requestFullscreen ? container : video;
        if (target?.requestFullscreen) {
            if (target === video) video.controls = true;
            if (launch) playerStartedFullscreen = true;
            const request = target.requestFullscreen();
            if (request) request.catch(() => {
                if (!current()) return;
                video.controls = !playerControlsReady;
                if (launch) {
                    playerStartedFullscreen = false;
                    endlessPlayback.launchProvenance = 'original';
                } else if (endlessPlayback.active) {
                    endlessPlayback.returnFullscreenNeeded = true;
                    showPlayerTransition(
                        'Fullscreen could not be restored. Try again from this button.',
                        ['fullscreen', 'stop', 'close'],
                        'fullscreen',
                    );
                }
            });
            return;
        }
        if (video.webkitEnterFullscreen) {
            video.controls = true;
            if (launch) playerStartedFullscreen = true;
            video.webkitEnterFullscreen();
        }
    } catch (error) {
        if (!current()) return;
        video.controls = !playerControlsReady;
        if (launch) {
            playerStartedFullscreen = false;
            endlessPlayback.launchProvenance = 'original';
        } else if (endlessPlayback.active) {
            endlessPlayback.returnFullscreenNeeded = true;
            showPlayerTransition(
                'Fullscreen could not be restored. Try again from this button.',
                ['fullscreen', 'stop', 'close'],
                'fullscreen',
            );
        }
        // Full screen is browser-controlled; the overlay remains usable.
    }
}

function openBuiltInPlayer({ fullscreen = false, requestFullscreen = true } = {}) {
    const backdrop = document.getElementById('playerBackdrop');
    if (!backdrop.classList.contains('open')) playerReturnFocus = document.activeElement;
    backdrop.classList.add('open');
    backdrop.querySelector('.player-box').classList.remove('playlist-queue-collapsed');
    showPlayerControls();
    syncPlayerControls();
    if (playerControlsReady) playerControl('playerContainer').focus({ preventScroll: true });
    document.getElementById('playerMediaStage').classList.toggle('player-continuous',
        endlessPlayback.active && ['sequential', 'shuffle', 'shuffle_clips'].includes(endlessPlayback.mode));
    endlessPlayback.launchProvenance = fullscreen ? 'fullscreen' : 'original';
    endlessPlayback.presentation = 'original';
    playerStartedFullscreen = false;
    if (fullscreen && requestFullscreen) requestPlayerFullscreen({ launch: true });
}

function releasePlaybackLease(sessionId) {
    if (!sessionId) return;
    fetch('/api/playback-sessions/' + encodeURIComponent(sessionId), {
        method: 'DELETE',
        keepalive: true,
    }).catch(() => {});
}

function deactivateEndlessPlayback({ release = true } = {}) {
    playerRepeatCurrent = false;
    const clips = endlessPlayback.mode === 'shuffle_clips';
    // Playback promises can settle while the replacement session is opening.
    if (clips) endlessPlayback.loadGeneration += 1;
    endlessPlayback.active = false;
    finishPlayerFade();
    clearPlayerPreparation();
    if (clips) {
        clearPlayerMediaCallbacks();
        unloadPlayerMedia(document.getElementById('playerVideo'));
        unloadPlayerMedia(document.getElementById('playerStandby'));
    }
    const sessionId = endlessPlayback.sessionId;
    clearInterval(endlessPlayback.keepaliveTimer);
    endlessPlayback.keepaliveTimer = null;
    clearInterval(endlessPlayback.progressTimer);
    endlessPlayback.progressTimer = null;
    endlessPlayback.active = false;
    document.getElementById('playerMediaStage').classList.remove('player-continuous');
    document.getElementById('playerVideo').controlsList?.remove('nofullscreen');
    endlessPlayback.sessionId = null;
    endlessPlayback.sequence = 0;
    endlessPlayback.advancePending = false;
    endlessPlayback.handoffInProgress = false;
    endlessPlayback.returnFullscreenNeeded = false;
    endlessPlayback.clipOccurrences.clear();
    endlessPlayback.failedClipIds.clear();
    if (release) releasePlaybackLease(sessionId);
}

function playVideo(id, label, ext) {
    const url = '/api/file/' + encodeURIComponent(id);
    if (playerMode === 'new_tab') {
        window.open(url, '_blank', 'noopener');
        return;
    }
    endlessPlayback.epoch += 1;
    deactivateEndlessPlayback();
    endlessPlayback.mode = 'sequential';
    endlessPlayback.phase = 'loading';
    document.getElementById('playlistQueue').hidden = true;
    document.querySelector('.player-box').classList.remove('playlist-player');
    openBuiltInPlayer({
        fullscreen: startVideosFullscreen,
        requestFullscreen: false,
    });
    loadPlaybackItem({ id, title: label, extension: ext, filenameTitle: true });
    if (startVideosFullscreen) requestPlayerFullscreen({ launch: true });
}

function recordView(id) {
    // Playback starts immediately; view accounting must never make opening the
    // player depend on a second network round trip.
    apiFetch('/api/view/' + encodeURIComponent(id), { method: 'POST' })
        .catch(() => {});
}

function closePlayer() {
    const backdrop = document.getElementById('playerBackdrop');
    const video = document.getElementById('playerVideo');
    const closeButton = backdrop.querySelector('.player-close');
    if (video.webkitDisplayingFullscreen || endlessPlayback.presentation === 'webkit-fullscreen') {
        playerStartedFullscreen = false;
        endlessPlayback.presentation = 'original';
        try { video.webkitExitFullscreen?.(); } catch (_error) { /* Cleanup still closes the overlay. */ }
    }
    if (endlessPlayback.active && endlessPlayback.mode === 'playlist') {
        savePlaylistProgress({ force: true, keepalive: true });
    }
    endlessPlayback.epoch += 1;
    endlessPlayback.loadGeneration += 1;
    playerFullscreenRequest += 1;
    deactivateEndlessPlayback();
    clearPlayerMediaCallbacks();
    endlessPlayback.phase = 'idle';
    endlessPlayback.currentDownloadId = null;
    endlessPlayback.currentItem = null;
    endlessPlayback.playlistId = null;
    endlessPlayback.playlistRevision = null;
    endlessPlayback.playlistQueue = [];
    endlessPlayback.playlistPosition = null;
    endlessPlayback.progressSequence = 0;
    endlessPlayback.lastSavedPosition = null;
    clearInterval(endlessPlayback.progressTimer);
    endlessPlayback.progressTimer = null;
    playerStartedFullscreen = false;
    playerSeekDrag = null;
    playerSliderInteraction = false;
    playerRepeatCurrent = false;
    playerPointerFocus = false;
    playerControl('playerMute').closest('.player-volume-control').classList.remove('volume-adjusting', 'volume-touch-open', 'volume-keyboard-open');
    hidePlayerControls({ force: true });
    showPlayerTransition('', []);
    if (document.activeElement === closeButton) closeButton.blur();
    playerBoundaries.get(video)?.cleanup();
    video.pause();
    video.style.removeProperty('width');
    video.style.removeProperty('height');
    video.removeAttribute('src');
    video.innerHTML = '';
    video.load();
    backdrop.classList.remove('open');
    clearTimeout(playerControlsTimer);
    playerControlsTimer = null;
    const restoreFocus = [playerReturnFocus, document.getElementById('historySearchToggle'),
        document.getElementById('endlessPlaybackButton')].find(target => target?.isConnected
            && target !== document.body && !target.disabled
            && !target.closest('[hidden], [inert]') && target.getClientRects().length);
    playerReturnFocus = null;
    restoreFocus?.focus({ preventScroll: true });
    backdrop.querySelector('.player-box').classList.remove('playlist-player');
    document.getElementById('playlistQueue').hidden = true;
    if (document.fullscreenElement && [playerControl('playerContainer'), playerControl('playerMediaStage'), video].includes(document.fullscreenElement)) {
        document.exitFullscreen()?.catch(() => {});
    }
}

async function playbackResponseError(response) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || response.statusText || 'Playback request failed');
    error.code = data.code || null;
    return error;
}

function startPlaybackKeepalive(epoch) {
    clearInterval(endlessPlayback.keepaliveTimer);
    endlessPlayback.keepaliveTimer = setInterval(() => {
        if (epoch !== endlessPlayback.epoch || !endlessPlayback.sessionId) return;
        apiFetch(
            '/api/playback-sessions/'
                + encodeURIComponent(endlessPlayback.sessionId)
                + '/keepalive',
            { method: 'POST' },
        ).then(response => {
            if (response.status === 404 && epoch === endlessPlayback.epoch) {
                deactivateEndlessPlayback({ release: false });
                showPlayerTransition(
                    'The endless playback session expired. Start a new session to continue.',
                    ['restart', 'close'],
                    'restart',
                );
            }
        }).catch(() => {});
    }, PLAYBACK_KEEPALIVE_MS);
}

function historyPositionForId(id) {
    const position = historyPageItems.findIndex(
        item => String(item.id) === String(id),
    );
    return Math.max(0, position);
}

function startEndlessPlaybackFromView() {
    const first = historyPageItems.find(
        item => item.status === 'finished' && item.filename,
    );
    if (!first) return;
    const label = first.filename.split('/').pop().split('\\').pop();
    const extension = first.filename.split('.').pop().toLowerCase();
    startEndlessPlayback(first.id, label, extension, 'sequential');
}

function startSequentialPlayback() {
    closePlaybackModeMenu();
    startEndlessPlaybackFromView();
}

function startShufflePlayback(mode = 'shuffle') {
    closePlaybackModeMenu();
    startEndlessPlayback(null, '', '', mode);
}

function renderPlaylistQueue() {
    const queue = document.getElementById('playlistQueueItems');
    queue.innerHTML = endlessPlayback.playlistQueue.map((item, index) => {
        const active = index === endlessPlayback.playlistPosition;
        const duration = formatMediaDuration(item.duration_seconds);
        if (item.unavailable || !item.id) {
            return `<div class="playlist-queue-row is-unavailable" data-queue-position="${index}"><span class="playlist-queue-number">${index + 1}</span><span class="playlist-queue-thumb"><svg><use href="#i-camera"/></svg></span><span><strong>Unavailable video</strong><small>Skipped during playback</small></span></div>`;
        }
        return `<button type="button" class="playlist-queue-row${active ? ' is-active' : ''}" data-queue-position="${index}" onclick="selectPlaylistQueueItem('${escapeAttr(item.id)}')" ${active ? 'aria-current="true"' : ''}>
            <span class="playlist-queue-number">${index + 1}</span>
            ${assetImage(item.id)}
            <span><strong>${escapeHtml(item.title || 'Untitled video')}</strong>${duration ? `<small>${duration}</small>` : ''}</span>
        </button>`;
    }).join('');
    requestAnimationFrame(() => {
        const active = queue.querySelector('[aria-current="true"]');
        if (active) active.scrollIntoView({ block: 'nearest' });
    });
}

function savePlaylistProgress({ force = false, keepalive = false } = {}) {
    if (!endlessPlayback.active || endlessPlayback.mode !== 'playlist'
            || !endlessPlayback.playlistId
            || !endlessPlayback.currentDownloadId) return Promise.resolve();
    const video = document.getElementById('playerVideo');
    const position = Math.max(0, Number(video.currentTime) || 0);
    if (!force && endlessPlayback.lastSavedPosition !== null
            && Math.abs(position - endlessPlayback.lastSavedPosition) < 1) {
        return Promise.resolve();
    }
    endlessPlayback.progressSequence += 1;
    const sequence = endlessPlayback.progressSequence;
    endlessPlayback.lastSavedPosition = position;
    return fetch(
        '/api/playlists/' + encodeURIComponent(endlessPlayback.playlistId) + '/progress',
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                download_id: endlessPlayback.currentDownloadId,
                position_seconds: position,
                completed: false,
                write_sequence: sequence,
            }),
            keepalive,
        },
    ).then(response => {
        if (!response.ok && !keepalive) {
            return playbackResponseError(response).then(error => { throw error; });
        }
        return response.ok;
    }).catch(error => {
        if (!keepalive) showPlayerTransition(
            error.message || 'Playlist progress could not be saved.',
            ['retry', 'close'],
        );
        return false;
    });
}

function startPlaylistProgressTimer() {
    clearInterval(endlessPlayback.progressTimer);
    endlessPlayback.progressTimer = setInterval(() => {
        const video = document.getElementById('playerVideo');
        if (!video.paused && !video.ended) savePlaylistProgress();
    }, PLAYLIST_PROGRESS_SAVE_MS);
}

function startPlaylistPlayback(playlistId, restart = false) {
    closeAllMenus();
    endlessPlayback.epoch += 1;
    const epoch = endlessPlayback.epoch;
    deactivateEndlessPlayback();
    endlessPlayback.active = true;
    endlessPlayback.mode = 'playlist';
    endlessPlayback.phase = 'opening';
    endlessPlayback.failureCount = 0;
    endlessPlayback.playlistId = String(playlistId);
    endlessPlayback.returnFullscreenNeeded = false;
    openBuiltInPlayer({ fullscreen: startVideosFullscreen, requestFullscreen: false });
    document.querySelector('.player-box').classList.add('playlist-player');
    document.getElementById('playlistQueue').hidden = false;
    document.getElementById('playlistQueueItems').innerHTML = '';
    showPlayerTransition('Opening playlist…', []);
    if (startVideosFullscreen) requestPlayerFullscreen({ launch: true });

    apiFetch('/api/playback-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mode: 'playlist', playlist_id: String(playlistId), restart,
        }),
    }).then(async response => {
        if (epoch !== endlessPlayback.epoch || !endlessPlayback.active) return;
        if (response.status === 204) {
            deactivateEndlessPlayback({ release: false });
            showPlayerTransition('This playlist has no playable videos.', ['close']);
            return;
        }
        if (!response.ok) throw await playbackResponseError(response);
        const data = await response.json();
        if (epoch !== endlessPlayback.epoch || !endlessPlayback.active) {
            releasePlaybackLease(data.session_id);
            return;
        }
        endlessPlayback.sessionId = data.session_id;
        endlessPlayback.sequence = data.sequence;
        endlessPlayback.playlistRevision = data.playlist_revision;
        endlessPlayback.playlistQueue = data.queue || [];
        endlessPlayback.playlistPosition = data.queue_position;
        endlessPlayback.progressSequence = data.progress_sequence || 0;
        endlessPlayback.currentDownloadId = String(data.item.id);
        endlessPlayback.lastSavedPosition = Number(data.resume_seconds) || 0;
        renderPlaylistQueue();
        loadPlaybackItem(data.item, {
            automatic: true,
            seekSeconds: data.resume_seconds,
        });
        recordView(data.item.id);
        startPlaybackKeepalive(epoch);
        startPlaylistProgressTimer();
    }).catch(error => {
        if (epoch !== endlessPlayback.epoch || !endlessPlayback.active) return;
        deactivateEndlessPlayback({ release: false });
        showPlayerTransition(
            error.message || 'The playlist could not be opened.', ['close'],
        );
    });
}

async function selectPlaylistQueueItem(downloadId) {
    if (endlessPlayback.mode !== 'playlist' || !endlessPlayback.sessionId
            || playerNavigationBusy()
            || String(downloadId) === endlessPlayback.currentDownloadId) return;
    const epoch = endlessPlayback.epoch;
    endlessPlayback.advancePending = true;
    syncPlayerControls();
    const saved = await savePlaylistProgress({ force: true });
    if (!saved || epoch !== endlessPlayback.epoch || !endlessPlayback.active) {
        if (epoch === endlessPlayback.epoch) endlessPlayback.advancePending = false;
        syncPlayerControls();
        return;
    }
    const sequence = endlessPlayback.sequence + 1;
    const expectedId = endlessPlayback.currentDownloadId;
    endlessPlayback.advancePending = true;
    showPlayerTransition('Loading selected video…', []);
    try {
        const response = await apiFetch(
            '/api/playback-sessions/' + encodeURIComponent(endlessPlayback.sessionId)
                + '/select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    expected_download_id: expectedId,
                    download_id: String(downloadId),
                    sequence,
                }),
            },
        );
        if (!response.ok) throw await playbackResponseError(response);
        const data = await response.json();
        if (epoch !== endlessPlayback.epoch || !endlessPlayback.active) return;
        endlessPlayback.sequence = data.sequence;
        endlessPlayback.currentDownloadId = String(data.item.id);
        endlessPlayback.playlistPosition = data.queue_position;
        endlessPlayback.progressSequence = Math.max(
            endlessPlayback.progressSequence, data.progress_sequence || 0,
        );
        endlessPlayback.lastSavedPosition = 0;
        renderPlaylistQueue();
        loadPlaybackItem(data.item, { automatic: true });
        recordView(data.item.id);
    } catch (error) {
        if (epoch === endlessPlayback.epoch) showPlayerTransition(
            error.message || 'The selected video could not be loaded.',
            ['retry', 'close'],
        );
    } finally {
        if (epoch === endlessPlayback.epoch) endlessPlayback.advancePending = false;
        syncPlayerControls();
    }
}

function startEndlessPlayback(id = null, label = '', extension = '', mode = 'sequential') {
    if (mode === 'sequential' && !durationSearchConditions().valid) return;
    if (mode === 'sequential' && !id && historyTotal === 0) return;
    endlessPlayback.epoch += 1;
    const epoch = endlessPlayback.epoch;
    const replaceClips = mode === 'shuffle_clips' && endlessPlayback.mode !== 'shuffle_clips';
    deactivateEndlessPlayback();
    if (replaceClips) {
        clearPlayerMediaCallbacks();
        unloadPlayerMedia(document.getElementById('playerVideo'));
        unloadPlayerMedia(document.getElementById('playerStandby'));
    }
    endlessPlayback.active = true;
    endlessPlayback.mode = mode;
    endlessPlayback.phase = 'opening';
    endlessPlayback.failureCount = 0;
    endlessPlayback.failedClipIds.clear();
    endlessPlayback.clipOccurrences.clear();
    endlessPlayback.returnFullscreenNeeded = false;
    document.getElementById('playlistQueue').hidden = true;
    document.querySelector('.player-box').classList.remove('playlist-player');
    openBuiltInPlayer({
        fullscreen: startVideosFullscreen,
        requestFullscreen: false,
    });

    const awaitSelection = mode === 'sequential';
    // A settings save in another tab can invalidate even an ordinary launch.
    // Wait for accepted selection before loading media or recording its view.
    showPlayerTransition(
        mode === 'shuffle_clips' ? 'Starting Shuffle Clips…' : mode === 'shuffle' ? 'Starting shuffle…' : 'Starting endless playback…',
        [],
    );
    if (startVideosFullscreen) requestPlayerFullscreen({ launch: true });

    const historyPosition = id ? historyPositionForId(id) : 0;
    const playbackPageSize = endlessHistoryEnabled()
        ? ENDLESS_PLAYBACK_PAGE_SIZE
        : historyPageSize;
    const body = ['shuffle', 'shuffle_clips'].includes(mode) ? { mode } : {
        mode: 'sequential',
        filter: historySearchInput.value,
        ordering: historyOrdering,
        page_size: playbackPageSize,
        page: endlessHistoryEnabled()
            ? Math.floor(historyPosition / playbackPageSize)
            : historyPage,
        position: endlessHistoryEnabled()
            ? historyPosition % playbackPageSize
            : historyPosition,
    };
    if (mode === 'sequential') {
        body.generation_id = libraryOrder.generation_id;
        if (id) body.start_download_id = String(id);
    }
    apiFetch('/api/playback-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(async response => {
        if (response.status === 204) {
            if (epoch !== endlessPlayback.epoch || !endlessPlayback.active) return;
            deactivateEndlessPlayback({ release: false });
            showPlayerTransition('No playable videos remain in this selection.', ['close']);
            return;
        }
        if (!response.ok) {
            if (epoch !== endlessPlayback.epoch || !endlessPlayback.active) return;
            const error = await playbackResponseError(response);
            if (error.code === 'no_shuffle_candidates' || error.code === 'no_shuffle_clip_candidates') {
                endlessPlayback.phase = 'create-failed';
                showPlayerTransition(error.message,
                    mode === 'shuffle_clips' ? ['retry', 'settings', 'stop', 'close'] : ['settings', 'close'],
                    mode === 'shuffle_clips' ? 'retry' : 'settings');
                return;
            }
            if (error.code === 'rotation_generation_changed') {
                invalidateLibraryOrder();
                await fetchHistory();
                if (epoch !== endlessPlayback.epoch || !endlessPlayback.active) return;
                endlessPlayback.phase = 'create-failed';
                showPlayerTransition('The Library rotation changed. Retry to start from the refreshed selection.',
                    ['retry', 'close'], 'retry');
                return;
            }
            if (error.code === 'shuffle_metadata_pending') {
                endlessPlayback.phase = 'create-failed';
                showPlayerTransition(
                    mode === 'shuffle_clips' ? 'Older videos are still being prepared for Shuffle Clips.'
                        : 'Older videos are still being prepared for Shuffle.',
                    mode === 'shuffle_clips' ? ['retry', 'stop', 'close'] : ['retry', 'close'],
                    'retry',
                );
                return;
            }
            throw error;
        }
        const data = await response.json();
        if (epoch !== endlessPlayback.epoch || !endlessPlayback.active) {
            releasePlaybackLease(data.session_id);
            return;
        }
        endlessPlayback.sessionId = data.session_id;
        endlessPlayback.mode = data.mode || mode;
        endlessPlayback.sequence = data.sequence;
        endlessPlayback.currentDownloadId = String(data.item.id);
        startPlaybackKeepalive(epoch);
        syncPlayerControls();
        loadPlaybackItem(data.item, { automatic: true });
        if (mode !== 'shuffle_clips') recordView(data.item.id);
        maybePreparePlayer();
    }).catch(error => {
        if (epoch !== endlessPlayback.epoch || !endlessPlayback.active) return;
        if (awaitSelection) {
            endlessPlayback.phase = 'create-failed';
            showPlayerTransition(error.message || 'Play All could not start. Try again.',
                ['retry', 'close'], 'retry');
            return;
        }
        deactivateEndlessPlayback({ release: false });
        showPlayerTransition(
            `${error.message || 'Endless playback could not start.'} The current video can still be played.`,
            ['close'],
        );
    });
}

function advanceEndlessPlayback(completed = false, preparedResponse = null, recoverPrepared = false) {
    if (!endlessPlayback.active || !endlessPlayback.sessionId
            || endlessPlayback.advancePending) return;
    const epoch = endlessPlayback.epoch;
    const sessionId = endlessPlayback.sessionId;
    const expectedId = endlessPlayback.currentDownloadId;
    const nextSequence = endlessPlayback.sequence + 1;
    endlessPlayback.advancePending = true;
    endlessPlayback.handoffInProgress = true;
    endlessPlayback.phase = 'advancing';
    clearPlaybackWatchdog();
    showPlayerTransition(
        endlessPlayback.mode === 'shuffle'
            ? 'Loading a random video'
            : 'Loading next video',
        [],
    );
    clearPlayerPreparation();
    const generation = endlessPlayback.loadGeneration;
    (preparedResponse ? Promise.resolve(preparedResponse) : apiFetch(
        '/api/playback-sessions/' + encodeURIComponent(sessionId) + '/advance',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                expected_download_id: expectedId,
                sequence: nextSequence,
                completed: endlessPlayback.mode === 'playlist' && completed,
                ...(endlessPlayback.mode === 'shuffle_clips'
                    ? { failed_download_ids: Array.from(endlessPlayback.failedClipIds) } : {}),
            }),
        },
    )).then(async response => {
        if (epoch !== endlessPlayback.epoch || generation !== endlessPlayback.loadGeneration
                || !endlessPlayback.active) return;
        if (response.status === 204) {
            const mode = endlessPlayback.mode;
            deactivateEndlessPlayback({ release: false });
            showPlayerTransition(
                mode === 'playlist'
                    ? (completed ? 'Playlist complete.' : 'No playable videos remain in this playlist.')
                    : mode === 'shuffle'
                    ? 'No eligible videos remain.'
                    : 'No playable videos remain in this selection.',
                ['close'],
            );
            return;
        }
        if (response.status === 404) {
            deactivateEndlessPlayback({ release: false });
            showPlayerTransition(
                'The endless playback session expired. Start a new session to continue.',
                ['restart', 'close'],
                'restart',
            );
            return;
        }
        if (!response.ok) throw await playbackResponseError(response);
        const data = await response.json();
        if (epoch !== endlessPlayback.epoch || generation !== endlessPlayback.loadGeneration
                || !endlessPlayback.active) return;
        endlessPlayback.sequence = data.sequence;
        endlessPlayback.currentDownloadId = String(data.item.id);
        if (endlessPlayback.mode === 'playlist') {
            endlessPlayback.playlistPosition = data.queue_position;
            endlessPlayback.progressSequence = data.progress_sequence;
            endlessPlayback.lastSavedPosition = 0;
            renderPlaylistQueue();
            recordView(data.item.id);
        }
        loadPlaybackItem(data.item, { automatic: !recoverPrepared, waitForRetry: recoverPrepared });
        if (recoverPrepared) {
            clearPlaybackWatchdog();
            endlessPlayback.phase = 'failed';
            endlessPlayback.failedGeneration = endlessPlayback.loadGeneration;
            endlessPlayback.handoffInProgress = false;
            showPlayerTransition('The next video stalled during the transition.',
                ['retry', 'skip', 'stop', 'close'], 'retry');
        }
    }).catch(error => {
        if (epoch !== endlessPlayback.epoch || !endlessPlayback.active) return;
        endlessPlayback.phase = 'failed';
        // Retry must repeat the same idempotent advance request instead of
        // attempting to replay the media item that has already ended.
        endlessPlayback.handoffInProgress = true;
        showPlayerTransition(
            error.message || 'The next video could not be loaded.',
            ['retry', 'stop', 'close'],
            'retry',
        );
    }).finally(() => {
        if (epoch === endlessPlayback.epoch) endlessPlayback.advancePending = false;
        syncPlayerControls();
    });
}

function continueEndlessPlayback() {
    retryEndlessPlayback();
}

function restartEndlessPlayback() {
    if (['shuffle', 'shuffle_clips'].includes(endlessPlayback.mode)) {
        startShufflePlayback(endlessPlayback.mode);
        return;
    }
    if (endlessPlayback.mode === 'playlist' && endlessPlayback.playlistId) {
        startPlaylistPlayback(endlessPlayback.playlistId);
        return;
    }
    const item = endlessPlayback.currentItem;
    if (!item) return;
    startEndlessPlayback(item.id, item.title, item.extension);
}

function retryEndlessPlayback() {
    if (!endlessPlayback.active) return;
    if (endlessPlayback.mode === 'shuffle_clips' && playerPreparation?.disabled
            && !playerPreparation.fade) {
        endlessPlayback.failedClipIds.clear();
        const preparation = playerPreparation;
        if (preparation.data && !preparation.failedDuringFade) {
            preparation.disabled = false;
            loadPreparedPlayer(preparation, preparation.data.item);
        } else if (preparation.failedDuringFade) {
            usePreparedPlayerHandoff();
        } else {
            clearPlayerPreparation();
            maybePreparePlayer();
        }
        showPlayerTransition('', []);
        return;
    }
    if (endlessPlayback.phase === 'create-failed' && endlessPlayback.mode === 'sequential') {
        startEndlessPlaybackFromView();
        return;
    }
    if (endlessPlayback.phase === 'create-failed'
            && ['shuffle', 'shuffle_clips'].includes(endlessPlayback.mode)) {
        startShufflePlayback(endlessPlayback.mode);
        return;
    }
    if (endlessPlayback.phase === 'failed' && endlessPlayback.handoffInProgress) {
        if (endlessPlayback.mode === 'shuffle_clips') endlessPlayback.failedClipIds.clear();
        advanceEndlessPlayback();
        return;
    }
    const generation = endlessPlayback.loadGeneration;
    if (endlessPlayback.mode === 'shuffle_clips' && playerBoundaries.get(document.getElementById('playerVideo'))?.failed) {
        endlessPlayback.failedClipIds.clear();
        loadPlaybackItem(endlessPlayback.currentItem, { automatic: true });
        return;
    }
    endlessPlayback.failedGeneration = null;
    endlessPlayback.phase = 'loading';
    showPlayerTransition('Resuming playback…', []);
    playPlayerVideo(document.getElementById('playerVideo'), generation);
    armPlaybackWatchdog(generation);
}

function skipEndlessPlayback() {
    if (!endlessPlayback.active) return;
    endlessPlayback.failedGeneration = endlessPlayback.loadGeneration;
    advanceEndlessPlayback();
}

function stopEndlessPlayback() {
    if (!endlessPlayback.active) return;
    const clips = endlessPlayback.mode === 'shuffle_clips';
    if (clips) {
        endlessPlayback.epoch += 1;
        endlessPlayback.loadGeneration += 1;
    }
    deactivateEndlessPlayback();
    endlessPlayback.phase = 'playing';
    showPlayerTransition('Endless playback stopped.', ['close']);
}

function openPlaybackSettingsFromPlayer() {
    closePlayer();
    openSettings().then(() => {
        settingsSearchInput.value = '';
        applySettingsSearch();
        setActiveSettingsSection('playback');
        scrollToSettingsSection('playback',
            window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
    });
}

function returnEndlessFullscreen() {
    if (!endlessPlayback.active) return;
    endlessPlayback.returnFullscreenNeeded = false;
    requestPlayerFullscreen();
    if (endlessPlayback.phase === 'awaiting-user') continueEndlessPlayback();
    else showPlayerTransition('', []);
}

function handleFullscreenExit() {
    const video = playerControl('playerVideo');
    video.controls = !playerControlsReady;
    const backdrop = document.getElementById('playerBackdrop');
    if (!backdrop.classList.contains('open')) return;
    endlessPlayback.presentation = 'original';
    if (endlessPlayback.active && endlessPlayback.handoffInProgress) {
        endlessPlayback.returnFullscreenNeeded = true;
        showPlayerTransition(
            'Fullscreen ended while the next video was loading.',
            ['fullscreen'],
            'fullscreen',
        );
        return;
    }
    if (playerStartedFullscreen
            && endlessPlayback.launchProvenance === 'fullscreen') closePlayer();
}

document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement && [playerControl('playerContainer'), playerControl('playerMediaStage'), playerControl('playerVideo')].includes(document.fullscreenElement)) {
        endlessPlayback.presentation = 'standard-fullscreen';
        return;
    }
    if (!document.fullscreenElement) handleFullscreenExit();
});

for (const video of document.querySelectorAll('#playerMediaStage video')) {
    let nativeFullscreenEpoch = null;
    video.addEventListener('webkitbeginfullscreen', () => {
        nativeFullscreenEpoch = endlessPlayback.epoch;
        video.controls = true;
        endlessPlayback.presentation = 'webkit-fullscreen';
        syncPlayerControls();
    });
    video.addEventListener('webkitendfullscreen', () => {
        video.controls = !playerControlsReady;
        if (nativeFullscreenEpoch !== endlessPlayback.epoch) {
            nativeFullscreenEpoch = null;
            return;
        }
        nativeFullscreenEpoch = null;
        handleFullscreenExit();
        syncPlayerControls();
        showPlayerControls();
    });
    video.addEventListener('timeupdate', () => {
        const previousTime = playerMediaTimes.get(video);
        // WebKit can keep HAVE_CURRENT_DATA after a seek even as its clock
        // advances. Actual forward progress also proves that waiting ended.
        if (video.currentTime > previousTime && !video.seeking && !video.paused) {
            const resumed = !playerMediaProgressing.has(video);
            playerMediaProgressing.add(video);
            playerMediaWaiting.delete(video);
            if (video.id === 'playerVideo' && playerIsOpen()) {
                if (playerControl('playerTransition').classList.contains('player-buffering')) {
                    showPlayerTransition('', []);
                }
                if (resumed) showPlayerControls();
            }
        }
        playerMediaTimes.set(video, video.currentTime);
        checkPlayerBoundary(video);
        if (playerPreparation?.fade) applyPlayerFade(playerPreparation);
        if (video.id === 'playerVideo') maybePreparePlayer();
    });
    video.addEventListener('playing', () => {
        playerMediaWaiting.delete(video);
        if (video.id === 'playerVideo') maybePreparePlayer();
    });
    video.addEventListener('waiting', () => {
        playerMediaProgressing.delete(video);
        playerMediaWaiting.add(video);
        playerMediaTimes.set(video, video.currentTime);
        const preparation = playerPreparation;
        if (preparation?.fade && endlessPlayback.mode === 'shuffle_clips') {
            if (!preparation.buffering) preparation.resumeAfterBuffer = !preparation.incoming.paused;
            preparation.buffering = true;
            preparation.bufferPauseVideos ||= new WeakSet();
            for (const media of [preparation.incoming, preparation.outgoing]) {
                if (!media.paused) preparation.bufferPauseVideos.add(media);
                media.pause();
            }
        }
    });
    video.addEventListener('canplay', () => {
        playerMediaWaiting.delete(video);
        if (playerPreparation?.buffering) resumeBufferedClipFade(playerPreparation);
    });
    video.addEventListener('ended', () => completePlayerItem(video, true));
    video.addEventListener('pause', () => {
        playerMediaProgressing.delete(video);
        const bufferingPause = playerPreparation?.bufferPauseVideos?.delete(video);
        if (video.id !== 'playerVideo') return;
        if (playerPreparation?.buffering && !bufferingPause) {
            playerPreparation.resumeAfterBuffer = false;
        }
        if (playerPreparation?.fade && !bufferingPause && video.paused) {
            playerPreparation.outgoing.pause();
        }
        if (endlessPlayback.active && endlessPlayback.mode === 'playlist' && !video.ended
                && !playerBoundaries.get(video)?.finished) {
            savePlaylistProgress({ force: true });
        }
    });
    video.addEventListener('play', () => {
        if (video.id !== 'playerVideo' || !playerPreparation?.fade) return;
        const preparation = playerPreparation;
        try {
            Promise.resolve(preparation.outgoing.play()).catch(error => {
                if (!playerPauseAborted(error, preparation)) failPlayerFade(preparation);
            });
        } catch (error) {
            if (!playerPauseAborted(error, preparation)) failPlayerFade(preparation);
        }
    });
    video.addEventListener('seeking', () => {
        playerMediaProgressing.delete(video);
        playerMediaTimes.delete(video);
        if (video.id !== 'playerVideo' || playerBoundaries.get(video)?.ownSeek) return;
        if (playerPreparation?.fade) finishPlayerFade();
        else if (playerPreparation?.starting || playerPreparation?.committing) {
            failPlayerFade(playerPreparation);
        }
    });
    video.addEventListener('seeked', () => {
        playerMediaTimes.set(video, video.currentTime);
        if (video.id === 'playerVideo') maybePreparePlayer();
    });
    video.addEventListener('ratechange', () => {
        if (!playerIsOpen() || video.id !== 'playerVideo') return;
        playerListening.rate = video.playbackRate;
        video.defaultPlaybackRate = playerListening.rate;
        if (playerPreparation?.fade) playerPreparation.outgoing.playbackRate = video.playbackRate;
        syncPlayerControls();
    });
    video.addEventListener('volumechange', () => playerVolumeChanged(video));
}
window.addEventListener('pagehide', () => {
    if (endlessPlayback.active && endlessPlayback.mode === 'playlist') {
        savePlaylistProgress({ force: true, keepalive: true });
    }
});

document.addEventListener('visibilitychange', () => {
    if (!endlessPlayback.active) return;
    if (document.hidden) clearPlaybackWatchdog();
    else if (endlessPlayback.phase === 'loading') {
        armPlaybackWatchdog(endlessPlayback.loadGeneration);
    }
});

initializePlayerControls();

document.getElementById('playerBackdrop').addEventListener(
    'mousemove', handlePlayerPointerMove,
);

function togglePlayerPlayback() {
    if (playerRecoveryActive()) return;
    const video = document.getElementById('playerVideo');
    const preparation = playerPreparation;
    if (!video.paused && !video.ended) {
        if (preparation?.fade) {
            preparation.controlPaused = true;
            preparation.resumePending = false;
            clearTimeout(preparation.resumeTimer);
        }
        video.pause();
        return;
    }
    if (preparation?.fade) {
        preparation.controlPaused = false;
        preparation.resumePending = true;
        preparation.resumeBuffered = false;
        preparation.startTime = preparation.outgoing.currentTime - preparation.progress * preparation.fadeDuration;
        preparation.resumeOutgoingTime = preparation.outgoing.currentTime;
        preparation.resumeIncomingTime = preparation.incoming.currentTime;
        for (const media of [preparation.outgoing, preparation.incoming]) {
            playerMediaProgressing.delete(media);
            playerMediaTimes.set(media, media.currentTime);
        }
        clearTimeout(preparation.resumeTimer);
        preparation.resumeTimer = setTimeout(() => failPlayerFade(preparation), PLAYER_HANDOFF_TIMEOUT_MS);
    }
    playPlayerVideo(video);
}

function handlePlayerShortcut(ev) {
    const backdrop = document.getElementById('playerBackdrop');
    if (!backdrop.classList.contains('open')
            || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return false;

    const fullscreenShortcut = (ev.key === 'f' || ev.key === 'F')
        && endlessPlayback.presentation === 'original';
    const playbackShortcut = ev.key === ' ' && !ev.shiftKey;
    if (!fullscreenShortcut && !playbackShortcut) return false;

    if (ev.target instanceof Element) {
        if (ev.target.isContentEditable
                || ev.target.closest('textarea, input:not([type="range"])')) return false;

        const control = ev.target.closest('button, input, select, [role="slider"]');
        if (control) {
            // Space belongs to the focused control; F remains available after
            // using player buttons and ranges without moving keyboard focus.
            if (!fullscreenShortcut || !control.closest('#playerContainer')) return false;
            // Native popups own their typing. Older browsers without :open
            // cannot distinguish a closed selector, so leave it native too.
            if (control.matches('select') && (control.id !== 'playerSpeed'
                    || !CSS.supports('selector(:open)') || control.matches(':open'))) return false;
        }
    }

    ev.preventDefault();
    if (ev.repeat) return true;
    if (fullscreenShortcut) requestPlayerFullscreen();
    else togglePlayerPlayback();
    return true;
}

document.addEventListener('keydown', (ev) => {
    if (handlePlayerShortcut(ev)) return;

    // Editors use Escape to cancel their own transient state. Respect that
    // before treating the same key as a request to close an enclosing layer.
    if (ev.defaultPrevented) return;
    if (ev.key === 'Escape' && document.getElementById('playlistDeleteDialog').open) {
        ev.preventDefault();
        closePlaylistDelete();
    } else if (ev.key === 'Escape' && document.getElementById('playerBackdrop').classList.contains('open')) {
        ev.preventDefault();
        closePlayer();
    } else if (ev.key === 'Escape' && document.getElementById('playlistEditorDialog').open) {
        ev.preventDefault();
        closePlaylistEditor();
    } else if (ev.key === 'Escape' && document.getElementById('playlistChooserDialog').open) {
        ev.preventDefault();
        closePlaylistChooser();
    } else if (ev.key === 'Escape' && document.getElementById('newDownloadDialog').open) {
        ev.preventDefault();
        closeNewDownload();
    } else if (ev.key === 'Escape' && document.getElementById('extensionPairingDialog').open) {
        ev.preventDefault();
        closeExtensionPairingDialog();
    } else if (ev.key === 'Escape' && !document.getElementById('settingsPage').hidden) {
        ev.preventDefault();
        closeSettings();
    } else if (ev.key === 'Escape' && document.getElementById('currentDownloadsDrawer').open) {
        ev.preventDefault();
        closeCurrentDownloads();
    } else if (ev.key === 'Escape' && !document.getElementById('accountMenu').hidden) {
        ev.preventDefault();
        closeAccountMenu(true);
    } else if (ev.key === 'Escape' && openInfoId !== null) {
        ev.preventDefault();
        closeHistoryInfo();
    }

    const isPaste = (ev.key === 'v' || ev.key === 'V') && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey;
    if (!isPaste) return;

    const active = document.activeElement;
    const tag = active ? active.tagName : '';
    const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || (active && active.isContentEditable);
    if (isEditable) return;

    openNewDownload();
});

function focusNewDownload() {
    openNewDownload();
}

let newDownloadReturnFocus = null;
let newDownloadSession = 0;

function openNewDownload() {
    const dialog = document.getElementById('newDownloadDialog');
    if (!dialog.open) {
        // Avoid stacking modal workflows if a paste shortcut is pressed while
        // another dialog has focus; paste within its editable controls remains
        // available through the guard in the keydown handler above.
        if (!document.getElementById('settingsPage').hidden
                || document.getElementById('currentDownloadsDrawer').open
                || document.getElementById('playerBackdrop').classList.contains('open')) return;
        newDownloadReturnFocus = document.activeElement;
        closeHistoryInfo();
        closeAllMenus();
        hideActionError();
        dialog.showModal();
        newDownloadSession += 1;
    }
    if (optionsDetails.open) setOptionsOpen(true);
    renderDownloadSubmission();
    urlInput.focus();
    urlInput.select();
}

function closeNewDownload() {
    const dialog = document.getElementById('newDownloadDialog');
    if (dialog.open) dialog.close();
}

const newDownloadDialog = document.getElementById('newDownloadDialog');
function restoreDownloadFocus(target) {
    if (target && target.isConnected && target !== document.body) {
        target.focus();
        if (document.activeElement === target) return;
    }
    // Paste can start from the page itself, and completed downloads can hide
    // the drawer's trigger while it is open. Keep keyboard navigation usable.
    document.getElementById('accountMenuButton').focus();
}

newDownloadDialog.addEventListener('close', () => {
    renderDownloadSubmission();
    hideActionError();
    restoreDownloadFocus(newDownloadReturnFocus);
    newDownloadReturnFocus = null;
});
newDownloadDialog.addEventListener('click', ev => {
    // Native select popups can bubble clicks with synthetic viewport
    // coordinates. Only the dialog itself can represent its backdrop; child
    // controls must never be classified as outside clicks by coordinates.
    if (ev.target === newDownloadDialog) closeNewDownload();
});

let currentDrawerReturnFocus = null;

function openCurrentDownloads() {
    const drawer = document.getElementById('currentDownloadsDrawer');
    if (drawer.open) return;
    currentDrawerReturnFocus = document.activeElement;
    closeHistoryInfo();
    closeAllMenus();
    hideActionError();
    drawer.showModal();
    document.getElementById('currentDownloadsButton').setAttribute('aria-expanded', 'true');
}

function closeCurrentDownloads() {
    const drawer = document.getElementById('currentDownloadsDrawer');
    if (drawer.open) drawer.close();
}

const currentDownloadsDrawer = document.getElementById('currentDownloadsDrawer');
currentDownloadsDrawer.addEventListener('close', () => {
    hideActionError();
    closeAllMenus();
    document.getElementById('currentDownloadsButton').setAttribute('aria-expanded', 'false');
    restoreDownloadFocus(currentDrawerReturnFocus);
    currentDrawerReturnFocus = null;
});
currentDownloadsDrawer.addEventListener('click', ev => {
    const bounds = currentDownloadsDrawer.getBoundingClientRect();
    const outside = ev.clientX < bounds.left || ev.clientX > bounds.right
        || ev.clientY < bounds.top || ev.clientY > bounds.bottom;
    if (outside) closeCurrentDownloads();
});

let settingsOpenPromise = null;

function openSettings() {
    const page = document.getElementById('settingsPage');
    document.getElementById('settingsBackButton').setAttribute('aria-label',
        attemptHistoryOpen ? 'Back to History' : 'Back to videos');
    closeAllMenus();
    if (!page.hidden) return Promise.resolve();
    if (settingsOpenPromise) return settingsOpenPromise;
    closeHistoryInfo();
    hideActionError();
    // Keep the form unavailable until its server values are applied so a late
    // response cannot overwrite a choice made immediately after opening it.
    const viewToken = ++preferenceViewToken;
    const epoch = tagSessionEpoch;
    settingsOpenPromise = Promise.allSettled([
        loadPreferences(),
        loadUsers(),
        loadExtensionConnections(),
    ]).then(() => {
        if (epoch !== tagSessionEpoch || viewToken !== preferenceViewToken) return;
        document.getElementById('tab-history').hidden = true;
        scheduleAssetDemand();
        document.getElementById('attemptHistoryPage').hidden = true;
        page.hidden = false;
        document.body.classList.add('settings-open');
        window.scrollTo({ top: 0 });
        scheduleSettingsSectionUpdate();
        renderPreferenceStatus();
    }).finally(() => {
        settingsOpenPromise = null;
    });
    return settingsOpenPromise;
}

function closeSettings() {
    const page = document.getElementById('settingsPage');
    if (page.hidden) return;
    page.hidden = true;
    preferenceViewToken++;
    renderPreferenceStatus();
    document.getElementById('tab-history').hidden = attemptHistoryOpen;
    scheduleAssetDemand({ reconcile: true });
    document.getElementById('attemptHistoryPage').hidden = !attemptHistoryOpen;
    document.body.classList.remove('settings-open');
    clearExtensionPairing();
    hideActionError();
    window.scrollTo({ top: 0 });
    document.getElementById('accountMenuButton').focus();
}

const settingsSearchInput = document.getElementById('settingsSearchInput');
const settingsSections = Array.from(document.querySelectorAll('.settings-section'));
const settingsNavButtons = Array.from(document.querySelectorAll('[data-settings-section]'));

function setActiveSettingsSection(name) {
    settingsNavButtons.forEach(button => {
        const active = button.dataset.settingsSection === name;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });
}

function settingsContentTop(sticky = false) {
    const content = document.querySelector('.settings-content').getBoundingClientRect();
    let top = 0;
    // Only headers overlapping the options obscure them; the desktop index
    // sits alongside them, while the mobile index covers their top edge.
    for (const selector of ['.app-header', '.settings-page-header', '.settings-nav']) {
        const element = document.querySelector(selector);
        const bounds = element.getBoundingClientRect();
        if (bounds.left < content.right && bounds.right > content.left) {
            const stickyTop = parseFloat(getComputedStyle(element).top);
            top = Math.max(top, sticky && Number.isFinite(stickyTop)
                ? stickyTop + bounds.height : bounds.bottom);
        }
    }
    return top;
}

function updateActiveSettingsSection() {
    if (document.getElementById('settingsPage').hidden) return;
    const visible = settingsSections.filter(section => !section.hidden);
    const top = settingsContentTop() + 1;
    const current = visible.find(section => section.getBoundingClientRect().bottom > top);
    setActiveSettingsSection(current?.dataset.settingsName);
}

let settingsSectionFrame = null;

function scheduleSettingsSectionUpdate() {
    if (document.getElementById('settingsPage').hidden || settingsSectionFrame !== null) return;
    settingsSectionFrame = requestAnimationFrame(() => {
        settingsSectionFrame = null;
        updateActiveSettingsSection();
    });
}

function scrollToSettingsSection(name, behavior) {
    const section = document.getElementById(`settings-${name}`);
    window.scrollBy({ top: section.getBoundingClientRect().top - settingsContentTop(true), behavior });
    scheduleSettingsSectionUpdate();
}

window.addEventListener('scroll', scheduleSettingsSectionUpdate, { passive: true });
window.addEventListener('resize', scheduleSettingsSectionUpdate);
if ('ResizeObserver' in window) {
    new ResizeObserver(scheduleSettingsSectionUpdate).observe(document.querySelector('.settings-content'));
}

function applySettingsSearch() {
    const terms = settingsSearchInput.value.toLocaleLowerCase().trim()
        .split(/\s+/).filter(Boolean);
    let resultCount = 0;
    let firstMatchingSection = null;

    settingsSections.forEach(section => {
        let sectionMatches = 0;
        section.querySelectorAll('.setting-item, [data-setting-keywords]').forEach(item => {
            const searchable = `${item.textContent} ${item.dataset.settingKeywords || ''}`
                .toLocaleLowerCase();
            const available = item.dataset.settingAvailable !== 'false';
            const matches = available && terms.every(term => searchable.includes(term));
            item.hidden = !matches;
            if (matches) sectionMatches += 1;
        });
        section.hidden = terms.length > 0 && sectionMatches === 0;
        if (sectionMatches > 0 && firstMatchingSection === null) {
            firstMatchingSection = section.dataset.settingsName;
        }
        resultCount += sectionMatches;
    });

    document.getElementById('settingsNoResults').hidden = resultCount !== 0;
    if (terms.length > 0 && firstMatchingSection !== null) {
        setActiveSettingsSection(firstMatchingSection);
    }
    scheduleSettingsSectionUpdate();
}

settingsNavButtons.forEach(button => {
    button.addEventListener('click', () => {
        settingsSearchInput.value = '';
        applySettingsSearch();
        const name = button.dataset.settingsSection;
        if (name !== 'browser-extension') clearExtensionPairing();
        setActiveSettingsSection(name);
        scrollToSettingsSection(name,
            window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
    });
});

settingsSearchInput.addEventListener('input', applySettingsSearch);
settingsSearchInput.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !settingsSearchInput.value) return;
    event.stopPropagation();
    settingsSearchInput.value = '';
    applySettingsSearch();
});

let extensionPairingExpiresAt = 0;
let extensionPairingTimer = null;
let bundledExtension = null;
let extensionPairingAllowed = false;

function isLocalHttpHostname(value) {
    const hostname = String(value || '').toLowerCase().replace(/\.$/, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') ||
            hostname === '[::1]' || hostname === '::1') {
        return true;
    }
    const octets = hostname.split('.');
    if (octets.length !== 4 || !octets.every(
        octet => /^\d+$/.test(octet) && Number(octet) <= 255
    )) return false;
    const first = Number(octets[0]);
    const second = Number(octets[1]);
    return first === 127 || first === 10 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168);
}

function isPairableVdlLocation(value, privateHttpAllowed = false) {
    return value.protocol === 'https:' ||
        (value.protocol === 'http:' && privateHttpAllowed &&
            isLocalHttpHostname(value.hostname));
}

function extensionStatus(message) {
    document.getElementById('extensionStatus').textContent = message || '';
}

function extensionPairingFeedback(message) {
    document.getElementById('extensionPairingFeedback').textContent = message || '';
}

function setExtensionPairingCopied(copied) {
    const button = document.getElementById('extensionCopyPairing');
    button.classList.toggle('copied', copied);
    button.querySelector('use').setAttribute('href', copied ? '#i-check' : '#i-copy');
    button.querySelector('.extension-copy-label').textContent = copied
        ? 'Copied' : 'Copy pairing string';
}

function clearExtensionPairing() {
    if (extensionPairingTimer) clearInterval(extensionPairingTimer);
    extensionPairingTimer = null;
    extensionPairingExpiresAt = 0;
    const field = document.getElementById('extensionPairingString');
    if (field) field.value = '';
    const output = document.getElementById('extensionPairingOutput');
    if (output) output.hidden = true;
    const details = document.getElementById('extensionPairingDetails');
    if (details) details.open = false;
    setExtensionPairingCopied(false);
    extensionPairingFeedback('');
    const dialog = document.getElementById('extensionPairingDialog');
    if (dialog && dialog.open) dialog.close();
}

function closeExtensionPairingDialog() {
    const dialog = document.getElementById('extensionPairingDialog');
    if (dialog.open) dialog.close();
}

function pairingString(origin, code) {
    const bytes = new TextEncoder().encode(JSON.stringify({ origin, code }));
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return `vdl-pair-v1:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

function updatePairingExpiry() {
    const remaining = Math.max(0, Math.ceil(extensionPairingExpiresAt - Date.now() / 1000));
    const label = document.getElementById('extensionPairingExpiry');
    if (!remaining) {
        clearExtensionPairing();
        extensionStatus('');
        return;
    }
    label.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} remaining`;
}

function createExtensionPairing() {
    if (!extensionPairingAllowed) return;
    apiAction('/api/extension/pairing-codes', { method: 'POST' })
        .then(response => response.json()).then(response => {
        document.getElementById('extensionPairingString').value = pairingString(
            window.location.origin, response.code,
        );
        document.getElementById('extensionPairingOutput').hidden = false;
        extensionPairingExpiresAt = response.expires_at;
        updatePairingExpiry();
        if (extensionPairingTimer) clearInterval(extensionPairingTimer);
        extensionPairingTimer = setInterval(updatePairingExpiry, 1000);
        const dialog = document.getElementById('extensionPairingDialog');
        document.getElementById('extensionPairingDetails').open = false;
        setExtensionPairingCopied(false);
        extensionPairingFeedback('');
        dialog.showModal();
        document.getElementById('extensionCopyPairing').focus();
        extensionStatus('Pairing string created. Copy it to continue in VDL Companion.');
    }).catch(() => {});
}

async function copyExtensionPairing() {
    const field = document.getElementById('extensionPairingString');
    try {
        await navigator.clipboard.writeText(field.value);
        setExtensionPairingCopied(true);
        extensionPairingFeedback('Copied. Continue in VDL Companion.');
        extensionStatus('Pairing string copied.');
    } catch (_) {
        document.getElementById('extensionPairingDetails').open = true;
        field.focus();
        field.select();
        setExtensionPairingCopied(false);
        extensionPairingFeedback('Copy was blocked. The pairing string is shown and selected below.');
        extensionStatus('Copy was blocked. The pairing string is selected for manual copying.');
    }
}

function invalidateExtensionPairing() {
    apiAction('/api/extension/pairing-codes/current', { method: 'DELETE' })
        .then(() => {
            clearExtensionPairing();
            extensionStatus('Pairing string invalidated.');
        }).catch(() => {});
}

function extensionPackageAction() {
    if (!bundledExtension) return;
    if (bundledExtension.signed) {
        extensionStatus('Firefox should show an Add confirmation. If it does not, right-click the install button, save the XPI, then install it from about:addons.');
    } else {
        extensionStatus('Downloading the unsigned development XPI. Extract it and follow the temporary-loading instructions below. Repeat temporary loading after Firefox restarts.');
    }
}

function versionParts(value) {
    return String(value || '').split('.').map(part => Number(part) || 0);
}

function isNewerVersion(left, right) {
    const a = versionParts(left);
    const b = versionParts(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
    }
    return false;
}

function formatConnectionTime(value) {
    return value ? new Date(value * 1000).toLocaleString() : 'Never';
}

function renderExtensionConnection(connection) {
    const update = bundledExtension && isNewerVersion(
        bundledExtension.version, connection.extension_version,
    ) ? '<span class="extension-update-label">Update available</span>' : '';
    return `<article class="extension-connection" data-connection-id="${escapeAttr(connection.id)}">
                <div><strong>${escapeHtml(connection.device_label)}</strong>${update}</div>
                <dl>
                    <dt>Extension</dt><dd>${escapeHtml(connection.extension_version)}</dd>
                    <dt>Paired</dt><dd>${formatConnectionTime(connection.created_at)}</dd>
                    <dt>Last used</dt><dd>${formatConnectionTime(connection.last_used_at)}</dd>
                </dl>
                <button type="button" class="danger extension-revoke-button"
                        aria-label="Revoke ${escapeAttr(connection.device_label)}"
                        title="Revoke connection"
                        onclick="revokeExtensionConnection('${escapeAttr(connection.id)}', this)">
                    <svg aria-hidden="true"><use href="#i-trash"/></svg>
                </button>
            </article>`;
}

function loadExtensionConnections() {
    const create = document.getElementById('extensionCreatePairing');
    create.disabled = true;
    return apiFetch('/api/extension/connections').then(response => response.json()).then(data => {
        extensionPairingAllowed = isPairableVdlLocation(
            window.location, Boolean(data.http_pairing_allowed),
        );
        const localHttp = window.location.protocol === 'http:' && extensionPairingAllowed;
        create.disabled = !extensionPairingAllowed;
        document.getElementById('extensionHttpsStatus').textContent = localHttp
            ? 'This private HTTP origin is enabled by the VDL operator. Traffic is not encrypted.'
            : extensionPairingAllowed
                ? 'This trusted HTTPS origin is ready to pair.'
                : 'Pairing is disabled here. Use HTTPS or ask the operator to allow this local IPv4 CIDR.';
        bundledExtension = data.bundled_extension;
        const install = document.getElementById('extensionInstallLink');
        const unsignedHelp = document.getElementById('extensionUnsignedHelp');
        unsignedHelp.hidden = !bundledExtension || bundledExtension.signed;
        unsignedHelp.dataset.settingAvailable = String(!unsignedHelp.hidden);
        if (unsignedHelp.hidden) unsignedHelp.open = false;
        if (bundledExtension) {
            install.href = bundledExtension.signed
                ? bundledExtension.url : bundledExtension.download_url;
            if (bundledExtension.signed) install.removeAttribute('download');
            else install.setAttribute('download', 'vdl-companion-firefox.xpi');
            install.removeAttribute('aria-disabled');
            install.classList.remove('disabled');
            document.getElementById('extensionInstallHint').textContent = bundledExtension.signed
                ? 'Firefox will show an Add confirmation. Installation and pairing are separate steps.'
                : 'This bundled development package is not Mozilla-signed. Download it for temporary testing and follow the instructions below; downloading alone does not install it.';
        } else {
            install.removeAttribute('href');
            install.removeAttribute('download');
            install.setAttribute('aria-disabled', 'true');
            install.classList.add('disabled');
            document.getElementById('extensionInstallHint').textContent = 'The bundled extension failed its integrity check. Contact the VDL operator.';
        }
        const connections = data.connections || [];
        document.getElementById('extensionConnectionList').innerHTML = connections.map(renderExtensionConnection).join('');
        document.getElementById('extensionNoConnections').hidden = connections.length > 0;
        const needsUpdate = connections.some(connection => bundledExtension && isNewerVersion(
            bundledExtension.version, connection.extension_version,
        ));
        install.textContent = bundledExtension && !bundledExtension.signed
            ? 'Download unsigned XPI'
            : !bundledExtension ? 'Extension unavailable'
                : needsUpdate ? 'Update Firefox extension' : 'Install Firefox extension';
        applySettingsSearch();
    });
}

function revokeExtensionConnection(connectionId, button) {
    if (!window.confirm('Revoke this VDL Companion connection?')) return;
    apiAction(`/api/extension/connections/${encodeURIComponent(connectionId)}`, {
        method: 'DELETE',
    }).then(() => loadExtensionConnections()).then(() => {
        extensionStatus('Companion connection revoked.');
        const next = document.querySelector('.extension-connection button');
        (next || document.getElementById('extensionCreatePairing')).focus();
    }).catch(() => { button.focus(); });
}

let managedRoles = [];
let managedCurrentUserId = null;
let managedUsers = [];
let managedUserEditId = null;
let managedUserDraft = null;
let managedRemoveUserId = null;
const NEW_USER_ROW_ID = 'new';
const USER_EDIT_LOCK_TITLE = 'Save or cancel the current user changes before editing another user';

function userRoleOptions(selectedRole) {
    return managedRoles.map(role => (
        `<option value="${escapeAttr(role)}"${role === selectedRole ? ' selected' : ''}>${escapeHtml(role.charAt(0).toUpperCase() + role.slice(1))}</option>`
    )).join('');
}

function managedUserValues(row) {
    return {
        username: row.querySelector('.user-login-input').value,
        name: row.querySelector('.user-name-input').value,
        role: row.querySelector('.user-role-input').value,
    };
}

function userEditActions(rowId, isNew) {
    const saveAction = isNew ? '' : ` onclick="updateUser(${rowId})"`;
    const saveType = isNew ? 'submit' : 'button';
    const form = isNew ? ' form="addUserForm"' : '';
    return `<button type="${saveType}"${form} class="user-action user-save"${saveAction} aria-label="Save" title="Save">
                <svg aria-hidden="true"><use href="#i-check"/></svg>
            </button>
            <button type="button" class="user-action user-cancel" onclick="cancelUserEdit()" aria-label="Cancel" title="Cancel">
                <svg aria-hidden="true"><use href="#i-x"/></svg>
            </button>`;
}

function userDefaultActions(user, locked) {
    const isCurrent = user.id === managedCurrentUserId;
    const disabled = locked || isCurrent;
    const suspendLabel = user.suspended ? 'Resume' : 'Suspend';
    const suspendIcon = user.suspended ? 'i-play' : 'i-pause';
    const disabledReason = isCurrent
        ? ` title="You cannot ${user.suspended ? 'resume' : 'suspend'} your own account"`
        : ` title="${suspendLabel}"`;
    return `<button type="button" class="user-action user-suspend" onclick="setUserSuspended(${user.id}, ${!user.suspended})"
                    aria-label="${suspendLabel}" aria-pressed="${user.suspended}"${disabled ? ' disabled' : ''}${disabledReason}>
                <svg aria-hidden="true"><use href="#${suspendIcon}"/></svg>
            </button>
            <button type="button" class="user-action user-remove" onclick="removeUser(${user.id})"
                    aria-label="Remove" title="Remove"${disabled ? ' disabled' : ''}>
                <svg aria-hidden="true"><use href="#i-trash"/></svg>
            </button>`;
}

function renderManagedUserRow(user) {
    const rowId = String(user.id);
    const editing = managedUserEditId === rowId;
    const locked = managedUserEditId !== null && !editing;
    const values = editing ? managedUserDraft : {
        username: user.username,
        name: user.name,
        role: user.roles[0] || '',
    };
    const disabled = locked ? ' disabled' : '';
    const lockedClass = locked ? ' user-row-locked' : '';
    const lockedTitle = locked ? ` title="${USER_EDIT_LOCK_TITLE}"` : '';
    const hasOtherActiveAdmin = managedUsers.some(candidate => (
        candidate.id !== user.id
        && candidate.roles.includes('admin')
        && !candidate.suspended
    ));
    const disableRoleChange = user.roles.includes('admin') && !hasOtherActiveAdmin;
    const roleDisabled = locked || disableRoleChange ? ' disabled' : '';
    const roleTitle = locked
        ? ` title="${USER_EDIT_LOCK_TITLE}"`
        : disableRoleChange
        ? ' title="You cannot change the role of the last administrator on the system"'
        : '';
    const currentLabel = user.id === managedCurrentUserId
        ? '<span class="user-you">you</span>' : '';
    return `<tr class="user-row${editing ? ' user-row-editing' : ''}${user.suspended ? ' user-row-suspended' : ''}${lockedClass}" data-user-id="${user.id}"${lockedTitle}>
                <td>
                    <div class="user-field-with-status">
                        <input class="user-login-input" type="text" maxlength="64" required value="${escapeAttr(values.username)}"
                               aria-label="Login name for ${escapeAttr(user.username)}"${disabled}
                               oninput="userFieldChanged('${rowId}', 'username', this)" onkeydown="userFieldKeydown(event)">
                        ${currentLabel}
                    </div>
                </td>
                <td><input class="user-name-input" type="text" maxlength="128" required value="${escapeAttr(values.name)}"
                           aria-label="Name for ${escapeAttr(user.username)}"${disabled}
                           oninput="userFieldChanged('${rowId}', 'name', this)" onkeydown="userFieldKeydown(event)"></td>
                <td><div class="user-role-field"${roleTitle}>
                    <select class="user-role-input" aria-label="Role for ${escapeAttr(user.username)}"${roleDisabled}
                            onchange="userFieldChanged('${rowId}', 'role', this)" onkeydown="userFieldKeydown(event)">${userRoleOptions(values.role)}</select>
                </div></td>
                <td class="user-actions">${editing ? userEditActions(rowId, false) : userDefaultActions(user, locked)}</td>
            </tr>`;
}

function renderNewUserRow() {
    const editing = managedUserEditId === NEW_USER_ROW_ID;
    const locked = managedUserEditId !== null && !editing;
    const values = editing ? managedUserDraft : { username: '', name: '', role: 'normal' };
    const disabled = locked ? ' disabled' : '';
    const lockedClass = locked ? ' user-row-locked' : '';
    const lockedTitle = locked ? ` title="${USER_EDIT_LOCK_TITLE}"` : '';
    const actions = editing ? userEditActions(NEW_USER_ROW_ID, true) : (
        `<button type="button" class="user-action user-add" onclick="startNewUser()" aria-label="Add user" title="${locked ? USER_EDIT_LOCK_TITLE : 'Add user'}"${disabled}>
            <svg aria-hidden="true"><use href="#i-plus"/></svg>
        </button>`
    );
    return `<tr class="user-row user-row-new${editing ? ' user-row-editing' : ''}${lockedClass}" data-user-id="${NEW_USER_ROW_ID}"${lockedTitle}>
                <td><input id="newUsername" form="addUserForm" class="user-login-input" type="text" maxlength="64" required
                           value="${escapeAttr(values.username)}" placeholder="Login name" autocomplete="off" aria-label="New login name"${disabled}
                           oninput="userFieldChanged('${NEW_USER_ROW_ID}', 'username', this)" onkeydown="userFieldKeydown(event)"></td>
                <td><input id="newUserName" form="addUserForm" class="user-name-input" type="text" maxlength="128" required
                           value="${escapeAttr(values.name)}" placeholder="Name" autocomplete="off" aria-label="New user name"${disabled}
                           oninput="userFieldChanged('${NEW_USER_ROW_ID}', 'name', this)" onkeydown="userFieldKeydown(event)"></td>
                <td><select id="newUserRole" form="addUserForm" class="user-role-input" aria-label="New user role"${disabled}
                            onchange="userFieldChanged('${NEW_USER_ROW_ID}', 'role', this)" onkeydown="userFieldKeydown(event)">${userRoleOptions(values.role)}</select></td>
                <td class="user-actions">${actions}</td>
            </tr>`;
}

function renderUsers(users = null) {
    const list = document.getElementById('userList');
    if (!list) return;
    if (users !== null) managedUsers = users;
    list.innerHTML = managedUsers.map(renderManagedUserRow).join('') + renderNewUserRow();
}

function loadUsers() {
    if (!document.getElementById('userList')) return Promise.resolve();
    return apiAction('/api/users').then(response => response.json()).then(data => {
        managedRoles = data.roles || [];
        managedCurrentUserId = data.current_user_id;
        managedUserEditId = null;
        managedUserDraft = null;
        renderUsers(data.users || []);
    }).catch(() => {});
}

function focusManagedUserField(rowId, field) {
    requestAnimationFrame(() => {
        const row = document.querySelector(`[data-user-id="${rowId}"]`);
        const control = row && row.querySelector(`.user-${field === 'username' ? 'login' : field}-input`);
        if (!control) return;
        control.focus();
        if (typeof control.setSelectionRange === 'function') {
            control.setSelectionRange(control.value.length, control.value.length);
        }
    });
}

function userFieldChanged(rowId, field, control) {
    if (managedUserEditId !== null && managedUserEditId !== rowId) return;
    if (managedUserEditId === null) {
        managedUserEditId = rowId;
        managedUserDraft = managedUserValues(control.closest('.user-row'));
        renderUsers();
        focusManagedUserField(rowId, field);
        return;
    }
    managedUserDraft[field] = control.value;
}

function userFieldKeydown(event) {
    if (event.key === 'Escape' && managedUserEditId !== null) {
        event.preventDefault();
        cancelUserEdit();
    }
}

function startNewUser() {
    if (managedUserEditId !== null) return;
    const row = document.querySelector(`[data-user-id="${NEW_USER_ROW_ID}"]`);
    managedUserEditId = NEW_USER_ROW_ID;
    managedUserDraft = managedUserValues(row);
    renderUsers();
    focusManagedUserField(NEW_USER_ROW_ID, 'username');
}

function cancelUserEdit() {
    managedUserEditId = null;
    managedUserDraft = null;
    renderUsers();
}

function generatedInitialPassword() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
        throw new Error('A secure initial password could not be generated');
    }
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function showCreatedUserDialog(user, password) {
    const dialog = document.getElementById('userCreatedDialog');
    document.getElementById('userCreatedName').textContent = user.name || user.username;
    const passwordInput = document.getElementById('userCreatedPassword');
    passwordInput.value = password;
    dialog.showModal();
    passwordInput.select();
}

function addUser(event) {
    event.preventDefault();
    if (managedUserEditId !== NEW_USER_ROW_ID) return;
    let password;
    try {
        password = generatedInitialPassword();
    } catch (error) {
        showActionError(error.message);
        return;
    }
    const body = {
        username: managedUserDraft.username,
        name: managedUserDraft.name,
        password,
        role: managedUserDraft.role,
    };
    apiAction('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(response => response.json()).then(user => {
        showCreatedUserDialog(user, password);
        return loadUsers();
    }).catch(() => {});
}

function updateUser(userId) {
    if (managedUserEditId !== String(userId) || !managedUserDraft) return;
    const body = {
        username: managedUserDraft.username,
        name: managedUserDraft.name,
        role: managedUserDraft.role,
    };
    apiAction(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(response => response.json()).then(user => {
        if (userId === managedCurrentUserId) {
            document.getElementById('currentUsername').textContent = user.username;
            if (!user.roles.includes('admin')) window.location.reload();
        }
        return loadUsers();
    }).catch(() => {});
}

function setUserSuspended(userId, suspended) {
    apiAction(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suspended }),
    }).then(loadUsers).catch(() => {});
}

function removeUser(userId) {
    const user = managedUsers.find(candidate => candidate.id === userId);
    const dialog = document.getElementById('userRemoveDialog');
    if (!user || !dialog || managedUserEditId !== null) return;
    managedRemoveUserId = userId;
    document.getElementById('userRemoveName').textContent = user.name || user.username;
    dialog.returnValue = '';
    dialog.showModal();
}

const userRemoveDialog = document.getElementById('userRemoveDialog');
if (userRemoveDialog) {
    userRemoveDialog.addEventListener('close', () => {
        const userId = managedRemoveUserId;
        managedRemoveUserId = null;
        if (userRemoveDialog.returnValue !== 'remove' || userId === null) return;
        apiAction(`/api/users/${userId}`, { method: 'DELETE' })
            .then(loadUsers).catch(() => {});
    });
}

window.addEventListener('resize', closeHistoryInfo);

function isPresetValue(v) {
    const sel = document.getElementById('prefFormat');
    return Array.from(sel.options).some(o => o.value === v && o.value !== '__custom__');
}

function refreshCustomVisibility() {
    const sel = document.getElementById('prefFormat');
    const row = document.getElementById('customFormatRow');
    row.dataset.settingAvailable = String(sel.value === '__custom__');
    applySettingsSearch();
}

document.getElementById('prefFormat').addEventListener('change', refreshCustomVisibility);

function applyTheme(pref) {
    const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = (pref === 'system') ? (sysDark ? 'dark' : 'light') : pref;
    document.documentElement.setAttribute('data-theme', effective);
    document.documentElement.dataset.themePref = pref;
    try { localStorage.setItem('theme', pref); } catch (e) {}
}

if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
        if (document.documentElement.dataset.themePref === 'system') {
            applyTheme('system');
        }
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
}

let preferencesLoadGeneration = 0;

function fillPreferenceControls(p) {
    document.getElementById('prefDir').value = p.download_dir || '';
    document.getElementById('prefMax').value = p.max_concurrent || '3';
    document.getElementById('prefMaxPerHost').value = p.max_concurrent_per_host || '2';
    document.getElementById('prefMaxMbps').value = p.max_total_download_mbps || '0';
    const configuredPageSize = Number(p.history_page_size);
    const nextPageSize = p.history_page_size === HISTORY_ENDLESS_MODE
        ? HISTORY_ENDLESS_MODE
        : (HISTORY_PAGE_SIZES.has(configuredPageSize)
            ? configuredPageSize
            : DEFAULT_HISTORY_PAGE_SIZE);
    document.getElementById('prefPageSize').value = String(nextPageSize);

    const stored = p.format || 'bestvideo+bestaudio/best';
    const sel = document.getElementById('prefFormat');
    if (isPresetValue(stored)) {
        sel.value = stored;
        document.getElementById('prefFormatCustom').value = '';
    } else {
        sel.value = '__custom__';
        document.getElementById('prefFormatCustom').value = stored;
    }
    refreshCustomVisibility();

    document.getElementById('prefPlayer').value = p.player_mode === 'new_tab' ? 'new_tab' : 'overlay';
    document.getElementById('prefSkipVideoEdges').checked = p.skip_video_edges === 'true';
    document.getElementById('prefLibraryRotation').checked = p.library_rotation_enabled === 'true';
    document.getElementById('prefLibraryRotationHours').value = p.library_rotation_hours || '24';
    refreshLibraryRotationAvailability();
    document.getElementById('prefStartFullscreen').checked = p.start_fullscreen === 'true';
    refreshFullscreenAvailability();
    const shuffleHeights = new Set([
        '0', '360', '480', '720', '1080', '1440', '2160', '4320',
    ]);
    const shuffleHeight = String(p.shuffle_min_height ?? '0');
    document.getElementById('prefShuffleMinHeight').value =
        shuffleHeights.has(shuffleHeight) ? shuffleHeight : '0';
    const shuffleMinutes = String(p.shuffle_min_duration_minutes ?? '0');
    document.getElementById('prefShuffleMinDuration').value =
        /^\d+$/.test(shuffleMinutes)
            && Number(shuffleMinutes) <= 1440 ? shuffleMinutes : '0';

    const theme = ['light', 'dark', 'system'].includes(p.theme) ? p.theme : 'system';
    document.getElementById('prefTheme').value = theme;
}

function applyConfirmedPreferences(p, { preview = true } = {}) {
    const size = p.history_page_size === HISTORY_ENDLESS_MODE ? HISTORY_ENDLESS_MODE : Number(p.history_page_size);
    if (size === HISTORY_ENDLESS_MODE || HISTORY_PAGE_SIZES.has(size)) {
        if (historyPageSize !== size) {
            historyPageSize = size;
            historyPage = 0;
            historyEndlessVisibleCount = HISTORY_ENDLESS_BATCH_SIZE;
            renderDownloadCollections();
        }
    }
    playerMode = p.player_mode === 'new_tab' ? 'new_tab' : 'overlay';
    startVideosFullscreen = p.start_fullscreen === 'true';
    updateSkipVideoEdges(p.skip_video_edges === 'true');
    if (preview) applyTheme(['light', 'dark', 'system'].includes(p.theme) ? p.theme : 'system');
}

function loadPreferences() {
    const generation = ++preferencesLoadGeneration;
    const epoch = tagSessionEpoch;
    const draftGeneration = preferenceDraftGeneration;
    const viewToken = preferenceViewToken;
    const context = tagState.capture();
    preferenceMutationMetrics.reconciliationReads++;
    mutationMetrics.reconciliationReads++;
    return apiFetch('/api/preferences').then(async response => {
        if (epoch !== tagSessionEpoch || generation !== preferencesLoadGeneration) return null;
        if (response.status === 403) { tagMutations.fence('installation'); resetPreferenceSession(); return null; }
        if (!response.ok) throw new Error('Could not load settings.');
        return response.json();
    }).then(p => {
        if (!p || epoch !== tagSessionEpoch || generation !== preferencesLoadGeneration) return;
        if (p.values && p.preferences_revision) {
            tagState.acceptPreferences(p, { ...context, authoritative: true });
            if (!tagState.selectPreferences()) return;
        }
        const values = tagState.selectPreferences()?.values || p.values || p;
        // A read may reconcile confirmed state, but it cannot acknowledge a
        // transmitted save or take ownership of a newer editor generation.
        if (!preferenceSubmission) applyConfirmedPreferences(values, { preview: !preferenceDirty });
        if (viewToken === preferenceViewToken && draftGeneration === preferenceDraftGeneration && !preferenceDirty && !preferenceSubmission) fillPreferenceControls(values);
        renderPreferenceStatus();
    }).catch(error => {
        if (epoch === tagSessionEpoch && generation === preferencesLoadGeneration) {
            preferenceMessage = error.message;
            renderPreferenceStatus();
        }
    });
}

document.getElementById('prefTheme').addEventListener('change', (ev) => {
    applyTheme(ev.target.value);
});

function refreshFullscreenAvailability() {
    const overlay = document.getElementById('prefPlayer').value === 'overlay';
    const checkbox = document.getElementById('prefStartFullscreen');
    checkbox.disabled = !overlay;
    document.getElementById('prefStartFullscreenHint').textContent = overlay
        ? 'Automatically enter full screen when the built-in player opens.'
        : 'Available when videos play in the overlay on this page.';
}

document.getElementById('prefPlayer').addEventListener(
    'change', refreshFullscreenAvailability,
);

function refreshLibraryRotationAvailability() {
    document.getElementById('prefLibraryRotationHours').disabled =
        !document.getElementById('prefLibraryRotation').checked;
}

document.getElementById('prefLibraryRotation').addEventListener(
    'change', refreshLibraryRotationAvailability,
);

function readPreferenceDraft() {
    const sel = document.getElementById('prefFormat');
    const fmt = sel.value === '__custom__'
        ? document.getElementById('prefFormatCustom').value.trim()
        : sel.value;

    return {
        download_dir: document.getElementById('prefDir').value,
        format: fmt || 'best',
        history_page_size: document.getElementById('prefPageSize').value,
        max_concurrent: document.getElementById('prefMax').value,
        max_concurrent_per_host: document.getElementById('prefMaxPerHost').value,
        max_total_download_mbps: document.getElementById('prefMaxMbps').value,
        player_mode: document.getElementById('prefPlayer').value,
        start_fullscreen: document.getElementById('prefStartFullscreen').checked
            ? 'true' : 'false',
        skip_video_edges: document.getElementById('prefSkipVideoEdges').checked
            ? 'true' : 'false',
        library_rotation_enabled: document.getElementById('prefLibraryRotation').checked ? 'true' : 'false',
        library_rotation_hours: document.getElementById('prefLibraryRotationHours').value,
        shuffle_min_height: document.getElementById('prefShuffleMinHeight').value,
        shuffle_min_duration_minutes:
            document.getElementById('prefShuffleMinDuration').value,
        theme: document.getElementById('prefTheme').value,
    };
}

function preferenceIntent() {
    return preferenceSubmission?.intentId ? tagMutations.status(preferenceSubmission.intentId) : preferenceSubmission?.legacy || null;
}

function hasPreferenceProtocol() {
    return tagCapabilities?.mutation_protocol === 1 && tagCapabilities.actions?.includes('preference.set')
        && !!tagState.selectPreferences()?.preferences_revision;
}

function renderPreferenceStatus() {
    const intent = preferenceIntent();
    const status = document.getElementById('preferenceSaveStatus');
    if (!status) return;
    const pending = intent && ['queued', 'sending'].includes(intent.status);
    const unknown = intent?.status === 'unconfirmed';
    const conflict = intent?.status === 'conflicted';
    const rejected = intent?.status === 'rejected';
    let message = preferenceMessage || (preferenceDirty ? 'Unsaved settings.' : '');
    if (pending) message = intent.delayed ? 'Still waiting for settings confirmation. Your settings are not yet confirmed.' : 'Saving settings…';
    if (unknown) message = (preferenceSubmission?.legacy ? 'Save not confirmed. This server has no receipt recovery. Reload to read current settings; the earlier request may still complete.' : 'Save not confirmed. Your submitted settings are retained. Check its status before replaying.') + (preferenceMessage ? ` ${preferenceMessage}` : '');
    if (conflict) message = 'Settings changed elsewhere. Review the current settings before saving your draft again.';
    if (rejected) message = intent.message || 'Settings were not saved. Correct the retained draft and save again.';
    if (pending && preferenceSubmission.generation !== preferenceDraftGeneration) message += ' Newer edits are unsaved.';
    if (status.textContent !== message) status.textContent = message;
    const button = document.getElementById('saveBtn');
    const unavailable = tagCapabilities?.actions?.includes('preference.set') && !tagState.selectPreferences();
    button.disabled = !!pending || !!unknown || !!conflict || !!unavailable;
    button.setAttribute('aria-busy', String(!!pending));
    button.querySelector('span:last-child').textContent = pending ? 'Saving…' : preferenceMessage === 'Settings saved.' && !preferenceDirty && !intent ? 'Saved' : 'Save';
    button.querySelector('use').setAttribute('href', preferenceMessage === 'Settings saved.' && !preferenceDirty && !intent ? '#i-check' : '#i-save');
    document.getElementById('preferenceSavingSpinner').hidden = !pending;
    document.getElementById('preferenceRecovery').hidden = !unknown && !conflict && !rejected;
    document.getElementById('preferenceCheck').hidden = !unknown || !!preferenceSubmission?.legacy;
    document.getElementById('preferenceReplay').hidden = !unknown || !!preferenceSubmission?.legacy;
    document.getElementById('preferenceReview').hidden = !conflict;
    document.getElementById('preferenceResubmit').hidden = !conflict || !preferenceReviewVisible;
    document.getElementById('preferenceUseCurrent').hidden = (!conflict && !unknown) || !!preferenceSubmission?.legacy;
    document.getElementById('preferenceReload').hidden = !unknown || !preferenceSubmission?.legacy;
    document.getElementById('preferenceCurrentValues').hidden = !preferenceReviewVisible;
    if (preferenceReviewVisible) {
        const values = tagState.selectPreferences()?.values || {};
        document.getElementById('preferenceCurrentValues').textContent = Object.entries(values).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join('\n');
    }
    const fields = intent?.fieldErrors || {};
    const currentDraft = Object.keys(fields).length ? readPreferenceDraft() : {};
    for (const [key, id] of Object.entries(preferenceFieldIds)) {
        const element = document.getElementById(id);
        const error = currentDraft[key] === preferenceSubmission?.values[key] ? fields[key] : null;
        element.setAttribute('aria-invalid', error ? 'true' : 'false');
        const output = document.getElementById(`${id}SaveError`);
        if (error && !output) {
            const text = document.createElement('span');
            text.id = `${id}SaveError`; text.className = 'preference-field-error'; text.textContent = error;
            element.setAttribute('aria-describedby', [...new Set([...(element.getAttribute('aria-describedby') || '').split(' ').filter(Boolean), text.id])].join(' '));
            element.parentElement.appendChild(text);
        } else if (output) {
            if (error) output.textContent = error;
            else {
                const descriptions = (element.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== output.id);
                if (descriptions.length) element.setAttribute('aria-describedby', descriptions.join(' '));
                else element.removeAttribute('aria-describedby');
                output.remove();
            }
        }
    }
    const summary = document.getElementById('preferenceMutationSummary');
    summary.hidden = !document.getElementById('settingsPage').hidden || (!intent && !preferenceDirty);
    const summaryText = summary.querySelector('span');
    if (summaryText.textContent !== message) summaryText.textContent = message;
    const entries = tagMutations.pending().filter(entry => entry.kind === 'preference.set');
    if (preferenceSubmission?.legacy) entries.push(preferenceSubmission.legacy);
    preferenceMutationMetrics.pending = entries.filter(entry => ['queued', 'sending', 'unconfirmed', 'conflicted'].includes(entry.status)).length;
    preferenceMutationMetrics.unconfirmed = entries.filter(entry => entry.status === 'unconfirmed').length;
    preferenceMutationMetrics.conflicted = entries.filter(entry => entry.status === 'conflicted').length;
}

function handlePreferenceMutationEvent(event) {
    if (!preferenceSubmission || preferenceSubmission.epoch !== tagSessionEpoch) return;
    if (event.outcome === 'presented') preferenceSubmission.intentId = event.intentId;
    if (event.intentId !== preferenceSubmission.intentId) return;
    if (event.outcome === 'confirmed') {
        finishPreferenceSave(tagState.selectPreferences().values);
    } else renderPreferenceStatus();
}

function finishPreferenceSave(values) {
    const submission = preferenceSubmission;
    if (!submission || submission.epoch !== tagSessionEpoch) return;
    if (submission.legacy) {
        for (const metrics of [preferenceMutationMetrics, mutationMetrics]) {
            metrics.acknowledgements++;
            metrics.latestAcknowledgementMs = Math.max(0, performance.now() - submission.sentAt);
        }
    }
    const currentEditor = submission.viewToken === preferenceViewToken && submission.generation === preferenceDraftGeneration;
    applyConfirmedPreferences(values, { preview: currentEditor || !preferenceDirty });
    if (currentEditor) fillPreferenceControls(values);
    if (submission.generation === preferenceDraftGeneration) preferenceDirty = false;
    preferenceSubmission = null;
    preferenceReviewVisible = false;
    preferenceMessage = preferenceDirty ? 'Settings saved. Newer edits remain unsaved.' : 'Settings saved.';
    renderPreferenceStatus();
    clearTimeout(preferenceSavedTimer);
    const epoch = tagSessionEpoch;
    const viewToken = preferenceViewToken;
    const generation = preferenceDraftGeneration;
    const message = preferenceMessage;
    preferenceSavedTimer = setTimeout(() => {
        if (epoch !== tagSessionEpoch || preferenceSubmission || viewToken !== preferenceViewToken || generation !== preferenceDraftGeneration || preferenceMessage !== message) return;
        preferenceMessage = '';
        renderPreferenceStatus();
    }, 1500);
    // Rotation membership remains server-owned. Its derived view may reconcile
    // after confirmation without making the save depend on this read.
    if (['library_rotation_enabled', 'library_rotation_hours'].some(key => submission.values[key] !== submission.previous?.[key])) {
        invalidateLibraryOrder();
        fetchHistory();
    }
}

function savePreferences() {
    if (tagCapabilities?.actions?.includes('preference.set') && !tagState.selectPreferences()) return;
    const previousIntent = preferenceIntent();
    if (previousIntent && !['rejected'].includes(previousIntent.status)) return;
    for (const id of ['prefMax', 'prefMaxPerHost', 'prefMaxMbps', 'prefLibraryRotationHours', 'prefShuffleMinDuration']) {
        if (!document.getElementById(id).reportValidity()) return;
    }
    if (previousIntent && preferenceSubmission.intentId) tagMutations.resolve(preferenceSubmission.intentId);
    const started = performance.now();
    const values = readPreferenceDraft();
    preferenceMessage = '';
    preferenceReviewVisible = false;
    preferencesLoadGeneration++;
    preferenceSubmission = {
        values, generation: preferenceDraftGeneration, viewToken: preferenceViewToken,
        epoch: tagSessionEpoch, previous: tagState.selectPreferences()?.values,
    };
    if (hasPreferenceProtocol()) {
        const result = tagMutations.submit({ kind: 'preference.set', targetId: 'installation', value: values, viewToken: preferenceViewToken });
        if (!result.accepted) {
            preferenceSubmission = null;
            preferenceMessage = result.message;
        } else if (result.settled) finishPreferenceSave(tagState.selectPreferences().values);
        else preferenceSubmission.intentId = result.intentId;
    } else {
        saveLegacyPreferences(preferenceSubmission);
    }
    renderPreferenceStatus();
    preferenceMutationMetrics.latestLocalFeedbackMs = performance.now() - started;
    mutationMetrics.latestLocalFeedbackMs = preferenceMutationMetrics.latestLocalFeedbackMs;
}

async function saveLegacyPreferences(submission) {
    submission.legacy = { status: 'sending' };
    submission.sentAt = performance.now();
    for (const metrics of [preferenceMutationMetrics, mutationMetrics]) metrics.submissions++;
    renderPreferenceStatus();
    const delayed = setTimeout(() => {
        if (preferenceSubmission !== submission) return;
        submission.legacy.delayed = true; renderPreferenceStatus();
    }, 5000);
    const timeout = setTimeout(() => {
        if (preferenceSubmission !== submission || submission.legacy.status !== 'sending') return;
        setLegacyPreferenceOutcome(submission, 'unconfirmed');
    }, 30000);
    try {
        const response = await apiFetch('/api/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission.values) });
        const data = await response.json().catch(() => null);
        if (submission.epoch !== tagSessionEpoch || preferenceSubmission !== submission) return;
        if (response.status === 401 || response.status === 403) { resetPreferenceSession(); return; }
        if (response.ok && data && Object.keys(submission.values).every(key => typeof data[key] === 'string')) {
            finishPreferenceSave(data);
        } else {
            setLegacyPreferenceOutcome(submission, [400, 409, 422].includes(response.status) ? 'rejected' : 'unconfirmed', typeof data?.error === 'string' ? data.error : 'Settings were not saved. Your draft is retained.');
        }
    } catch (_) {
        if (submission.epoch === tagSessionEpoch && preferenceSubmission === submission) {
            setLegacyPreferenceOutcome(submission, 'unconfirmed');
        }
    } finally { clearTimeout(delayed); clearTimeout(timeout); }
}

function setLegacyPreferenceOutcome(submission, status, message = '') {
    if (submission.legacy.status !== status) {
        for (const metrics of [preferenceMutationMetrics, mutationMetrics]) metrics[status === 'rejected' ? 'rejectedOutcomes' : 'unconfirmedOutcomes']++;
    }
    submission.legacy.status = status;
    submission.legacy.message = message;
    renderPreferenceStatus();
}

function preferenceRecovery(action) {
    const intent = preferenceIntent();
    if (!intent) return;
    if (action === 'check') return tagMutations.recover(intent.id);
    if (action === 'replay') return tagMutations.recover(intent.id, { replay: true });
    if (action === 'review') { preferenceReviewVisible = true; renderPreferenceStatus(); return; }
    if (!preferenceSubmission.intentId || !tagMutations.resolve(preferenceSubmission.intentId)) {
        preferenceMessage = 'The original save may still complete. Check its status before using current settings.';
        renderPreferenceStatus(); return;
    }
    preferenceSubmission = null;
    preferenceReviewVisible = false;
    if (action === 'current') {
        const values = tagState.selectPreferences()?.values;
        if (values) { fillPreferenceControls(values); applyConfirmedPreferences(values); }
        preferenceDirty = false;
        preferenceMessage = 'Current settings loaded.';
    } else {
        preferenceMessage = 'Current settings reviewed. Your draft remains unsaved.';
    }
    renderPreferenceStatus();
    if (action === 'resubmit') savePreferences();
}

function resetPreferenceSession() {
    preferencesLoadGeneration++;
    preferenceDraftGeneration++;
    preferenceViewToken++;
    preferenceSubmission = null;
    preferenceDirty = false;
    preferenceMessage = '';
    preferenceReviewVisible = false;
    clearTimeout(preferenceSavedTimer);
    for (const id of Object.values(preferenceFieldIds)) {
        const element = document.getElementById(id);
        if (element.type === 'checkbox') element.checked = false;
        else element.value = '';
    }
    document.getElementById('prefFormatCustom').value = '';
    document.getElementById('preferenceCurrentValues').textContent = '';
    renderPreferenceStatus();
}

const preferenceFieldIds = {
    download_dir: 'prefDir', format: 'prefFormat', history_page_size: 'prefPageSize', max_concurrent: 'prefMax',
    max_concurrent_per_host: 'prefMaxPerHost', max_total_download_mbps: 'prefMaxMbps', player_mode: 'prefPlayer',
    start_fullscreen: 'prefStartFullscreen', skip_video_edges: 'prefSkipVideoEdges', library_rotation_enabled: 'prefLibraryRotation',
    library_rotation_hours: 'prefLibraryRotationHours', shuffle_min_height: 'prefShuffleMinHeight',
    shuffle_min_duration_minutes: 'prefShuffleMinDuration', theme: 'prefTheme',
};
for (const id of [...Object.values(preferenceFieldIds), 'prefFormatCustom']) {
    for (const type of ['input', 'change']) document.getElementById(id).addEventListener(type, () => {
        preferenceDraftGeneration++;
        preferenceDirty = true;
        preferenceMessage = '';
        renderPreferenceStatus();
    });
}

loadPreferences();

let pendingFetch = false;
let pendingFavoriteSort = false;
let pendingFullRefresh = false;
function scheduleFetch({ sortFavorites = false, currentOnly = false } = {}) {
    pendingFavoriteSort ||= sortFavorites;
    pendingFullRefresh ||= !currentOnly;
    if (pendingFetch) return;
    pendingFetch = true;
    // Firefox pauses animation frames in background tabs, which is exactly
    // where VDL sits while its toolbar companion starts a download.
    setTimeout(() => {
        pendingFetch = false;
        const applyFavoriteSort = pendingFavoriteSort;
        pendingFavoriteSort = false;
        const fullRefresh = pendingFullRefresh;
        pendingFullRefresh = false;
        if (fullRefresh) {
            fetchHistory({ sortFavorites: applyFavoriteSort });
            fetchPlaylists();
            fetchLibraryStorage();
        } else {
            fetchDownloadCollection('current');
        }
        if (attemptHistoryOpen) {
            if (libraryView === 'duplicates') fetchDuplicates();
            else if (libraryView === 'logs') fetchSystemLogs();
            else fetchAttemptHistory();
        }
    }, 150);
}

function connectEventStream() {
    const es = new EventSource('/api/events');
    es.addEventListener('ready', () => {
        invalidateLibraryOrder();
        hideServerStatus('events');
        scheduleFetch();
        recoverUnconfirmedTags();
        scheduleAssetDemand({ reconcile: true, interaction: false });
    });
    es.addEventListener('assets', event => {
        try { applyAssetReadiness(JSON.parse(event.data).assets || {}); } catch (_) { }
        scheduleAssetDemand({ reconcile: true, interaction: false });
    });
    es.addEventListener('change', event => {
        let change;
        try { change = JSON.parse(event.data); } catch (_) { /* Reconcile unknown events fully. */ }
        if (change?.reason === 'library_rotation') invalidateLibraryOrder();
        const currentOnly = change?.reason === 'update'
            && collectionSnapshots.current.some(info => String(info.id) === String(change.id));
        scheduleFetch({ currentOnly });
    });
    es.addEventListener('maintenance', fetchSystemLogs);
    es.addEventListener('library_storage', fetchLibraryStorage);
    es.addEventListener('playlist-progress', fetchPlaylists);
    es.addEventListener('error', () => {
        showServerStatus();
    });
    return es;
}

window.addEventListener('focus', () => { invalidateLibraryOrder(); scheduleFetch(); recoverUnconfirmedTags(); });
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { invalidateLibraryOrder(); scheduleFetch(); }
});

loadTagCapabilities();
connectEventStream();
// A fresh page has no visual order to preserve, so establish favorite-first
// ordering once. Later reconciliations keep that order until a filter runs.
fetchHistory({ sortFavorites: true });
fetchPlaylists();
fetchLibraryStorage();

document.getElementById('playlistName').addEventListener(
    'input', markPlaylistEditorDirty,
);
document.getElementById('playlistVideoSearch').addEventListener(
    'input', renderPlaylistEditor,
);
document.getElementById('playlistEditorDialog').addEventListener('cancel', event => {
    event.preventDefault();
    closePlaylistEditor();
});
document.getElementById('playlistChooserDialog').addEventListener('cancel', event => {
    event.preventDefault();
    closePlaylistChooser();
});

document.getElementById('playlistDeleteDialog').addEventListener('cancel', event => { event.preventDefault(); closePlaylistDelete(); });
