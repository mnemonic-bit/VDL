// Statuses that count as "in flight" (the worker thread is alive).
const RUNNING_STATUSES = new Set(['starting', 'downloading']);
// Statuses shown under the Current tab. Cancelled and interrupted
// stay here so the user can resume them; everything else terminal
// goes to History.
const CURRENT_TAB_STATUSES = new Set(['starting', 'downloading', 'paused', 'cancelled', 'interrupted']);
const HISTORY_TAB_STATUSES = new Set(['finished', 'error']);
const TERMINAL_STATUSES = new Set(['finished', 'error', 'cancelled', 'interrupted']);

let _bannerDismissed = false;

function showServerBanner() {
    _bannerDismissed = false;
    document.getElementById('serverBanner').style.display = '';
}

function hideServerBanner() {
    document.getElementById('serverBanner').style.display = 'none';
}

function apiFetch(url, options) {
    return fetch(url, options).then(res => {
        hideServerBanner();
        return res;
    }).catch(err => {
        showServerBanner();
        throw err;
    });
}

function hideActionError() {
    document.getElementById('actionError').hidden = true;
}

function showActionError(message) {
    document.getElementById('actionErrorMessage').textContent = message;
    document.getElementById('actionError').hidden = false;
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
        ? `Version mismatch: UI version ${uiVersion}; ${apiLabel}. Refresh the page.`
        : `UI and API version ${uiVersion} match.`;
}

function checkHealth() {
    return apiFetch('/api/health')
        .then(res => {
            if (!res.ok) throw new Error(`Health check failed with status ${res.status}`);
            return res.json();
        })
        .then(data => updateApiVersion(data && data.version, false))
        .catch(() => updateApiVersion(null, true));
}

setInterval(() => {
    checkHealth();
}, 30000);

checkHealth();

function startDownload(event) {
    if (event) event.preventDefault();
    const url = document.getElementById('urlInput').value;
    if (!url) return alert('Please enter a URL');
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
    
    apiFetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: url,
            format: finalFormat || undefined,
            filename: customFilename || undefined
        })
    })
    .then(res => res.json())
    .then(() => {
        document.getElementById('urlInput').value = '';
        updateUrlClear();
        document.getElementById('optionsFilename').value = '';
        const qualitySelect = document.getElementById('optionsQualitySelect');
        qualitySelect.selectedIndex = 0;
        const containerSelect = document.getElementById('optionsContainerSelect');
        containerSelect.selectedIndex = 0;
        resetOptions();
        if (optionsDetails && !optionsOpenedManually) setOptionsOpen(false);
        fetchHistory();
    });
}

let probeTimeout;
const urlInput = document.getElementById('urlInput');
const urlClear = document.getElementById('urlClear');
const optionsDetails = document.querySelector('#optionsContainer details');

function updateUrlClear() {
    urlClear.style.display = urlInput.value ? '' : 'none';
}

urlClear.addEventListener('click', () => {
    urlInput.value = '';
    clearTimeout(probeTimeout);
    resetOptions();
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
        // from child elements (e.g. the overlay's opacity transition) don't
        // fire this handler prematurely. The setTimeout fallback guarantees
        // [open] is cleared even if transitionend is suppressed (e.g. when
        // the DOM is mutated mid-transition by resetOptions()).
        const closePanel = () => { optionsDetails.open = false; };
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
    clearTimeout(probeTimeout);
    updateUrlClear();
    const url = urlInput.value.trim();
    if (!url) {
        resetOptions();
        return;
    }
    if (optionsDetails) {
        setOptionsOpen(true);
    }
    const overlay = document.getElementById('optionsOverlay');
    if (overlay) overlay.classList.add('hidden');
    probeTimeout = setTimeout(() => probeVideoUrl(url), 500);
});

urlInput.addEventListener('paste', () => {
    clearTimeout(probeTimeout);
    setTimeout(() => {
        updateUrlClear();
        const url = urlInput.value.trim();
        if (!url) {
            resetOptions();
            return;
        }
        if (optionsDetails) {
            setOptionsOpen(true);
        }
        const overlay = document.getElementById('optionsOverlay');
        if (overlay) overlay.classList.add('hidden');
        probeTimeout = setTimeout(() => probeVideoUrl(url), 500);
    }, 0);
});
        
function probeVideoUrl(url) {
    const overlay = document.getElementById('optionsOverlay');
    if (overlay) overlay.classList.add('hidden');

    const select = document.getElementById('optionsQualitySelect');
    if (optionsDetails) {
        setOptionsOpen(true);
    }
    select.disabled = true;
    select.innerHTML = '<option value="">Use default preference</option>';
    
    apiFetch('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) {
            select.disabled = true;
            const errorOption = document.createElement('option');
            errorOption.value = '';
            errorOption.textContent = 'Probe failed';
            select.appendChild(errorOption);
                    
            const containerSelect = document.getElementById('optionsContainerSelect');
            containerSelect.innerHTML = '<option value="">Automatic</option>';
            containerSelect.disabled = true;
            return;
        }
                
        if (data.title) {
            document.getElementById('optionsFilename').placeholder = `Will be auto-filled: ${escapeHtml(data.title)}`;
        }
                
        if (data.resolutions && data.resolutions.length > 0) {
            data.resolutions.forEach(res => {
                const height = parseInt(res);
                const formatSelector = `bestvideo[height<=${height}]+bestaudio/best`;
                const option = document.createElement('option');
                option.value = formatSelector;
                option.textContent = res;
                select.appendChild(option);
            });
            select.disabled = false;
        } else {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No video formats detected';
            select.appendChild(option);
            select.disabled = true;
        }
                
        const containerSelect = document.getElementById('optionsContainerSelect');
        containerSelect.innerHTML = '<option value="">Automatic</option>';
        if (data.containers && data.containers.length > 0) {
            data.containers.forEach(ext => {
                const option = document.createElement('option');
                option.value = ext;
                option.textContent = ext.toUpperCase();
                containerSelect.appendChild(option);
            });
            containerSelect.disabled = false;
        } else {
            containerSelect.disabled = true;
        }
    })
    .catch(err => {
        select.disabled = true;
        select.innerHTML = '<option value="">Use default preference</option>';
                
        const containerSelect = document.getElementById('optionsContainerSelect');
        containerSelect.innerHTML = '<option value="">Automatic</option>';
        containerSelect.disabled = true;
    });
}
        
function resetOptions() {
    const qualitySelect = document.getElementById('optionsQualitySelect');
    qualitySelect.innerHTML = '<option value="">Use default preference</option>';
    qualitySelect.disabled = true;
    
    const containerSelect = document.getElementById('optionsContainerSelect');
    containerSelect.innerHTML = '<option value="">Automatic</option>';
    containerSelect.disabled = true;
    
    document.getElementById('optionsFilename').value = '';
    document.getElementById('optionsFilename').placeholder = 'Will be auto-filled from video title';
    const overlay = document.getElementById('optionsOverlay');
    if (overlay) overlay.classList.remove('hidden');
}

function stopDownload(id) {
    closeAllMenus();
    apiAction('/api/stop/' + encodeURIComponent(id), { method: 'POST' })
        .then(() => fetchHistory())
        .catch(() => fetchHistory());
}

const renameDrafts = new Map();

function renderRenameControl(id, basename) {
    if (renameDrafts.has(id)) {
        const draft = renameDrafts.get(id);
        const widthStyle = draft.width ? `style="width:${draft.width}px"` : '';
        return `<span class="rename-wrap" data-rename-id="${id}" data-mode="edit">
                    <input class="rename-input" type="text" ${widthStyle} value="${escapeAttr(draft.value)}" data-orig="${escapeAttr(basename)}" oninput="renameOnInput('${id}', this.value)" />
                    <button class="rename-btn confirm" type="button" title="Save" aria-label="Save" onclick="renameCommit('${id}')">
                        <svg class="icon"><use href="#i-check"/></svg>
                    </button>
                    <button class="rename-btn cancel" type="button" title="Cancel" aria-label="Cancel" onclick="renameCancel('${id}')">
                        <svg class="icon"><use href="#i-x"/></svg>
                    </button>
                </span>`;
    }
    return `<span class="rename-wrap" data-rename-id="${id}" data-mode="display">
                <span class="rename-display" data-orig="${escapeAttr(basename)}">${escapeHtml(basename)}</span>
                <button class="rename-btn" type="button" title="Edit name" aria-label="Edit name" onclick="renameStart('${id}')">
                    <svg class="icon"><use href="#i-pencil"/></svg>
                </button>
            </span>`;
}

function renameOnInput(id, value) {
    const cur = renameDrafts.get(id);
    if (!cur) return;
    cur.value = value;
}

function bindRenameInputs() {
    document.querySelectorAll('.rename-wrap[data-mode="edit"] .rename-input').forEach((input) => {
        if (input.dataset.bound === '1') return;
        input.dataset.bound = '1';
        const wrap = input.closest('.rename-wrap');
        const id = wrap && wrap.dataset.renameId;
        if (!id) return;
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); renameCommit(id); }
            else if (ev.key === 'Escape') { ev.preventDefault(); renameCancel(id); }
        });
    });
}

function renameStart(id) {
    const wrap = document.querySelector(`.rename-wrap[data-rename-id="${id}"]`);
    if (!wrap) return;
    const disp = wrap.querySelector('.rename-display');
    const orig = disp ? disp.dataset.orig : '';
    const dispRect = disp ? disp.getBoundingClientRect() : null;
    const width = dispRect ? Math.round(dispRect.width) : 0;
    renameDrafts.set(id, { value: orig, width });
    fetchHistory().then(() => {
        const input = document.querySelector(`.rename-wrap[data-rename-id="${id}"] .rename-input`);
        if (!input) return;
        input.focus();
        const dot = orig.lastIndexOf('.');
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
    });
}

function renameCancel(id) {
    renameDrafts.delete(id);
    fetchHistory();
}

function renameCommit(id) {
    const wrap = document.querySelector(`.rename-wrap[data-rename-id="${id}"]`);
    if (!wrap) { renameDrafts.delete(id); return; }
    const input = wrap.querySelector('.rename-input');
    if (!input) { renameDrafts.delete(id); return; }
    const draft = renameDrafts.get(id);
    const newName = ((input.value !== undefined ? input.value
        : (draft && draft.value) || '') || '').trim();
    const orig = input.dataset.orig || '';
    if (!newName || newName === orig) {
        renameDrafts.delete(id);
        fetchHistory();
        return;
    }
    input.disabled = true;
    wrap.querySelectorAll('button').forEach(b => b.disabled = true);
    apiFetch('/api/rename/' + encodeURIComponent(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: newName }),
    }).then(async (r) => {
        if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            alert('Rename failed: ' + (data.error || r.statusText));
            input.disabled = false;
            wrap.querySelectorAll('button').forEach(b => b.disabled = false);
            return;
        }
        renameDrafts.delete(id);
        fetchHistory();
    }).catch((err) => {
        alert('Rename failed: ' + err);
        input.disabled = false;
        wrap.querySelectorAll('button').forEach(b => b.disabled = false);
    });
}

function pauseDownload(id) {
    closeAllMenus();
    apiAction('/api/pause/' + encodeURIComponent(id), { method: 'POST' })
        .then(() => fetchHistory())
        .catch(() => fetchHistory());
}

function unpauseDownload(id) {
    closeAllMenus();
    apiAction('/api/unpause/' + encodeURIComponent(id), { method: 'POST' })
        .then(() => fetchHistory())
        .catch(() => fetchHistory());
}

function reloadDownload(id, url) {
    closeAllMenus();
    apiAction('/api/remove/' + encodeURIComponent(id), { method: 'POST' })
        .then(() => apiAction('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url })
        }))
        .then(() => fetchHistory())
        .catch(() => fetchHistory());
}

function continueDownload(id, url) {
    closeAllMenus();
    apiAction('/api/resume/' + encodeURIComponent(id), { method: 'POST' })
        .then(() => fetchHistory())
        .catch(() => fetchHistory());
}

function deleteDownload(id) {
    closeAllMenus();
    const row = document.querySelector(`[data-row-id="${id}"]`);
    if (row) {
        row.classList.add('item-fade-out');
        row.addEventListener('animationend', () => row.remove(), { once: true });
    }
    apiAction('/api/remove/' + encodeURIComponent(id), { method: 'POST' })
        .then(() => fetchHistory())
        .catch(() => fetchHistory());
}

function clearHistory() {
    apiAction('/api/clear/preview')
        .then(r => r.json())
        .then(data => {
            const entries = data.entries || 0;
            if (!entries) { fetchHistory(); return; }
            const files = data.with_files || 0;
            const fileLine = files > 0
                ? ` and delete ${files} file${files !== 1 ? 's' : ''} from disk`
                : '';
            const msg = `Remove ${entries} history entr${entries !== 1 ? 'ies' : 'y'}${fileLine}?`;
            if (!confirm(msg)) return;
            return apiAction('/api/clear', { method: 'POST' })
                .then(() => fetchHistory());
        })
        .catch(() => fetchHistory());
}

let openMenuId = null;

function renderFormatsTable(info) {
    let formats = info.formats;
    if (!formats) return '';
    if (typeof formats === 'string') {
        try { formats = JSON.parse(formats); } catch (e) { return ''; }
    }
    if (!Array.isArray(formats) || formats.length === 0) return '';

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
    document.querySelectorAll('.kebab-menu.open').forEach(m => m.classList.remove('open'));
    openMenuId = null;
}

function toggleMenu(id, ev) {
    ev.stopPropagation();
    const menu = document.getElementById('menu-' + id);
    if (!menu) return;
    const wasOpen = menu.classList.contains('open');
    closeAllMenus();
    if (!wasOpen) {
        menu.classList.add('open');
        openMenuId = id;
    }
}

document.addEventListener('click', (ev) => {
    const playAction = ev.target.closest('[data-play-action]');
    if (playAction) {
        playVideo(
            playAction.dataset.downloadId,
            playAction.dataset.playLabel,
            playAction.dataset.playExt,
        );
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
                continueDownload(id, url);
                break;
            case 'reload':
                reloadDownload(id, url);
                break;
            case 'copy':
                copyToClipboard(url, urlAction);
                break;
        }
    }
    if (ev.target.closest('.kebab-menu') || ev.target.closest('.kebab-btn')) return;
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

function formatBytes(n) {
    if (n == null || isNaN(n)) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
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

const COPY_URL_HTML    = '<svg class="menu-icon"><use href="#i-copy"/></svg>Copy URL';
const COPIED_HTML      = '<svg class="menu-icon"><use href="#i-check"/></svg>Copied';

function copyToClipboard(text, btn) {
    const done = () => {
        if (!btn) return;
        if (btn._copyTimer) clearTimeout(btn._copyTimer);
        btn.innerHTML = COPIED_HTML;
        btn._copyTimer = setTimeout(() => {
            btn.innerHTML = COPY_URL_HTML;
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
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
}

function renderItem(info, inHistoryView = false) {
    const id = info.id;
    const isRunning = RUNNING_STATUSES.has(info.status);
    const isPaused = info.status === 'paused';
    const isCancelled = info.status === 'cancelled';
    const isTerminal = TERMINAL_STATUSES.has(info.status);
    const isFinished = info.status === 'finished';
    const isCurrentTabStopped = !inHistoryView && (isCancelled || info.status === 'interrupted');

    let statusLabel;
    if (isFinished) statusLabel = 'Complete';
    else if (info.status === 'error') statusLabel = 'Error';
    else if (info.status === 'cancelled') statusLabel = 'Cancelled';
    else if (info.status === 'interrupted') statusLabel = 'Interrupted';
    else if (isPaused) statusLabel = 'Paused';
    else statusLabel = info.progress;

    // URLs stay in data attributes and are read through dataset by the
    // delegated click handler. Putting them inside inline JavaScript would
    // let HTML entity decoding turn an apostrophe back into executable code.
    const safeUrl = escapeAttr(info.url);
    const urlData = `data-url="${safeUrl}"`;

    let primary = '';
    const menuItems = [];

    if (isRunning) {
        primary = `<button class="stop-btn" onclick="stopDownload('${id}')"><svg class="icon"><use href="#i-stop"/></svg>Stop</button>`;
    } else if (isPaused) {
        primary = `<button class="continue-btn" onclick="unpauseDownload('${id}')"><svg class="icon"><use href="#i-play"/></svg>Resume</button>`;
    } else if (isCancelled || info.status === 'interrupted') {
        primary = `<button class="continue-btn" data-url-action="continue" data-download-id="${id}" ${urlData}><svg class="icon"><use href="#i-play"/></svg>Continue</button>`;
    }

    menuItems.push(`<button data-url-action="open" ${urlData}><svg class="menu-icon"><use href="#i-external"/></svg>Open URL</button>`);

    if (isRunning) {
        menuItems.push(`<button onclick="pauseDownload('${id}')"><svg class="menu-icon"><use href="#i-pause"/></svg>Pause</button>`);
    }

    if (isPaused) {
        menuItems.push(`<button onclick="stopDownload('${id}')"><svg class="menu-icon"><use href="#i-stop"/></svg>Stop</button>`);
    }

    if (isTerminal) {
        if (!isFinished && !isCancelled && info.status !== 'interrupted') {
            menuItems.push(`<button data-url-action="reload" data-download-id="${id}" ${urlData}><svg class="menu-icon"><use href="#i-sync"/></svg>Reload</button>`);
        }
        menuItems.push(`<button data-url-action="copy" ${urlData}><svg class="menu-icon"><use href="#i-copy"/></svg>Copy URL</button>`);
        menuItems.push(`<button class="danger" onclick="deleteDownload('${id}')"><svg class="menu-icon"><use href="#i-trash"/></svg>Delete</button>`);
    } else {
        menuItems.push(`<button data-url-action="copy" ${urlData}><svg class="menu-icon"><use href="#i-copy"/></svg>Copy URL</button>`);
    }

    const hasPlay = isFinished && info.filename;
    let playBtn = '';
    if (hasPlay) {
        const playLabel = info.filename.split('/').pop().split('\\').pop();
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

    let bottom = '';
    if (isRunning || isCurrentTabStopped) {
        let width = String(info.progress).replace('%', '');
        if (isNaN(width)) width = 0;
        const etaStr = isRunning ? formatEta(info.eta) : '';
        const sizeStr = formatBytes(info.filesize);
        const resStr = info.resolution;
        const statusRow = `<div class="status-row">
                        <span><strong>Status:</strong> ${info.status} (${statusLabel})</span>
                        ${etaStr ? `<span class="eta-right">${etaStr}</span>` : ''}
                    </div>`;
        const sizeQualityParts = [];
        if (sizeStr) sizeQualityParts.push(`<strong>Total size:</strong> ${sizeStr}`);
        if (resStr)  sizeQualityParts.push(`<strong>Quality:</strong> ${resStr}`);
        const sizeQualityRow = sizeQualityParts.length
            ? `<div class="meta">${sizeQualityParts.join(' &middot; ')}</div>`
            : '';
        let barClass = 'progress-bar-fill';
        if (isCancelled) barClass += ' cancelled';
        else if (info.status === 'interrupted') barClass += ' interrupted';
        bottom = `
                    ${statusRow}
                    ${sizeQualityRow}
                    <div class="progress-bar-bg progress-bar-bottom">
                        <div class="${barClass}" style="width: ${width}%;"></div>
                    </div>`;
    } else {
        if (!isFinished && info.status !== 'error') {
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
        if (info.filename) {
            const base = info.filename.split('/').pop().split('\\').pop();
            if (isFinished) {
                meta.push(`<div class="file-meta-row"><strong>File:</strong>${renderRenameControl(id, base)}</div>`);
            } else {
                meta.push(`<div><strong>File:</strong> <span class="filename">${escapeHtml(base)}</span></div>`);
            }
        }
        if (info.resolution) meta.push(`<div><strong>Quality:</strong> ${info.resolution}</div>`);
        const sizeStr = formatBytes(info.filesize);
        if (sizeStr) meta.push(`<div><strong>Size:</strong> ${sizeStr}</div>`);
        const startedStr = formatDateTime(info.created_at);
        if (startedStr) meta.push(`<div><strong>Started:</strong> ${startedStr}</div>`);
        const finishedStr = formatDateTime(info.finished_at);
        if (finishedStr) {
            const finLabel = info.status === 'finished' ? 'Finished'
                           : info.status === 'error' ? 'Failed'
                           : info.status === 'cancelled' ? 'Cancelled'
                           : 'Ended';
            meta.push(`<div><strong>${finLabel}:</strong> ${finishedStr}</div>`);
        }
        if (info.requested_format) {
            meta.push(`<div><strong>Requested format:</strong> <code class="fmt-code">${escapeHtml(info.requested_format)}</code></div>`);
        }
        if (meta.length) bottom += `<div class="meta">${meta.join('')}</div>`;
    }

    const warn = (isCancelled || info.status === 'interrupted') ? '<span class="warn-icon" title="Action required"></span>' : '';

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
        const base = info.filename.split('/').pop().split('\\').pop();
        displayTitle = base.replace(/\.[^.]+$/, '');
    }
    const titleRow = displayTitle
        ? `<div class="item-title" title="${escapeAttr(displayTitle)}">${escapeHtml(displayTitle)}</div>`
        : '';

    const urlLine = inHistoryView
        ? (warn ? `<div>${warn}<strong>Status:</strong> ${info.status} (${statusLabel})</div>` : '')
        : (isRunning || isCurrentTabStopped)
            ? `<div>${warn}<strong>URL:</strong> ${escapeHtml(info.url)}</div>`
            : `<div>${warn}<strong>URL:</strong> ${escapeHtml(info.url)}</div>
                   <div><strong>Status:</strong> ${info.status} (${statusLabel})</div>`;
    const headMeta = inHistoryView
        ? (warn ? `<div class="meta">${urlLine}</div>` : '')
        : `<div class="meta">${urlLine}</div>`;

    return `
                <div class="history-item" data-row-id="${id}">
                    <div class="row-actions">${actions}</div>
                    ${titleRow}
                    ${headMeta}
                    ${bottom}
                    ${errorBlock}
                </div>
            `;
}

const HISTORY_PAGE_SIZE = 10;
let historyPage = 0;
let historyTotal = 0;
let _renderedActiveIds  = new Set();
let _renderedHistoryIds = new Set();

function changePage(delta) {
    const maxPage = Math.max(0, Math.ceil(historyTotal / HISTORY_PAGE_SIZE) - 1);
    const next = Math.min(maxPage, Math.max(0, historyPage + delta));
    if (next === historyPage) return;
    historyPage = next;
    fetchHistory();
}

function goToPage(target) {
    const maxPage = Math.max(0, Math.ceil(historyTotal / HISTORY_PAGE_SIZE) - 1);
    const next = Math.min(maxPage, Math.max(0, target));
    if (next === historyPage) return;
    historyPage = next;
    fetchHistory();
}

function fetchHistory() {
    if (openMenuId !== null) return Promise.resolve();

    return apiFetch('/api/history')
    .then(res => res.json())
    .then(data => {
        const reversed = data.slice().reverse();
        const active = reversed.filter(i => CURRENT_TAB_STATUSES.has(i.status));
        const done   = reversed.filter(i => HISTORY_TAB_STATUSES.has(i.status));

        historyTotal = done.length;
        const maxPage = Math.max(0, Math.ceil(historyTotal / HISTORY_PAGE_SIZE) - 1);
        if (historyPage > maxPage) historyPage = maxPage;
        const start = historyPage * HISTORY_PAGE_SIZE;
        const pageItems = done.slice(start, start + HISTORY_PAGE_SIZE);

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
        }

        const activeTabVisible   = document.getElementById('tab-current').classList.contains('active');
        const historyTabVisible  = document.getElementById('tab-history').classList.contains('active');

        const newActiveIds  = new Set(active.map(i => String(i.id)));
        const newHistoryIds = new Set(pageItems.map(i => String(i.id)));

        document.getElementById('activeList').innerHTML  = active.map(i => renderItem(i, false)).join('');
        document.getElementById('historyList').innerHTML = pageItems.map(i => renderItem(i, true)).join('');

        if (activeTabVisible) {
            newActiveIds.forEach(id => {
                if (!_renderedActiveIds.has(id)) {
                    const el = document.querySelector(`#activeList [data-row-id="${id}"]`);
                    if (el) el.classList.add('item-fade-in');
                }
            });
        }
        if (historyTabVisible) {
            newHistoryIds.forEach(id => {
                if (!_renderedHistoryIds.has(id)) {
                    const el = document.querySelector(`#historyList [data-row-id="${id}"]`);
                    if (el) el.classList.add('item-fade-in');
                }
            });
        }

        _renderedActiveIds  = newActiveIds;
        _renderedHistoryIds = newHistoryIds;

        bindRenameInputs();

        if (focusRestore) {
            const newInput = document.querySelector(
                `.rename-wrap[data-rename-id="${focusRestore.id}"] .rename-input`);
            if (newInput) {
                newInput.focus();
                try {
                    newInput.setSelectionRange(
                        focusRestore.selStart, focusRestore.selEnd);
                } catch (e) { }
            }
        }

        document.getElementById('currentEmpty').style.display = active.length ? 'none' : '';
        document.getElementById('historyEmpty').style.display = done.length ? 'none' : '';

        const pager = document.getElementById('historyPager');
        if (historyTotal > HISTORY_PAGE_SIZE) {
            pager.style.display = '';
            document.getElementById('pagerInfo').textContent =
                `Page ${historyPage + 1} of ${maxPage + 1} · ${historyTotal} items`;
            document.getElementById('pagerPrev').disabled = historyPage <= 0;
            document.getElementById('pagerNext').disabled = historyPage >= maxPage;
            const showJump = maxPage >= 2;
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
        if (active.length) {
            badge.textContent = active.length;
            badge.style.display = '';
        } else {
            badge.style.display = 'none';
        }
    });
}

let playerMode = 'overlay';

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

function playVideo(id, label, ext) {
    const url = '/api/file/' + encodeURIComponent(id);
    if (playerMode === 'new_tab') {
        window.open(url, '_blank', 'noopener');
        return;
    }
    const video = document.getElementById('playerVideo');
    document.getElementById('playerTitle').textContent = label || '';
    // Clear any previous <source> children and src attribute before reloading.
    // Setting video.src directly doesn't carry a type hint; using a <source>
    // element with an explicit type lets the browser decide playability before
    // fetching, which is what makes WEBM work on browsers that need the hint.
    video.removeAttribute('src');
    video.innerHTML = '';
    const source = document.createElement('source');
    source.src = url;
    const mime = _VIDEO_MIME[ext] || null;
    if (mime) source.type = mime;
    video.appendChild(source);
    video.load();
    document.getElementById('playerBackdrop').classList.add('open');
}

function closePlayer(ev) {
    const backdrop = document.getElementById('playerBackdrop');
    const video = document.getElementById('playerVideo');
    video.pause();
    video.removeAttribute('src');
    video.innerHTML = '';
    video.load();
    backdrop.classList.remove('open');
}

document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.getElementById('playerBackdrop').classList.contains('open')) {
        closePlayer();
    }

    const isPaste = (ev.key === 'v' || ev.key === 'V') && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey;
    if (!isPaste) return;

    const active = document.activeElement;
    const tag = active ? active.tagName : '';
    const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || (active && active.isContentEditable);
    if (isEditable) return;

    urlInput.focus();
    urlInput.select();
});

function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === name);
    });
    document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.toggle('active', p.id === 'tab-' + name);
    });
    closeAllMenus();
}

function isPresetValue(v) {
    const sel = document.getElementById('prefFormat');
    return Array.from(sel.options).some(o => o.value === v && o.value !== '__custom__');
}

function refreshCustomVisibility() {
    const sel = document.getElementById('prefFormat');
    const row = document.getElementById('customFormatRow');
    row.style.display = sel.value === '__custom__' ? '' : 'none';
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

function loadPreferences() {
    apiFetch('/api/preferences').then(r => r.json()).then(p => {
        document.getElementById('prefDir').value = p.download_dir || '';
        document.getElementById('prefMax').value = p.max_concurrent || '';

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

        playerMode = (p.player_mode === 'new_tab') ? 'new_tab' : 'overlay';
        document.getElementById('prefPlayer').value = playerMode;

        const theme = ['light', 'dark', 'system'].includes(p.theme) ? p.theme : 'system';
        document.getElementById('prefTheme').value = theme;
        applyTheme(theme);
    });
}

document.getElementById('prefTheme').addEventListener('change', (ev) => {
    applyTheme(ev.target.value);
});

function savePreferences() {
    const sel = document.getElementById('prefFormat');
    const fmt = sel.value === '__custom__'
        ? document.getElementById('prefFormatCustom').value.trim()
        : sel.value;

    const body = {
        download_dir: document.getElementById('prefDir').value,
        format: fmt || 'best',
        max_concurrent: document.getElementById('prefMax').value,
        player_mode: document.getElementById('prefPlayer').value,
        theme: document.getElementById('prefTheme').value,
    };
    playerMode = body.player_mode;
    applyTheme(body.theme);
    apiFetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(() => {
        const btn = document.getElementById('saveBtn');
        btn.innerHTML = '<svg class="btn-icon"><use href="#i-check"/></svg><span>Saved</span>';
        btn.disabled = true;
        setTimeout(() => {
            btn.innerHTML = '<svg class="btn-icon"><use href="#i-save"/></svg><span>Save</span>';
            btn.disabled = false;
        }, 1500);
    });
}

loadPreferences();

let pendingFetch = false;
function scheduleFetch() {
    if (pendingFetch) return;
    pendingFetch = true;
    requestAnimationFrame(() => {
        pendingFetch = false;
        fetchHistory();
    });
}

function connectEventStream() {
    const es = new EventSource('/api/events');
    es.addEventListener('ready', scheduleFetch);
    es.addEventListener('change', scheduleFetch);
    es.addEventListener('error', () => {
        showServerBanner();
    });
    return es;
}

connectEventStream();
fetchHistory();
