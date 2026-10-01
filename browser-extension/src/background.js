const PROTOCOL = 1;
const VERSION = browser.runtime.getManifest().version;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 65536;

function normalizeVdlOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
            (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
        throw new Error('VDL must use a trusted HTTPS origin without a path.');
    }
    return url.origin;
}

function permissionPattern(url) {
    return `${url.protocol}//${url.hostname}/*`;
}

async function fetchJson(origin, path, options = {}) {
    const expected = normalizeVdlOrigin(origin);
    const target = new URL(path, expected);
    if (target.origin !== expected || !path.startsWith('/api/extension/')) {
        throw new Error('The VDL destination changed unexpectedly.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(target.href, {
            ...options,
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            signal: controller.signal,
            headers: {
                'X-VDL-Companion-Protocol': String(PROTOCOL),
                'X-VDL-Companion-Version': VERSION,
                ...(options.headers || {}),
            },
        });
        const declaredLength = Number(response.headers.get('Content-Length'));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
            throw new Error('VDL returned an unexpectedly large response.');
        }
        const reader = response.body && response.body.getReader
            ? response.body.getReader() : null;
        let text = '';
        if (reader) {
            const decoder = new TextDecoder();
            let size = 0;
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_RESPONSE_BYTES) {
                    await reader.cancel();
                    throw new Error('VDL returned an unexpectedly large response.');
                }
                text += decoder.decode(value, {stream: true});
            }
            text += decoder.decode();
        } else {
            text = await response.text();
            if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
                throw new Error('VDL returned an unexpectedly large response.');
            }
        }
        let data = {};
        if (text) {
            try { data = JSON.parse(text); } catch (_) {
                throw new Error('VDL returned an invalid response.');
            }
        }
        if (!response.ok) {
            const error = new Error(data.error || `VDL returned ${response.status}.`);
            error.status = response.status;
            error.code = data.code;
            throw error;
        }
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

async function connection() {
    const state = await browser.storage.local.get('connection');
    return state.connection || null;
}

async function setBadge(text, title, color = '#1f8a3b', clearAfter = 0) {
    await Promise.all([
        browser.action.setBadgeText({text}),
        browser.action.setBadgeBackgroundColor({color}),
        browser.action.setTitle({title}),
    ]);
    if (clearAfter) {
        setTimeout(() => {
            browser.action.setBadgeText({text: ''});
            browser.action.setTitle({title: 'Download current page with VDL'});
        }, clearAfter);
    }
}

async function recordError(message, guidance) {
    await browser.storage.local.set({lastError: {message, guidance, at: Date.now()}});
    await setBadge('!', message, '#b42318');
    await browser.runtime.openOptionsPage();
}

function requestId() {
    return crypto.randomUUID();
}

function canonicalPageUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Open a normal HTTP or HTTPS video page first.');
    }
    url.hash = '';
    if (new TextEncoder().encode(url.href).length > 8192) {
        throw new Error('This page URL is too long to send safely.');
    }
    return url;
}

function eligibleCookie(cookie) {
    const partitioned = cookie.partitionKey && Object.keys(cookie.partitionKey).length;
    const unexpired = cookie.session || !Number.isFinite(cookie.expirationDate) ||
        cookie.expirationDate > Date.now() / 1000;
    return !partitioned && !cookie.firstPartyDomain && unexpired;
}

function projectCookie(cookie) {
    return {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        host_only: cookie.hostOnly,
        path: cookie.path,
        secure: cookie.secure,
        http_only: cookie.httpOnly,
        expires: cookie.session || !Number.isFinite(cookie.expirationDate)
            ? null : Math.trunc(cookie.expirationDate),
    };
}

async function submitCurrentTab(tab) {
    const paired = await connection();
    if (!paired) {
        await browser.tabs.create({url: browser.runtime.getURL('onboarding.html')});
        return;
    }
    await setBadge('…', 'Checking this page for VDL', '#667085');
    if (!tab || tab.incognito) {
        throw new Error('Private tabs are not supported.');
    }
    const page = canonicalPageUrl(tab.url);
    if (page.origin === paired.origin) {
        throw new Error('Open the signed-in video page, not VDL itself.');
    }
    const pattern = permissionPattern(page);
    if (!await browser.permissions.contains({origins: [pattern]}) &&
            !await browser.permissions.request({origins: [pattern]})) {
        throw new Error('Firefox site access was not granted.');
    }
    await setBadge('…', 'Sending this page to VDL', '#667085');
    let cookies = [];
    try {
        const found = await browser.cookies.getAll({
            url: page.href,
            storeId: tab.cookieStoreId,
            partitionKey: {},
            firstPartyDomain: null,
        });
        const unsupported = found.some(cookie => !eligibleCookie(cookie));
        cookies = found.filter(eligibleCookie).map(projectCookie);
        if (!cookies.length && unsupported) {
            throw new Error('This sign-in uses partitioned or First-Party Isolation cookies, which VDL Companion does not support yet.');
        }
        const id = requestId();
        const body = JSON.stringify({
            schema: 1,
            request_id: id,
            page_url: page.href,
            captured_at: Math.trunc(Date.now() / 1000),
            cookies,
        });
        let result;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                result = await fetchJson(paired.origin, '/api/extension/downloads', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${paired.token}`,
                        'Content-Type': 'application/json',
                    },
                    body,
                });
                break;
            } catch (error) {
                if (attempt || (!error.name || error.name !== 'AbortError') && error.status) throw error;
            }
        }
        await browser.storage.local.set({
            connection: {...paired, lastSuccessfulContact: Date.now(), unusable: false},
            lastError: null,
        });
        await setBadge('✓', `${result.action.replace('_', ' ')} in VDL`, '#1f8a3b', 3000);
    } finally {
        cookies = [];
    }
}

async function pair(message) {
    const existing = await connection();
    const origin = normalizeVdlOrigin(message.origin);
    if (existing && existing.origin !== origin) {
        throw new Error('Unpair the current VDL before pairing another one.');
    }
    const pattern = permissionPattern(new URL(origin));
    if (!await browser.permissions.request({origins: [pattern]})) {
        throw new Error('Firefox access to this VDL was not granted.');
    }
    const result = await fetchJson(origin, '/api/extension/pair', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            code: message.code,
            device_label: message.deviceLabel,
            extension_version: VERSION,
            protocol_version: PROTOCOL,
        }),
    });
    await browser.storage.local.set({
        connection: {
            origin,
            token: result.token,
            connectionId: result.connection_id,
            username: result.user.username,
            deviceLabel: message.deviceLabel,
            extensionVersion: VERSION,
            pairedAt: Date.now(),
            lastSuccessfulContact: Date.now(),
            unusable: false,
        },
        lastError: null,
    });
    return {origin, username: result.user.username};
}

async function unpair() {
    const paired = await connection();
    try {
        if (paired) {
            await fetchJson(paired.origin, '/api/extension/token', {
                method: 'DELETE',
                headers: {'Authorization': `Bearer ${paired.token}`},
            });
        }
    } finally {
        await browser.storage.local.remove(['connection', 'lastError']);
    }
}

async function testConnection() {
    const paired = await connection();
    if (!paired) throw new Error('Pair this Firefox profile with VDL first.');
    const result = await fetchJson(paired.origin, '/api/extension/status', {
        headers: {'Authorization': `Bearer ${paired.token}`},
    });
    await browser.storage.local.set({
        connection: {...paired, lastSuccessfulContact: Date.now(), unusable: false},
        lastError: null,
    });
    return result;
}

browser.runtime.onInstalled.addListener(details => {
    if (details.reason === 'install') {
        browser.tabs.create({url: browser.runtime.getURL('onboarding.html')});
    }
});

browser.runtime.onMessage.addListener(message => {
    if (message.type === 'pair') return pair(message);
    if (message.type === 'unpair') return unpair();
    if (message.type === 'status') return connection();
    if (message.type === 'test') return testConnection();
    return undefined;
});

browser.action.onClicked.addListener(tab => {
    submitCurrentTab(tab).catch(async error => {
        const paired = await connection();
        if (error.status === 401 && paired) {
            await browser.storage.local.set({connection: {...paired, unusable: true}});
            await recordError(error.message, 'Re-pair this Firefox profile with VDL.');
        } else if (error.status === 426) {
            await recordError(error.message, 'Install the newer companion from VDL Settings.');
        } else {
            await recordError(error.message, 'Open VDL Companion options for help.');
        }
    });
});
