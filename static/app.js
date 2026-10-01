// Statuses that count as "in flight" (the worker thread is alive).
const RUNNING_STATUSES = new Set(['starting', 'downloading']);
const ACTIVE_PROGRESS_STATUSES = new Set(['starting', 'downloading', 'paused']);
// Statuses shown under the Current tab. Cancelled and interrupted
// stay here so the user can resume them; everything else terminal
// goes to History.
const CURRENT_TAB_STATUSES = new Set(['starting', 'downloading', 'paused', 'cancelled', 'interrupted']);
const HISTORY_TAB_STATUSES = new Set(['finished', 'error']);
const TERMINAL_STATUSES = new Set(['finished', 'error', 'cancelled', 'interrupted']);

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

function showServerStatus() {
    document.getElementById('serverStatus').hidden = false;
    document.getElementById('versionFooter').classList.add('server-unavailable');
}

function hideServerStatus() {
    document.getElementById('serverStatus').hidden = true;
    document.getElementById('versionFooter').classList.remove('server-unavailable');
}

function apiFetch(url, options) {
    return fetch(url, options).then(res => {
        hideServerStatus();
        if (res.status === 401) {
            window.location.assign('/login');
            throw new Error('Your session has ended. Sign in again.');
        }
        return res;
    }).catch(err => {
        showServerStatus();
        throw err;
    });
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
let uploadInProgress = false;
let uploadOverlayTimer = null;
const activeUploadRequests = new Map();

function isFileDrag(event) {
    return event.dataTransfer
        && Array.from(event.dataTransfer.types || []).includes('Files');
}

function showUploadOverlay(title, detail, uploading = false) {
    clearTimeout(uploadOverlayTimer);
    uploadDropTitle.textContent = title;
    uploadDropDetail.textContent = detail;
    uploadDropOverlay.classList.add('active');
    uploadDropOverlay.classList.toggle('uploading', uploading);
    uploadDropOverlay.setAttribute('aria-hidden', 'false');
    if (!uploadDropOverlay.open) uploadDropOverlay.showModal();
}

function hideUploadOverlay() {
    uploadDropOverlay.classList.remove('active', 'uploading');
    uploadDropOverlay.setAttribute('aria-hidden', 'true');
    if (uploadDropOverlay.open) uploadDropOverlay.close();
}

function transferDroppedVideo(id, file) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        activeUploadRequests.set(String(id), request);
        request.open('PUT', '/api/upload/' + encodeURIComponent(id));
        request.setRequestHeader(
            'Content-Type', file.type || 'application/octet-stream');
        request.onload = () => {
            const data = (() => {
                try { return JSON.parse(request.responseText || '{}'); }
                catch (error) { return {}; }
            })();
            if (request.status >= 200 && request.status < 300) {
                resolve(data);
            } else if (request.status === 409 && data.error === 'Upload cancelled') {
                resolve(data);
            } else {
                reject(new Error(data.error || request.statusText || 'Upload failed'));
            }
        };
        request.onerror = () => reject(new Error('Upload connection failed'));
        request.onabort = () => resolve({ cancelled: true });
        request.onloadend = () => {
            activeUploadRequests.delete(String(id));
            fetchHistory({ sortFavorites: true }).catch(() => {});
        };
        request.send(file);
    });
}

async function registerDroppedVideo(file) {
    const response = await apiFetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, filesize: file.size }),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || response.statusText || 'Upload failed');
    }
    const data = await response.json();
    return {
        file,
        id: data.id,
        completion: transferDroppedVideo(data.id, file),
    };
}

async function uploadDroppedVideos(files) {
    if (uploadInProgress || !files.length) return;
    uploadInProgress = true;
    hideActionError();
    const failures = [];
    const transfers = [];

    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const prefix = files.length > 1 ? `${index + 1} of ${files.length}: ` : '';
        showUploadOverlay('Preparing upload…', prefix + file.name, true);
        try {
            transfers.push(await registerDroppedVideo(file));
        } catch (error) {
            failures.push(`${file.name}: ${error.message || 'Upload failed'}`);
        }
    }

    uploadInProgress = false;
    await fetchHistory().catch(() => {});
    if (transfers.length > 0) {
        const noun = transfers.length === 1 ? 'Upload' : `${transfers.length} uploads`;
        showUploadOverlay(
            `${noun} started`,
            'Track progress or stop it from Current downloads.',
        );
        uploadOverlayTimer = setTimeout(hideUploadOverlay, 900);
    } else {
        hideUploadOverlay();
    }

    const results = await Promise.allSettled(
        transfers.map(transfer => transfer.completion));
    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            failures.push(
                `${transfers[index].file.name}: ${result.reason.message || 'Upload failed'}`);
        }
    });
    if (failures.length) showActionError(failures.join(' '));
}

document.addEventListener('dragenter', event => {
    if (!isFileDrag(event) || uploadInProgress) return;
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
    event.dataTransfer.dropEffect = uploadInProgress ? 'none' : 'copy';
});

document.addEventListener('dragleave', event => {
    if (!isFileDrag(event) || uploadInProgress) return;
    uploadDragDepth = Math.max(0, uploadDragDepth - 1);
    if (uploadDragDepth === 0) hideUploadOverlay();
});

document.addEventListener('drop', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    uploadDragDepth = 0;
    if (uploadInProgress) return;
    const files = Array.from(event.dataTransfer.files || []);
    uploadDroppedVideos(files);
});

uploadDropOverlay.addEventListener('cancel', event => {
    event.preventDefault();
    if (!uploadInProgress) hideUploadOverlay();
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
            showServerStatus();
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
        closeNewDownload();
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
let searchTerms = [];
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

function matchesSearchFilter(info) {
    if (searchTerms.length === 0) return true;
    const title = tagSearchKey(info.title);
    const tags = new Set((Array.isArray(info.tags) ? info.tags : []).map(tagSearchKey));
    const userTerms = [];
    const contentTerms = [];
    searchTerms.forEach(term => {
        const key = tagSearchKey(term);
        if (key.startsWith('user:')) userTerms.push(key.slice('user:'.length).trim());
        else contentTerms.push(term);
    });

    if (userTerms.length) {
        const downloadedBy = tagSearchKey(info.downloaded_by);
        if (!userTerms.some(user => user && user === downloadedBy)) return false;
    }
    if (contentTerms.length === 0) return true;

    const matchesContent = term => {
        const key = tagSearchKey(term);
        return tags.has(key) || title.includes(key);
    };
    return contentTerms.some(matchesContent);
}

function setHistorySearchExpanded(expanded) {
    const search = document.getElementById('historySearch');
    const toggle = document.getElementById('historySearchToggle');
    search.classList.toggle('expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
}

function applyHistorySearch() {
    const input = document.getElementById('historySearchInput');
    document.getElementById('historySearchClear').hidden = !input.value;
    searchTerms = parseSearchTerms(input.value);
    historyPage = 0;
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
    const uploadRequest = activeUploadRequests.get(String(id));
    apiAction('/api/stop/' + encodeURIComponent(id), { method: 'POST' })
        .then(() => {
            if (uploadRequest) uploadRequest.abort();
            return fetchHistory();
        })
        .catch(() => fetchHistory());
}

const renameDrafts = new Map();

function renderRenameControl(id, basename, fullWidth = false) {
    if (renameDrafts.has(id)) {
        const draft = renameDrafts.get(id);
        const widthStyle = draft.width && !fullWidth ? `style="width:${draft.width}px"` : '';
        const widthClass = fullWidth ? ' rename-wrap-block' : '';
        return `<span class="rename-wrap${widthClass}" data-rename-id="${id}" data-mode="edit">
                    <input class="rename-input" type="text" ${widthStyle} value="${escapeAttr(draft.value)}" data-orig="${escapeAttr(basename)}" oninput="renameOnInput('${id}', this.value)" />
                    <button class="rename-btn confirm" type="button" title="Save" aria-label="Save" onclick="renameCommit('${id}')">
                        <svg class="icon"><use href="#i-check"/></svg>
                    </button>
                    <button class="rename-btn cancel" type="button" title="Cancel" aria-label="Cancel" onclick="renameCancel('${id}')">
                        <svg class="icon"><use href="#i-x"/></svg>
                    </button>
                </span>`;
    }
    const widthClass = fullWidth ? ' rename-wrap-block' : '';
    return `<span class="rename-wrap${widthClass}" data-rename-id="${id}" data-mode="display">
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
    closeHistoryInfo();
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

function toggleFavorite(button) {
    if (button.disabled) return;
    button.disabled = true;
    const id = button.dataset.downloadId;
    const favorite = button.dataset.favorite === 'true';
    apiAction('/api/favorite/' + encodeURIComponent(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite }),
    })
        .then(() => fetchHistory())
        .catch(() => {
            button.disabled = false;
            return fetchHistory();
        });
}

function changeDownloadVisibility(select) {
    if (select.disabled) return;
    const id = select.dataset.downloadId;
    const previous = select.dataset.current;
    const visibility = select.value;
    select.disabled = true;
    apiAction('/api/visibility/' + encodeURIComponent(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility }),
    })
        .then(() => {
            select.dataset.current = visibility;
            return fetchHistory();
        })
        .catch(() => {
            select.value = previous;
            select.disabled = false;
            return fetchHistory();
        });
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

const HOVER_PREVIEW_DELAY_MS = 500;
const HOVER_PREVIEW_CACHE_VERSION = 3;
let hoverPreviewTimer = null;
let pendingHoverPreview = null;
let activeHoverPreview = null;

function hoverPreviewsEnabled() {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function stopHoverPreview(preview = activeHoverPreview || pendingHoverPreview) {
    if (!preview) return;
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

function startHoverPreview(preview) {
    hoverPreviewTimer = null;
    pendingHoverPreview = null;
    const hoverRegion = preview.closest('.history-preview-wrap') || preview;
    if (!preview.isConnected || !hoverRegion.matches(':hover') || !hoverPreviewsEnabled()) return;

    if (activeHoverPreview && activeHoverPreview !== preview) {
        stopHoverPreview(activeHoverPreview);
    }
    const video = preview.querySelector('.history-preview-video');
    if (!video) return;

    activeHoverPreview = preview;
    preview.classList.add('preview-loading');
    video.muted = true;
    video.onplaying = () => {
        if (activeHoverPreview !== preview) return;
        preview.classList.remove('preview-loading');
        preview.classList.add('preview-playing');
    };
    video.onerror = () => {
        if (activeHoverPreview === preview) stopHoverPreview(preview);
    };
    video.src = '/api/preview/' + encodeURIComponent(preview.dataset.downloadId)
        + '?v=' + HOVER_PREVIEW_CACHE_VERSION;
    video.load();
    const playback = video.play();
    if (playback) {
        playback.catch(() => {
            if (activeHoverPreview === preview) stopHoverPreview(preview);
        });
    }
}

function scheduleHoverPreview(preview) {
    if (!hoverPreviewsEnabled() || preview.classList.contains('thumbnail-unavailable')) return;
    if (pendingHoverPreview && pendingHoverPreview !== preview) {
        stopHoverPreview(pendingHoverPreview);
    }
    if (activeHoverPreview === preview || pendingHoverPreview === preview) return;
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

    const playAction = ev.target.closest('[data-play-action]');
    if (playAction) {
        stopHoverPreview();
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
    if (ev.target.closest('.history-info-popover')) return;
    if (ev.target.closest('.kebab-menu') || ev.target.closest('.kebab-btn')) return;
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
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
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
        const base = info.filename.split('/').pop().split('\\').pop();
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
        menuItems.push(`<button data-file-download-action data-download-id="${escapeAttr(id)}"><svg class="menu-icon"><use href="#i-download"/></svg>Download</button>`);
    }
    if (!isFinished) {
        menuItems.push(`<button data-url-action="reload" data-download-id="${escapeAttr(id)}" ${urlData}><svg class="menu-icon"><use href="#i-sync"/></svg>Reload</button>`);
    }
    menuItems.push(`<button class="danger" onclick="deleteDownload('${id}')"><svg class="menu-icon"><use href="#i-trash"/></svg>Delete</button>`);

    const favorite = Boolean(info.favorite);
    const favoriteLabel = favorite ? 'Remove from favorites' : 'Add to favorites';
    const favoriteButton = `
                    <button class="favorite-toggle" type="button" data-favorite-action data-download-id="${escapeAttr(id)}" data-favorite="${favorite ? 'false' : 'true'}" aria-label="${favoriteLabel}" title="${favoriteLabel}" aria-pressed="${favorite}">
                        <svg aria-hidden="true"><use href="#i-star"/></svg>
                    </button>`;
    let preview;
    if (hasPlay) {
        const playLabel = info.filename.split('/').pop().split('\\').pop();
        const playExt = info.filename.split('.').pop().toLowerCase();
        preview = `
                <div class="history-preview-wrap">
                    <button class="history-preview" type="button" data-play-action data-download-id="${escapeAttr(id)}" data-play-label="${escapeAttr(playLabel)}" data-play-ext="${escapeAttr(playExt)}" aria-label="Play">
                        <span class="history-preview-fallback"><svg><use href="#i-camera"/></svg><span>No video preview</span></span>
                        <img src="/api/thumbnail/${encodeURIComponent(id)}" alt="" loading="lazy" onerror="this.closest('.history-preview').classList.add('thumbnail-unavailable')">
                        <video class="history-preview-video" muted playsinline loop preload="none" aria-hidden="true"></video>
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
    if (info.filename) {
        const base = info.filename.split('/').pop().split('\\').pop();
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
                                <div class="history-source-field"><span>Local upload</span></div>
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
    metadata.push(`<div class="history-owner-row"><strong>Downloaded by:</strong> <span>${escapeHtml(info.downloaded_by || 'Unknown user')}</span></div>`);
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

    const visibility = info.visibility === 'private' ? 'private' : 'public';
    const visibilityDisabled = info.can_manage_visibility
        ? ''
        : ' disabled title="Only the downloader or an administrator can change visibility"';
    const visibilityControl = `
                            <div class="history-info-section history-visibility-section">
                                <label class="history-info-label" for="visibility-${escapeAttr(id)}">Visibility</label>
                                <select id="visibility-${escapeAttr(id)}" data-visibility-select data-download-id="${escapeAttr(id)}" data-current="${visibility}" onchange="changeDownloadVisibility(this)"${visibilityDisabled}>
                                    <option value="public"${visibility === 'public' ? ' selected' : ''}>Public</option>
                                    <option value="private"${visibility === 'private' ? ' selected' : ''}>Private</option>
                                </select>
                                <div class="history-visibility-help">${visibility === 'public' ? 'Visible to all users' : 'Visible only to you and administrators'}</div>
                            </div>`;

    return `
                <article class="history-card" data-row-id="${escapeAttr(id)}">
                    ${preview}
                    <div class="history-card-caption">
                        <div class="history-card-title" title="${escapeAttr(displayTitle)}">${escapeHtml(displayTitle)}</div>
                        <div class="menu-wrap">
                            <button class="kebab-btn" onclick="toggleMenu('${id}', event)" aria-label="More actions"><svg class="icon"><use href="#i-kebab"/></svg></button>
                            <div id="menu-${escapeAttr(id)}" class="kebab-menu">${menuItems.join('')}</div>
                        </div>
                    </div>
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

    if (isRunning) {
        primary = `<button class="stop-btn icon-only" onclick="stopDownload('${id}')" aria-label="Stop" title="Stop">${renderActionProgressIcon('i-pause', info)}</button>`;
    } else if (isPaused) {
        primary = `<button class="continue-btn" onclick="unpauseDownload('${id}')">${renderActionProgressIcon('i-play', info)}Resume</button>`;
    } else if (!isUpload && (isCancelled || info.status === 'interrupted')) {
        primary = `<button class="continue-btn icon-only" data-url-action="continue" data-download-id="${id}" ${urlData} aria-label="Continue" title="Continue">${renderActionProgressIcon('i-play', info)}</button>`;
    }

    if (!isUpload) {
        menuItems.push(`<button data-url-action="open" ${urlData}><svg class="menu-icon"><use href="#i-external"/></svg>Open URL</button>`);
    }

    if (isRunning && !isUpload) {
        menuItems.push(`<button onclick="pauseDownload('${id}')"><svg class="menu-icon"><use href="#i-pause"/></svg>Pause</button>`);
    }

    if (isPaused) {
        menuItems.push(`<button onclick="stopDownload('${id}')"><svg class="menu-icon"><use href="#i-stop"/></svg>Stop</button>`);
    }

    if (isTerminal) {
        if (!isFinished && !isCancelled && info.status !== 'interrupted') {
            menuItems.push(`<button data-url-action="reload" data-download-id="${id}" ${urlData}><svg class="menu-icon"><use href="#i-sync"/></svg>Reload</button>`);
        }
        if (!isUpload) {
            menuItems.push(`<button data-url-action="copy" ${urlData}><svg class="menu-icon"><use href="#i-copy"/></svg>Copy URL</button>`);
        }
        menuItems.push(`<button class="danger" onclick="deleteDownload('${id}')"><svg class="menu-icon"><use href="#i-trash"/></svg>Delete</button>`);
    } else if (!isUpload) {
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

const DEFAULT_HISTORY_PAGE_SIZE = 10;
const HISTORY_PAGE_SIZES = new Set([5, 10, 20, 50]);
let historyPageSize = DEFAULT_HISTORY_PAGE_SIZE;
let historyPage = 0;
let historyTotal = 0;
let historyOrderIds = [];
let _renderedActiveIds  = new Set();
let _renderedHistoryIds = new Set();
const pendingActiveAnimations = new Set();
const pendingHistoryAnimations = new Set();

function animateInsertedItem(element, pendingAnimations, id) {
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
    const maxPage = Math.max(0, Math.ceil(historyTotal / historyPageSize) - 1);
    const next = Math.min(maxPage, Math.max(0, historyPage + delta));
    if (next === historyPage) return;
    historyPage = next;
    fetchHistory();
}

function goToPage(target) {
    const maxPage = Math.max(0, Math.ceil(historyTotal / historyPageSize) - 1);
    const next = Math.min(maxPage, Math.max(0, target));
    if (next === historyPage) return;
    historyPage = next;
    fetchHistory();
}

function fetchHistory({ sortFavorites = false } = {}) {
    if (historyRefreshBlocked()) {
        historyFetchDeferred = true;
        historyFavoriteSortDeferred ||= sortFavorites;
        return Promise.resolve();
    }

    return apiFetch('/api/history')
    .then(res => res.json())
    .then(data => {
        const itemCount = document.getElementById('itemCount');
        itemCount.textContent = `${data.length} ${data.length === 1 ? 'item' : 'items'}`;
        if (historyRefreshBlocked()) {
            historyFetchDeferred = true;
            return;
        }
        updateProgressIndicators(data);
        const active = data.filter(i => CURRENT_TAB_STATUSES.has(i.status));
        let historyEntries = data.filter(i => HISTORY_TAB_STATUSES.has(i.status));
        if (sortFavorites) {
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
        const done = historyEntries.filter(matchesSearchFilter);

        historyTotal = done.length;
        const maxPage = Math.max(0, Math.ceil(historyTotal / historyPageSize) - 1);
        if (historyPage > maxPage) historyPage = maxPage;
        const start = historyPage * historyPageSize;
        const pageItems = done.slice(start, start + historyPageSize);

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

        stopHoverPreview();
        document.getElementById('activeList').innerHTML  = active.map(i => renderItem(i, false)).join('');
        document.getElementById('historyList').innerHTML = pageItems.map(i => renderItem(i, true)).join('');

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

        const hasFilter = searchTerms.length > 0;
        document.getElementById('currentEmpty').textContent = 'No current downloads.';
        document.getElementById('historyEmptyTitle').textContent = hasFilter
            ? 'No matching downloads'
            : 'No downloads yet';
        document.getElementById('historyEmptyMessage').textContent = hasFilter
            ? 'No download history matches these search terms.'
            : 'Add a video URL or drop a local video here to get started.';
        document.getElementById('historyEmptyAction').hidden = hasFilter;
        document.getElementById('currentEmpty').style.display = active.length ? 'none' : '';
        document.getElementById('historyEmpty').style.display = done.length ? 'none' : '';

        const pager = document.getElementById('historyPager');
        if (historyTotal > historyPageSize) {
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
        if (active.length) {
            badge.textContent = active.length;
            badge.hidden = false;
        } else {
            badge.hidden = true;
        }
    });
}

let playerMode = 'overlay';
let startVideosFullscreen = false;

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

const PLAYER_CONTROLS_IDLE_MS = 2000;
let playerControlsTimer = null;

function hidePlayerControls() {
    clearTimeout(playerControlsTimer);
    playerControlsTimer = null;
    document.querySelector('.player-box').classList.remove('player-controls-visible');
}

function showPlayerControls() {
    const backdrop = document.getElementById('playerBackdrop');
    if (!backdrop.classList.contains('open')) return;
    const player = backdrop.querySelector('.player-box');
    player.classList.add('player-controls-visible');
    clearTimeout(playerControlsTimer);
    playerControlsTimer = setTimeout(hidePlayerControls, PLAYER_CONTROLS_IDLE_MS);
}

function playVideo(id, label, ext) {
    const url = '/api/file/' + encodeURIComponent(id);
    if (playerMode === 'new_tab') {
        window.open(url, '_blank', 'noopener');
        return;
    }
    const video = document.getElementById('playerVideo');
    hidePlayerControls();
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
    if (startVideosFullscreen) {
        try {
            if (video.requestFullscreen) {
                const request = video.requestFullscreen();
                if (request) request.catch(() => {});
            } else if (video.webkitEnterFullscreen) {
                video.webkitEnterFullscreen();
            }
        } catch (error) {
            // Full screen is a browser-controlled enhancement. Playback must
            // still open when policy or platform support rejects the request.
        }
    }
}

function closePlayer(ev) {
    const backdrop = document.getElementById('playerBackdrop');
    const video = document.getElementById('playerVideo');
    const closeButton = backdrop.querySelector('.player-close');
    hidePlayerControls();
    if (document.activeElement === closeButton) closeButton.blur();
    video.pause();
    video.removeAttribute('src');
    video.innerHTML = '';
    video.load();
    backdrop.classList.remove('open');
}

document.getElementById('playerBackdrop').addEventListener(
    'mousemove', showPlayerControls,
);

document.addEventListener('keydown', (ev) => {
    // Editors use Escape to cancel their own transient state. Respect that
    // before treating the same key as a request to close an enclosing layer.
    if (ev.defaultPrevented) return;
    if (ev.key === 'Escape' && document.getElementById('playerBackdrop').classList.contains('open')) {
        closePlayer();
    } else if (ev.key === 'Escape' && document.getElementById('newDownloadDialog').open) {
        ev.preventDefault();
        closeNewDownload();
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
        document.getElementById('newDownloadButton').setAttribute('aria-expanded', 'true');
    }
    urlInput.focus();
    urlInput.select();
}

function closeNewDownload() {
    const dialog = document.getElementById('newDownloadDialog');
    if (dialog.open) dialog.close();
}

const newDownloadDialog = document.getElementById('newDownloadDialog');
newDownloadDialog.addEventListener('close', () => {
    hideActionError();
    document.getElementById('newDownloadButton').setAttribute('aria-expanded', 'false');
    if (newDownloadReturnFocus && newDownloadReturnFocus.isConnected) {
        newDownloadReturnFocus.focus();
    }
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
    if (currentDrawerReturnFocus && currentDrawerReturnFocus.isConnected
            && !currentDrawerReturnFocus.hidden) {
        currentDrawerReturnFocus.focus();
    } else {
        document.getElementById('newDownloadButton').focus();
    }
    currentDrawerReturnFocus = null;
});
currentDownloadsDrawer.addEventListener('click', ev => {
    const bounds = currentDownloadsDrawer.getBoundingClientRect();
    const outside = ev.clientX < bounds.left || ev.clientX > bounds.right
        || ev.clientY < bounds.top || ev.clientY > bounds.bottom;
    if (outside) closeCurrentDownloads();
});

function openSettings() {
    const page = document.getElementById('settingsPage');
    closeAllMenus();
    if (!page.hidden) return;
    closeHistoryInfo();
    hideActionError();
    document.getElementById('tab-history').hidden = true;
    page.hidden = false;
    document.body.classList.add('settings-open');
    window.scrollTo({ top: 0 });
    loadPreferences();
    if (document.getElementById('userList')) loadUsers();
}

function closeSettings() {
    const page = document.getElementById('settingsPage');
    if (page.hidden) return;
    page.hidden = true;
    document.getElementById('tab-history').hidden = false;
    document.body.classList.remove('settings-open');
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
}

settingsNavButtons.forEach(button => {
    button.addEventListener('click', () => {
        settingsSearchInput.value = '';
        applySettingsSearch();
        const name = button.dataset.settingsSection;
        setActiveSettingsSection(name);
        document.getElementById(`settings-${name}`).scrollIntoView({
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 'auto' : 'smooth',
            block: 'start',
        });
    });
});

settingsSearchInput.addEventListener('input', applySettingsSearch);
settingsSearchInput.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !settingsSearchInput.value) return;
    event.stopPropagation();
    settingsSearchInput.value = '';
    applySettingsSearch();
});

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

function loadPreferences() {
    return apiFetch('/api/preferences').then(r => r.json()).then(p => {
        document.getElementById('prefDir').value = p.download_dir || '';
        document.getElementById('prefMax').value = p.max_concurrent || '';
        const configuredPageSize = Number(p.history_page_size);
        const nextPageSize = HISTORY_PAGE_SIZES.has(configuredPageSize)
            ? configuredPageSize
            : DEFAULT_HISTORY_PAGE_SIZE;
        document.getElementById('prefPageSize').value = String(nextPageSize);
        if (historyPageSize !== nextPageSize) {
            historyPageSize = nextPageSize;
            historyPage = 0;
            if (historyTotal > 0) fetchHistory();
        }

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
        startVideosFullscreen = p.start_fullscreen === 'true';
        document.getElementById('prefStartFullscreen').checked = startVideosFullscreen;
        refreshFullscreenAvailability();

        const theme = ['light', 'dark', 'system'].includes(p.theme) ? p.theme : 'system';
        document.getElementById('prefTheme').value = theme;
        applyTheme(theme);
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

function savePreferences() {
    const sel = document.getElementById('prefFormat');
    const fmt = sel.value === '__custom__'
        ? document.getElementById('prefFormatCustom').value.trim()
        : sel.value;

    const body = {
        download_dir: document.getElementById('prefDir').value,
        format: fmt || 'best',
        history_page_size: document.getElementById('prefPageSize').value,
        max_concurrent: document.getElementById('prefMax').value,
        player_mode: document.getElementById('prefPlayer').value,
        start_fullscreen: document.getElementById('prefStartFullscreen').checked
            ? 'true' : 'false',
        theme: document.getElementById('prefTheme').value,
    };
    apiAction('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(() => {
        const nextPageSize = Number(body.history_page_size);
        if (historyPageSize !== nextPageSize) {
            historyPageSize = nextPageSize;
            historyPage = 0;
            fetchHistory();
        }
        playerMode = body.player_mode;
        startVideosFullscreen = body.start_fullscreen === 'true';
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
let pendingFavoriteSort = false;
function scheduleFetch({ sortFavorites = false } = {}) {
    pendingFavoriteSort ||= sortFavorites;
    if (pendingFetch) return;
    pendingFetch = true;
    requestAnimationFrame(() => {
        pendingFetch = false;
        const applyFavoriteSort = pendingFavoriteSort;
        pendingFavoriteSort = false;
        fetchHistory({ sortFavorites: applyFavoriteSort });
    });
}

function connectEventStream() {
    const es = new EventSource('/api/events');
    es.addEventListener('ready', scheduleFetch);
    es.addEventListener('change', scheduleFetch);
    es.addEventListener('error', () => {
        showServerStatus();
    });
    return es;
}

connectEventStream();
// A fresh page has no visual order to preserve, so establish favorite-first
// ordering once. Later reconciliations keep that order until a filter runs.
fetchHistory({ sortFavorites: true });
