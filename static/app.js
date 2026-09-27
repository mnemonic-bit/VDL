// Statuses that count as "in flight" (the worker thread is alive).
const RUNNING_STATUSES = new Set(['starting', 'downloading']);
const ACTIVE_PROGRESS_STATUSES = new Set(['starting', 'downloading', 'paused']);
// Statuses shown under the Current tab. Cancelled and interrupted
// stay here so the user can resume them; everything else terminal
// goes to History.
const CURRENT_TAB_STATUSES = new Set(['starting', 'downloading', 'paused', 'cancelled', 'interrupted']);
const HISTORY_TAB_STATUSES = new Set(['finished', 'error']);
const TERMINAL_STATUSES = new Set(['finished', 'error', 'cancelled', 'interrupted']);

let _bannerDismissed = false;

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
            updateApiVersion(null, true);
            updateUptime(null, true);
        });
}

setInterval(() => {
    checkHealth();
}, 30000);
setInterval(renderUptime, 1000);

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
    
    apiAction('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: url,
            format: finalFormat || undefined,
            filename: customFilename || undefined
        })
    }).then(() => {
        document.getElementById('urlInput').value = '';
        invalidateProbe();
        updateUrlClear();
        document.getElementById('optionsFilename').value = '';
        const qualitySelect = document.getElementById('optionsQualitySelect');
        qualitySelect.selectedIndex = 0;
        const containerSelect = document.getElementById('optionsContainerSelect');
        containerSelect.selectedIndex = 0;
        resetOptions();
        if (optionsDetails && !optionsOpenedManually) setOptionsOpen(false);
        fetchHistory();
    })
    .catch(() => {});
}

let probeTimeout;
// A request may finish after its URL has been replaced or cleared. Generation
// checks keep those callbacks from restoring options for an obsolete input.
let probeGeneration = 0;
const urlInput = document.getElementById('urlInput');
const urlClear = document.getElementById('urlClear');
const optionsDetails = document.querySelector('#optionsContainer details');

function updateUrlClear() {
    urlClear.style.display = urlInput.value ? '' : 'none';
}

function invalidateProbe() {
    clearTimeout(probeTimeout);
    probeGeneration += 1;
}

function scheduleProbe(url) {
    invalidateProbe();
    const generation = probeGeneration;
    probeTimeout = setTimeout(() => probeVideoUrl(url, generation), 500);
}

urlClear.addEventListener('click', () => {
    urlInput.value = '';
    invalidateProbe();
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
    updateUrlClear();
    const url = urlInput.value.trim();
    if (!url) {
        invalidateProbe();
        resetOptions();
        return;
    }
    if (optionsDetails) {
        setOptionsOpen(true);
    }
    const overlay = document.getElementById('optionsOverlay');
    if (overlay) overlay.classList.add('hidden');
    scheduleProbe(url);
});

urlInput.addEventListener('paste', () => {
    invalidateProbe();
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
        scheduleProbe(url);
    }, 0);
});
        
function probeVideoUrl(url, generation) {
    if (generation !== probeGeneration) return;

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
        if (generation !== probeGeneration) return;

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
            document.getElementById('optionsFilename').placeholder = `Will be auto-filled: ${data.title}`;
        }
                
        const numericResolutions = Array.isArray(data.resolutions)
            ? data.resolutions.flatMap(res => {
                const match = String(res).match(/^(\d+)p$/);
                if (!match) return [];
                const height = Number(match[1]);
                return Number.isSafeInteger(height) && height > 0 ? [height] : [];
            })
            : [];
        if (numericResolutions.length > 0) {
            numericResolutions.forEach(height => {
                const formatSelector = `bestvideo[height<=${height}]+bestaudio/best`;
                const option = document.createElement('option');
                option.value = formatSelector;
                option.textContent = `${height}p`;
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
        if (generation !== probeGeneration) return;

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

let availableTags = [];
let selectedTagFilters = [];
let tagMatchMode = 'all';
const editingTagIds = new Set();
const tagDrafts = new Map();
const pendingTagCommits = new Set();

function tagSearchKey(value) {
    return String(value || '').toLocaleLowerCase();
}

function sortTags(tags) {
    return tags.slice().sort((left, right) => left.localeCompare(
        right, undefined, { sensitivity: 'base' }));
}

function refreshAvailableTags(rows) {
    const names = new Set();
    rows.forEach(row => {
        (Array.isArray(row.tags) ? row.tags : []).forEach(tag => names.add(tag));
    });
    availableTags = sortTags(Array.from(names));
    const available = new Set(availableTags);
    selectedTagFilters = selectedTagFilters.filter(tag => available.has(tag));
    renderTagFilter();
}

function renderTagFilterSuggestions(open) {
    const input = document.getElementById('tagFilterInput');
    const suggestions = document.getElementById('tagFilterSuggestions');
    if (!input || !suggestions) return;
    const query = tagSearchKey(input.value.trim());
    const selected = new Set(selectedTagFilters);
    const matches = availableTags.filter(tag => (
        !selected.has(tag) && (!query || tagSearchKey(tag).includes(query))
    ));
    suggestions.innerHTML = '';
    matches.forEach(tag => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tag-suggestion';
        button.setAttribute('role', 'option');
        button.textContent = tag;
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => {
            selectedTagFilters.push(tag);
            input.value = '';
            historyPage = 0;
            renderTagFilter();
            fetchHistory();
            input.focus();
        });
        suggestions.appendChild(button);
    });
    suggestions.hidden = !open || matches.length === 0;
    input.setAttribute('aria-expanded', String(!suggestions.hidden));
}

function renderTagFilter() {
    const tokens = document.getElementById('tagFilterTokens');
    const input = document.getElementById('tagFilterInput');
    const clear = document.getElementById('clearTagFilter');
    if (!tokens || !input || !clear) return;
    tokens.querySelectorAll('.tag-filter-chip').forEach(chip => chip.remove());
    selectedTagFilters.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip tag-filter-chip';
        chip.append(document.createTextNode(tag));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove ${tag} filter`);
        remove.textContent = '×';
        remove.addEventListener('mousedown', event => event.preventDefault());
        remove.addEventListener('click', () => {
            selectedTagFilters = selectedTagFilters.filter(name => name !== tag);
            historyPage = 0;
            renderTagFilter();
            fetchHistory();
        });
        chip.appendChild(remove);
        tokens.insertBefore(chip, input);
    });
    clear.hidden = selectedTagFilters.length === 0;
    renderTagFilterSuggestions(document.activeElement === input);
}

function matchesTagFilter(info) {
    if (selectedTagFilters.length === 0) return true;
    const tags = new Set(Array.isArray(info.tags) ? info.tags : []);
    if (tagMatchMode === 'any') {
        return selectedTagFilters.some(tag => tags.has(tag));
    }
    return selectedTagFilters.every(tag => tags.has(tag));
}

function tagFilterCommitDraft() {
    const input = document.getElementById('tagFilterInput');
    if (!input) return;
    const query = tagSearchKey(input.value.trim());
    if (!query) return;
    const match = availableTags.find(tag => (
        !selectedTagFilters.includes(tag) && tagSearchKey(tag) === query
    ));
    if (!match) return;
    selectedTagFilters.push(match);
    input.value = '';
    historyPage = 0;
    renderTagFilter();
    fetchHistory();
}

const tagFilterInput = document.getElementById('tagFilterInput');
tagFilterInput.addEventListener('focus', () => renderTagFilterSuggestions(true));
tagFilterInput.addEventListener('input', () => renderTagFilterSuggestions(true));
tagFilterInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        tagFilterCommitDraft();
    } else if (event.key === 'Backspace' && !tagFilterInput.value && selectedTagFilters.length) {
        selectedTagFilters.pop();
        historyPage = 0;
        renderTagFilter();
        fetchHistory();
    } else if (event.key === 'Escape') {
        tagFilterInput.value = '';
        renderTagFilterSuggestions(false);
        tagFilterInput.blur();
    }
});
tagFilterInput.addEventListener('blur', () => {
    setTimeout(() => renderTagFilterSuggestions(false), 0);
});
document.getElementById('tagFilterPicker').addEventListener('click', () => {
    tagFilterInput.focus();
});
document.getElementById('tagMatchMode').addEventListener('change', event => {
    tagMatchMode = event.target.value === 'any' ? 'any' : 'all';
    historyPage = 0;
    fetchHistory();
});
document.getElementById('clearTagFilter').addEventListener('click', () => {
    selectedTagFilters = [];
    tagFilterInput.value = '';
    historyPage = 0;
    renderTagFilter();
    fetchHistory();
});

function tagChipHtml(tag, removable) {
    if (!removable) return `<span class="tag-chip">${escapeHtml(tag)}</span>`;
    return `<span class="tag-chip tag-chip-editing">${escapeHtml(tag)}<button type="button" class="tag-remove" data-remove-tag="${escapeAttr(tag)}" aria-label="Remove ${escapeAttr(tag)}">×</button></span>`;
}

function tagSuggestionsHtml(info, draft) {
    const attached = new Set(Array.isArray(info.tags) ? info.tags : []);
    const query = tagSearchKey(draft.trim());
    return availableTags
        .filter(tag => !attached.has(tag) && (!query || tagSearchKey(tag).includes(query)))
        .map(tag => `<button type="button" class="tag-suggestion" data-suggest-tag="${escapeAttr(tag)}" role="option">${escapeHtml(tag)}</button>`)
        .join('');
}

function renderTagControl(info) {
    const id = String(info.id);
    const tags = Array.isArray(info.tags) ? info.tags : [];
    if (!editingTagIds.has(id)) {
        const contents = tags.length
            ? tags.map(tag => tagChipHtml(tag, false)).join('')
            : '<span class="add-tag-affordance">Add tags</span>';
        return `<div class="tag-row tag-display-row" data-tag-id="${escapeAttr(id)}" data-mode="display" role="button" tabindex="0" aria-label="Edit tags">${contents}</div>`;
    }

    const draft = tagDrafts.get(id) || '';
    const suggestions = tagSuggestionsHtml(info, draft);
    return `<div class="tag-editor-shell" data-tag-id="${escapeAttr(id)}">
                <div class="tag-token-input">
                    ${tags.map(tag => tagChipHtml(tag, true)).join('')}
                    <input class="tag-entry-input" type="text" maxlength="64" value="${escapeAttr(draft)}" autocomplete="off" aria-label="Add tags" aria-expanded="${suggestions ? 'true' : 'false'}">
                </div>
                <div class="tag-suggestions tag-entry-suggestions" role="listbox"${suggestions ? '' : ' hidden'}>${suggestions}</div>
            </div>`;
}

function tagEditStart(id) {
    editingTagIds.add(String(id));
    tagDrafts.set(String(id), '');
    fetchHistory().then(() => {
        const input = document.querySelector(`.tag-editor-shell[data-tag-id="${CSS.escape(String(id))}"] .tag-entry-input`);
        if (input) input.focus();
    });
}

function tagEditStop(id) {
    editingTagIds.delete(String(id));
    tagDrafts.delete(String(id));
    fetchHistory();
}

function mutateDownloadTag(id, tag, method) {
    return apiAction('/api/tags/' + encodeURIComponent(id), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag }),
    }).then(() => true).catch(() => false);
}

function tagCommit(id, explicitTag) {
    const tagId = String(id);
    const input = document.querySelector(`.tag-editor-shell[data-tag-id="${CSS.escape(tagId)}"] .tag-entry-input`);
    const tag = explicitTag === undefined ? ((input && input.value) || '') : explicitTag;
    if (!tag.trim()) return;
    if (pendingTagCommits.has(tagId)) return;

    const draftBeforeCommit = (input && input.value) || '';
    pendingTagCommits.add(tagId);
    tagDrafts.set(tagId, '');
    if (input) {
        // Clear the live field before the API can publish an SSE change. Any
        // reconciliation that wins the race now captures the intended empty
        // draft instead of resurrecting the text that became a chip.
        input.value = '';
        input.dispatchEvent(new Event('input'));
    }

    mutateDownloadTag(id, tag, 'POST')
        .then(succeeded => {
            if (!succeeded) {
                tagDrafts.set(tagId, draftBeforeCommit);
                const currentInput = document.querySelector(`.tag-editor-shell[data-tag-id="${CSS.escape(tagId)}"] .tag-entry-input`);
                if (currentInput) currentInput.value = draftBeforeCommit;
            }
            return fetchHistory();
        })
        .then(() => {
            const nextInput = document.querySelector(`.tag-editor-shell[data-tag-id="${CSS.escape(tagId)}"] .tag-entry-input`);
            if (nextInput) nextInput.focus();
        })
        .finally(() => pendingTagCommits.delete(tagId));
}

function tagRemove(id, tag) {
    mutateDownloadTag(id, tag, 'DELETE')
        .then(() => fetchHistory())
        .then(() => {
            const input = document.querySelector(`.tag-editor-shell[data-tag-id="${CSS.escape(String(id))}"] .tag-entry-input`);
            if (input) input.focus();
        });
}

function bindTagEditors() {
    document.querySelectorAll('.tag-display-row').forEach(row => {
        row.addEventListener('click', () => tagEditStart(row.dataset.tagId));
        row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                tagEditStart(row.dataset.tagId);
            }
        });
    });
    document.querySelectorAll('.tag-editor-shell').forEach(shell => {
        const id = shell.dataset.tagId;
        const input = shell.querySelector('.tag-entry-input');
        input.addEventListener('input', () => {
            tagDrafts.set(id, input.value);
            const suggestions = shell.querySelector('.tag-entry-suggestions');
            const info = { tags: Array.from(shell.querySelectorAll('[data-remove-tag]')).map(button => button.dataset.removeTag) };
            const html = tagSuggestionsHtml(info, input.value);
            suggestions.innerHTML = html;
            suggestions.hidden = !html;
            input.setAttribute('aria-expanded', String(Boolean(html)));
            bindTagSuggestionButtons(shell);
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                tagCommit(id);
            } else if (event.key === 'Backspace' && !input.value) {
                const buttons = shell.querySelectorAll('[data-remove-tag]');
                const last = buttons[buttons.length - 1];
                if (last) {
                    event.preventDefault();
                    tagRemove(id, last.dataset.removeTag);
                }
            } else if (event.key === 'Escape') {
                event.preventDefault();
                tagEditStop(id);
            }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => {
                // SSE/API reconciliation can replace the whole row while the
                // editor remains logically open. Ignore blur from that stale
                // node; the newly rendered input owns the current session.
                if (!document.body.contains(shell)) return;
                if (!shell.contains(document.activeElement)) tagEditStop(id);
            }, 0);
        });
        shell.querySelectorAll('[data-remove-tag]').forEach(button => {
            button.addEventListener('mousedown', event => event.preventDefault());
            button.addEventListener('click', event => {
                event.stopPropagation();
                tagRemove(id, button.dataset.removeTag);
            });
        });
        bindTagSuggestionButtons(shell);
        shell.querySelector('.tag-token-input').addEventListener('click', event => {
            if (!event.target.closest('button')) input.focus();
        });
    });
}

function bindTagSuggestionButtons(shell) {
    const id = shell.dataset.tagId;
    shell.querySelectorAll('[data-suggest-tag]').forEach(button => {
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => tagCommit(id, button.dataset.suggestTag));
    });
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
let historyFetchDeferred = false;
const heldRowActionPointers = new Set();

function historyRefreshBlocked() {
    return openMenuId !== null || heldRowActionPointers.size > 0;
}

function resumeDeferredHistoryFetch() {
    if (historyRefreshBlocked() || !historyFetchDeferred) return;
    historyFetchDeferred = false;
    // requestAnimationFrame runs after the click synthesized for pointerup, so
    // the pressed action can finish before reconciliation replaces its row.
    scheduleFetch();
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
    if (hadOpenMenu) {
        // Schedule after the click finishes so switching directly to another
        // menu keeps its actions stable and defers the refresh again.
        resumeDeferredHistoryFetch();
    }
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

    // URLs stay in data attributes and are read through dataset by the
    // delegated click handler. Putting them inside inline JavaScript would
    // let HTML entity decoding turn an apostrophe back into executable code.
    const safeUrl = escapeAttr(info.url);
    const urlData = `data-url="${safeUrl}"`;

    let primary = '';
    const menuItems = [];

    if (isRunning) {
        primary = `<button class="stop-btn icon-only" onclick="stopDownload('${id}')" aria-label="Stop" title="Stop">${renderActionProgressIcon('i-pause', info)}</button>`;
    } else if (isPaused) {
        primary = `<button class="continue-btn" onclick="unpauseDownload('${id}')">${renderActionProgressIcon('i-play', info)}Resume</button>`;
    } else if (isCancelled || info.status === 'interrupted') {
        primary = `<button class="continue-btn icon-only" data-url-action="continue" data-download-id="${id}" ${urlData} aria-label="Continue" title="Continue">${renderActionProgressIcon('i-play', info)}</button>`;
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

    const isCurrentRow = !inHistoryView && CURRENT_TAB_STATUSES.has(info.status);
    const etaStr = isRunning ? formatEta(info.eta) : '';
    const downloadedPercent = itemProgressPercent(info);
    const downloadSummaryParts = [];
    const summarySize = formatBytes(info.filesize);
    if (summarySize) downloadSummaryParts.push(`<strong>Total size:</strong> ${summarySize}`);
    if (info.resolution) downloadSummaryParts.push(`<strong>Quality:</strong> ${info.resolution}`);
    downloadSummaryParts.push(`<strong>Downloaded:</strong> ${downloadedPercent === null ? '&mdash;' : `${downloadedPercent}%`}`);
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
        if (info.filename) {
            const base = info.filename.split('/').pop().split('\\').pop();
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
        const base = info.filename.split('/').pop().split('\\').pop();
        displayTitle = base.replace(/\.[^.]+$/, '');
    }
    const titleRow = displayTitle
        ? `<div class="item-title" title="${escapeAttr(displayTitle)}">${escapeHtml(displayTitle)}</div>`
        : '';
    const tagRow = renderTagControl(info);

    return `
                <div class="history-item" data-row-id="${id}">
                    <div class="row-actions">${actions}</div>
                    ${titleRow}
                    ${tagRow}
                    ${bottom}
                    ${downloadSummaryRow}
                    ${errorBlock}
                </div>
            `;
}

const HISTORY_PAGE_SIZE = 10;
let historyPage = 0;
let historyTotal = 0;
let _renderedActiveIds  = new Set();
let _renderedHistoryIds = new Set();

function animateInsertedItem(element) {
    // Rows vary with their metadata, so animate toward the natural box size
    // instead of leaving every completed row under a guessed height limit.
    const style = getComputedStyle(element);
    element.style.setProperty('--item-expanded-height', `${element.getBoundingClientRect().height}px`);
    element.style.setProperty('--item-expanded-padding-top', style.paddingTop);
    element.style.setProperty('--item-expanded-padding-bottom', style.paddingBottom);
    element.style.setProperty('--item-expanded-margin-bottom', style.marginBottom);
    element.style.setProperty('--item-expanded-border-top-width', style.borderTopWidth);
    element.style.setProperty('--item-expanded-border-bottom-width', style.borderBottomWidth);
    element.classList.add('item-fade-in');

    const finish = event => {
        if (event.target !== element || event.animationName !== 'item-fade-in') return;
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
    element.addEventListener('animationend', finish);
}

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
    if (historyRefreshBlocked()) {
        historyFetchDeferred = true;
        return Promise.resolve();
    }

    return apiFetch('/api/history')
    .then(res => res.json())
    .then(data => {
        if (historyRefreshBlocked()) {
            historyFetchDeferred = true;
            return;
        }
        const reversed = data.slice().reverse();
        updateProgressIndicators(reversed);
        refreshAvailableTags(reversed);
        const active = reversed.filter(i => (
            CURRENT_TAB_STATUSES.has(i.status) && matchesTagFilter(i)
        ));
        const done = reversed.filter(i => (
            HISTORY_TAB_STATUSES.has(i.status) && matchesTagFilter(i)
        ));

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
                    if (el) animateInsertedItem(el);
                }
            });
        }
        if (historyTabVisible) {
            newHistoryIds.forEach(id => {
                if (!_renderedHistoryIds.has(id)) {
                    const el = document.querySelector(`#historyList [data-row-id="${id}"]`);
                    if (el) animateInsertedItem(el);
                }
            });
        }

        _renderedActiveIds  = newActiveIds;
        _renderedHistoryIds = newHistoryIds;

        bindRenameInputs();
        bindTagEditors();

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

        const hasFilter = selectedTagFilters.length > 0;
        document.getElementById('currentEmpty').textContent = hasFilter
            ? 'No current downloads match this tag filter.'
            : 'No active downloads. Paste a URL above to start.';
        document.getElementById('historyEmpty').textContent = hasFilter
            ? 'No download history matches this tag filter.'
            : 'No completed downloads yet.';
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
    document.getElementById('tagFilter').style.display = name === 'preferences'
        ? 'none'
        : '';
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
    apiAction('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(() => {
        playerMode = body.player_mode;
        applyTheme(body.theme);
        const btn = document.getElementById('saveBtn');
        btn.innerHTML = '<svg class="btn-icon"><use href="#i-check"/></svg><span>Saved</span>';
        btn.disabled = true;
        setTimeout(() => {
            btn.innerHTML = '<svg class="btn-icon"><use href="#i-save"/></svg><span>Save</span>';
            btn.disabled = false;
        }, 1500);
    }).catch(() => {});
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
