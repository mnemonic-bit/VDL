const { test, expect } = require('@playwright/test');
const { reset, openSettings, switchAccount } = require('./support.cjs');

const companionHeaders = {
    Origin: 'moz-extension://01234567-89ab-cdef-0123-456789abcdef',
    'X-VDL-Companion-Protocol': '1',
    'X-VDL-Companion-Version': '1.0.3',
};
const row = (page, id) => page.locator(`.extension-connection[data-connection-id="${id}"]`);
const revoke = (page, id) => row(page, id).locator('.extension-revoke-button');
const feedback = (page, id) => row(page, id).locator('.extension-connection-status');
const recovery = (page, id, action) => row(page, id).locator(`[data-connection-recovery="${action}"]`);
const status = page => page.locator('#extensionConnectionStatus');
const pairedTokens = [];

async function connections(page) {
    const response = await page.request.get('/api/extension/connections');
    expect(response.ok()).toBe(true);
    return response.json();
}

async function pair(page, deviceLabel = 'Firefox revocation test') {
    const origin = new URL(page.url()).origin;
    const codeResponse = await page.request.post('/api/extension/pairing-codes');
    expect(codeResponse.ok()).toBe(true);
    const { code } = await codeResponse.json();
    const response = await page.request.post('/api/extension/pair', {
        headers: companionHeaders,
        data: { code, origin, device_label: deviceLabel, extension_version: '1.0.3', protocol_version: 1 },
    });
    expect(response.status()).toBe(201);
    const connection = await response.json();
    pairedTokens.push(connection.token);
    return connection;
}

async function tokenStatus(page, token) {
    return page.request.get('/api/extension/status', {
        headers: { ...companionHeaders, Authorization: `Bearer ${token}` },
    });
}

async function ready(page, { legacy = false } = {}) {
    await page.route('**/api/events', route => route.abort());
    if (legacy) await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch();
        const body = await response.json();
        delete body.extension_connection_revocation;
        body.actions = body.actions.filter(action => action !== 'connection.revoke');
        await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(tagCapabilities))).toBe(true);
    await openSettings(page);
    await page.getByRole('button', { name: 'Browser Extension', exact: true }).click();
    await expect(page.locator('#extensionCreatePairing')).toBeEnabled();
    await page.evaluate(() => { window.confirm = () => true; });
}

async function show(page, ...paired) {
    await page.evaluate(() => loadExtensionConnections());
    for (const connection of paired) await expect(row(page, connection.connection_id)).toBeVisible();
}

async function gate(page, id, { committed = false } = {}) {
    const requests = [];
    const releases = [];
    let released = false;
    let delivered = 0;
    await page.route(`**/api/extension/connections/${id}`, async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        requests.push(route.request().postDataJSON());
        const response = committed ? await route.fetch() : null;
        if (!released) await new Promise(resolve => releases.push(resolve));
        if (response) await route.fulfill({ response }).catch(() => {});
        else await route.continue().catch(() => {});
        delivered++;
    });
    return {
        requests,
        delivered: () => delivered,
        release() { released = true; releases.splice(0).forEach(resolve => resolve()); },
    };
}

async function missingReceipts(page, { final = false } = {}) {
    await page.route('**/api/mutations/*', route => route.fulfill({
        status: 404, json: { error: 'Mutation unavailable', final, server_time: Date.now() },
    }));
}

async function assertNoSecret(page, ...secrets) {
    const snapshot = await page.evaluate(() => JSON.stringify({
        local: { ...localStorage }, session: { ...sessionStorage },
        metrics: VDL.extensionConnectionMetrics(),
        connections: extensionConnections.snapshot(), mutations: tagMutations.pending(),
    }));
    for (const secret of secrets) expect(snapshot).not.toContain(secret);
    expect(snapshot).not.toContain('vdl-pair-v1:');
}

test.beforeEach(async ({ page }) => {
    pairedTokens.length = 0;
    await reset(page);
    // The shared fixture retains companion credentials between page resets.
    for (const connection of (await connections(page)).connections) {
        expect((await page.request.delete(`/api/extension/connections/${connection.id}`)).status()).toBe(204);
    }
});
test.afterEach(async ({ request }) => {
    // Self-unpair also cleans credentials created before an account switch.
    for (const token of pairedTokens) {
        const response = await request.delete('/api/extension/token', {
            headers: { ...companionHeaders, Authorization: `Bearer ${token}` },
        });
        expect([204, 401]).toContain(response.status());
    }
    pairedTokens.length = 0;
});
test.setTimeout(25_000);

for (const theme of ['light', 'dark']) {
    test(`${theme} immediate revocation retains confirmed row and confirms without SSE or collection reads`, async ({ page }, testInfo) => {
        await ready(page);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(value => applyTheme(value), theme);
        const first = await pair(page);
        const second = await pair(page, 'Independent Firefox');
        await show(page, first, second);
        const id = first.connection_id;
        await row(page, id).evaluate(element => { element.__retainedIdentity = 'first-row'; });
        const held = await gate(page, id);
        let reads = 0;
        await page.route(/\/api\/extension\/connections$/, route => {
            reads++;
            return route.fulfill({ status: 503, json: { error: 'Collection unavailable' } });
        });
        try {
            const observed = await revoke(page, id).evaluate(element => {
                const started = performance.now();
                element.click();
                return { elapsed: performance.now() - started,
                    feedback: element.closest('article').querySelector('.extension-connection-status').textContent };
            });
            expect(observed.elapsed).toBeLessThan(50);
            expect(observed.feedback).toContain('Revoking connection…');
            console.info('Revocation local feedback:', JSON.stringify({ theme, local_feedback_ms: observed.elapsed }));
            await testInfo.attach('revocation-local-feedback', {
                body: JSON.stringify({ theme, local_feedback_ms: observed.elapsed }), contentType: 'application/json',
            });
            await expect(feedback(page, id)).toContainText('Revoking connection…');
            await expect(row(page, id)).toContainText('Last confirmed status: connected.');
            expect(await row(page, id).evaluate(element => element.__retainedIdentity)).toBe('first-row');
            await expect(revoke(page, id)).toBeDisabled();
            await expect(revoke(page, second.connection_id)).toBeEnabled();
            expect((await tokenStatus(page, first.token)).status()).toBe(200);
            await page.evaluate(connectionId => {
                revokeExtensionConnection(connectionId);
                revokeExtensionConnection(connectionId);
            }, id);
            await expect.poll(() => held.requests.length).toBe(1);
            expect(held.requests[0]).toMatchObject({ expected_revision: '0' });
            expect(held.requests[0].generation).toMatch(/^[a-f0-9]{32}$/);
            expect(held.requests[0].client_mutation_id).toBeTruthy();
            await assertNoSecret(page, first.token, second.token);
            held.release();
            await expect(row(page, id)).toHaveCount(0);
            await expect(status(page)).toContainText('Companion connection revoked.');
            await expect(status(page)).toContainText('Already accepted downloads');
            await expect(row(page, second.connection_id)).toBeVisible();
            expect((await tokenStatus(page, first.token)).status()).toBe(401);
            expect((await tokenStatus(page, second.token)).status()).toBe(200);
            expect(reads).toBe(0);
            expect(held.requests).toHaveLength(1);
        } finally { held.release(); }
    });
}

test('confirmation names the connection and cancellation sends no revocation', async ({ page }) => {
    await ready(page);
    const connection = await pair(page, 'Firefox to keep');
    await show(page, connection);
    let writes = 0;
    page.on('request', request => {
        if (request.method() === 'DELETE' && request.url().endsWith(connection.connection_id)) writes++;
    });
    const question = await revoke(page, connection.connection_id).evaluate(element => {
        let message;
        window.confirm = value => { message = value; return false; };
        element.click();
        return message;
    });
    expect(question).toContain('Firefox to keep');
    expect(writes).toBe(0);
    await expect(revoke(page, connection.connection_id)).toBeEnabled();
    expect((await tokenStatus(page, connection.token)).status()).toBe(200);
});

test('independent connections can revoke concurrently without applying an acknowledgement to another row', async ({ page }) => {
    await ready(page);
    const first = await pair(page, 'First Firefox');
    const second = await pair(page, 'Second Firefox');
    await show(page, first, second);
    const a = await gate(page, first.connection_id);
    const b = await gate(page, second.connection_id);
    try {
        await revoke(page, first.connection_id).click();
        await revoke(page, second.connection_id).click();
        await expect.poll(() => a.requests.length + b.requests.length).toBe(2);
        b.release();
        await expect(row(page, second.connection_id)).toHaveCount(0);
        await expect(feedback(page, first.connection_id)).toContainText('Revoking connection…');
        expect((await tokenStatus(page, first.token)).status()).toBe(200);
        a.release();
        await expect(row(page, first.connection_id)).toHaveCount(0);
        expect(a.requests[0].client_mutation_id).not.toBe(b.requests[0].client_mutation_id);
    } finally { a.release(); b.release(); }
});

test('an older collection response cannot restore a confirmed removed connection or erase its replacement', async ({ page }) => {
    await ready(page);
    const first = await pair(page, 'Original Firefox');
    await show(page, first);
    let release;
    let captured = false;
    await page.route(/\/api\/extension\/connections$/, async route => {
        const response = await route.fetch();
        captured = true;
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ response });
    });
    try {
        await page.evaluate(() => { window.__oldConnectionRead = loadExtensionConnections(); });
        await expect.poll(() => captured).toBe(true);
        await revoke(page, first.connection_id).click();
        await expect(row(page, first.connection_id)).toHaveCount(0);
        const replacement = await pair(page, 'Original Firefox');
        release();
        await page.evaluate(() => window.__oldConnectionRead);
        await expect(row(page, first.connection_id)).toHaveCount(0);
        await page.unroute(/\/api\/extension\/connections$/);
        await show(page, replacement);
        await expect(revoke(page, replacement.connection_id)).toBeEnabled();
        expect((await tokenStatus(page, replacement.token)).status()).toBe(200);
    } finally { release?.(); }
});

test('a missing collection row does not confirm a held request', async ({ page }) => {
    await ready(page);
    const connection = await pair(page);
    await show(page, connection);
    const held = await gate(page, connection.connection_id, { committed: true });
    try {
        await revoke(page, connection.connection_id).click();
        await expect.poll(() => held.requests.length).toBe(1);
        await expect.poll(async () => (await connections(page)).connections.length).toBe(0);
        await page.evaluate(() => loadExtensionConnections());
        await expect(row(page, connection.connection_id)).toBeVisible();
        await expect(feedback(page, connection.connection_id)).toContainText('Revoking connection…');
        await expect(status(page)).not.toContainText('Companion connection revoked.');
        held.release();
        await expect(row(page, connection.connection_id)).toHaveCount(0);
    } finally { held.release(); }
});

for (const close of ['settings close', 'section change']) {
    test(`${close} preserves pending recovery without reopening or stealing focus`, async ({ page }) => {
        await ready(page);
        const connection = await pair(page);
        await show(page, connection);
        const held = await gate(page, connection.connection_id);
        try {
            await revoke(page, connection.connection_id).click();
            await expect.poll(() => held.requests.length).toBe(1);
            if (close === 'settings close') await page.locator('#settingsBackButton').click();
            else await page.locator('[data-settings-section="general"]').click();
            await expect(page.locator('#extensionConnectionSummary')).toContainText('Revoking connection');
            const focusTarget = close === 'settings close' ? page.locator('#accountMenuButton') : page.locator('#settingsSearchInput');
            await focusTarget.focus();
            if (close === 'section change') await expect(page.locator('[data-settings-section="general"]')).toHaveAttribute('aria-current', 'page');
            held.release();
            await expect.poll(() => held.delivered()).toBe(1);
            if (close === 'settings close') await expect(page.locator('#settingsPage')).toBeHidden();
            else await expect(page.locator('[data-settings-section="general"]')).toHaveAttribute('aria-current', 'page');
            await expect(focusTarget).toBeFocused();
            await openSettings(page);
            await page.getByRole('button', { name: 'Browser Extension', exact: true }).click();
            await expect(row(page, connection.connection_id)).toHaveCount(0);
        } finally { held.release(); }
    });
}

for (const failure of ['network loss', 'generic server error', 'malformed success']) {
    test(`${failure} retains unknown revocation and never repeats the destructive request automatically`, async ({ page }) => {
        await ready(page);
        const connection = await pair(page);
        await show(page, connection);
        await missingReceipts(page);
        let writes = 0;
        await page.route(`**/api/extension/connections/${connection.connection_id}`, route => {
            if (route.request().method() !== 'DELETE') return route.continue();
            writes++;
            if (failure === 'network loss') return route.abort('failed');
            return route.fulfill({ status: failure === 'malformed success' ? 200 : 500, json: {} });
        });
        await revoke(page, connection.connection_id).click();
        await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
        await expect(recovery(page, connection.connection_id, 'check')).toBeVisible();
        await expect(revoke(page, connection.connection_id)).toBeDisabled();
        await page.evaluate(id => revokeExtensionConnection(id), connection.connection_id);
        await page.evaluate(() => loadExtensionConnections());
        await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
        expect(writes).toBe(1);
        expect((await tokenStatus(page, connection.token)).status()).toBe(200);
    });
}

test('a lost committed response recovers its minimal receipt without exposing credentials', async ({ page }) => {
    await ready(page);
    const connection = await pair(page);
    await show(page, connection);
    let writes = 0;
    let attempt;
    let result;
    let checks = 0;
    await page.route(`**/api/extension/connections/${connection.connection_id}`, async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        writes++;
        attempt = route.request().postDataJSON();
        const response = await route.fetch();
        result = await response.json();
        await route.abort('failed');
    });
    await page.route('**/api/mutations/*', async route => {
        checks++;
        const response = await route.fetch();
        const body = await response.json();
        expect(body.connection).toEqual(result.connection);
        expect(JSON.stringify(body)).not.toContain(connection.token);
        expect(JSON.stringify(body)).not.toContain('Firefox revocation test');
        await route.fulfill({ response });
    });
    await revoke(page, connection.connection_id).click();
    await expect(row(page, connection.connection_id)).toHaveCount(0);
    await expect(status(page)).toContainText('Companion connection revoked.');
    expect(checks).toBe(1);
    expect(writes).toBe(1);
    const receipt = await (await page.request.get(`/api/mutations/${attempt.client_mutation_id}`)).json();
    expect(receipt.connection).toMatchObject({ id: connection.connection_id, status: 'revoked' });
    expect((await tokenStatus(page, connection.token)).status()).toBe(401);
    await assertNoSecret(page, connection.token);
});

test('deliberate recovery repeats the immutable attempt and does not revoke a replacement connection', async ({ page }) => {
    await ready(page);
    const connection = await pair(page, 'Replaceable Firefox');
    await show(page, connection);
    await missingReceipts(page);
    const attempts = [];
    await page.route(`**/api/extension/connections/${connection.connection_id}`, async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        attempts.push(route.request().postDataJSON());
        const response = await route.fetch();
        if (attempts.length === 1) await route.abort('failed');
        else await route.fulfill({ response });
    });
    await revoke(page, connection.connection_id).click();
    await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
    const replacement = await pair(page, 'Replaceable Firefox');
    await show(page, replacement);
    await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
    await recovery(page, connection.connection_id, 'replay').click();
    await expect(row(page, connection.connection_id)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(revoke(page, replacement.connection_id)).toBeEnabled();
    expect((await tokenStatus(page, replacement.token)).status()).toBe(200);
    await assertNoSecret(page, connection.token, replacement.token);
});

test('a definite rejection retains connected state and presents its error', async ({ page }) => {
    await ready(page);
    const connection = await pair(page);
    await show(page, connection);
    const canonical = (await connections(page)).connections.find(item => item.id === connection.connection_id);
    await page.route(`**/api/extension/connections/${connection.connection_id}`, route => {
        const attempt = route.request().postDataJSON();
        return route.fulfill({ status: 422, json: {
            connection: { id: canonical.id, generation: canonical.generation, revision: canonical.revision, status: 'connected' },
            mutation: { id: attempt.client_mutation_id, domain: 'extension-connection', revision: canonical.revision, outcome: 'rejected' },
            error: 'Review the connection before trying again.',
        } });
    });
    await revoke(page, connection.connection_id).click();
    await expect(feedback(page, connection.connection_id)).toContainText(/refused|rejected/i);
    await expect(feedback(page, connection.connection_id)).toContainText('Review the connection');
    await expect(row(page, connection.connection_id)).toContainText('Last confirmed status: connected.');
    expect((await tokenStatus(page, connection.token)).status()).toBe(200);
});

test('legacy revocation shows pending feedback and confirms its 204 without receipt lookup', async ({ page }) => {
    await ready(page, { legacy: true });
    const connection = await pair(page);
    await show(page, connection);
    const held = await gate(page, connection.connection_id);
    let reads = 0;
    page.on('request', request => { if (/\/api\/mutations\//.test(request.url())) reads++; });
    try {
        await revoke(page, connection.connection_id).click();
        await expect(feedback(page, connection.connection_id)).toContainText('Revoking connection…');
        await expect.poll(() => held.requests.length).toBe(1);
        held.release();
        await expect(row(page, connection.connection_id)).toHaveCount(0);
        expect(reads).toBe(0);
        expect(held.requests[0]).toBeNull();
        expect((await tokenStatus(page, connection.token)).status()).toBe(401);
    } finally { held.release(); }
});

test('legacy unknown revocation offers checking without automatic or deliberate mutation replay', async ({ page }) => {
    await ready(page, { legacy: true });
    const connection = await pair(page);
    await show(page, connection);
    let writes = 0;
    let reads = 0;
    page.on('request', request => { if (/\/api\/mutations\//.test(request.url())) reads++; });
    await page.route(`**/api/extension/connections/${connection.connection_id}`, route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        writes++;
        return route.abort('failed');
    });
    await revoke(page, connection.connection_id).click();
    await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
    await expect(recovery(page, connection.connection_id, 'check')).toBeVisible();
    await expect(recovery(page, connection.connection_id, 'replay')).toBeHidden();
    await recovery(page, connection.connection_id, 'check').click();
    await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
    expect(writes).toBe(1);
    expect(reads).toBe(0);
});

test('authentication reset clears connection identities and fences an old acknowledgement', async ({ page }) => {
    await ready(page);
    const connection = await pair(page, 'Private connection identity');
    await show(page, connection);
    const held = await gate(page, connection.connection_id, { committed: true });
    try {
        await revoke(page, connection.connection_id).click();
        await expect.poll(() => held.requests.length).toBe(1);
        await page.evaluate(() => resetTagSession());
        await expect(row(page, connection.connection_id)).toHaveCount(0);
        const cleared = await page.evaluate(() => JSON.stringify(extensionConnections.snapshot()));
        expect(cleared).not.toContain(connection.connection_id);
        expect(cleared).not.toContain('Private connection identity');
        held.release();
        await expect.poll(() => held.delivered()).toBe(1);
        await expect(row(page, connection.connection_id)).toHaveCount(0);
        await expect(status(page)).not.toContainText('Companion connection revoked.');
        expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    } finally { held.release(); }
});

test('actual account switching does not restore the former connection or pending request', async ({ page }) => {
    await ready(page);
    expect((await page.request.post('/api/users', { data: {
        username: 'revocation-next-account', name: 'Revocation Next', password: 'next-password', role: 'normal',
    } })).ok()).toBe(true);
    const connection = await pair(page, 'Former private Firefox');
    await show(page, connection);
    const held = await gate(page, connection.connection_id, { committed: true });
    try {
        await revoke(page, connection.connection_id).click();
        await expect.poll(() => held.requests.length).toBe(1);
        await page.locator('#settingsBackButton').click();
        await switchAccount(page, 'revocation-next-account', 'next-password');
        held.release();
        await expect.poll(() => held.delivered()).toBe(1);
        await openSettings(page);
        await page.getByRole('button', { name: 'Browser Extension', exact: true }).click();
        await expect(row(page, connection.connection_id)).toHaveCount(0);
        await expect(page.locator('#extensionConnectionList')).not.toContainText('Former private Firefox');
        expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    } finally { held.release(); }
});

test('keyboard revocation announces status and keeps the narrow layout within its row', async ({ page }) => {
    await ready(page);
    const connection = await pair(page, '<img src=x onerror=alert(1)> Firefox');
    await show(page, connection);
    await page.setViewportSize({ width: 375, height: 700 });
    const held = await gate(page, connection.connection_id);
    try {
        await revoke(page, connection.connection_id).focus();
        await page.keyboard.press('Enter');
        await expect(feedback(page, connection.connection_id)).toContainText('Revoking connection…');
        await expect(page.locator('#extensionConnectionAnnouncement')).toHaveAttribute('role', 'status');
        await expect(page.locator('#extensionConnectionAnnouncement')).toHaveAttribute('aria-live', 'polite');
        await expect(page.locator('#extensionConnectionAnnouncement')).toContainText('Revoking connection…');
        await expect(row(page, connection.connection_id).locator('img')).toHaveCount(0);
        expect(await row(page, connection.connection_id).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        held.release();
        await expect(row(page, connection.connection_id)).toHaveCount(0);
    } finally { held.release(); }
});

test('revocation leaves an already accepted companion download under its existing worker lifecycle', async ({ page }) => {
    await ready(page);
    const connection = await pair(page);
    await show(page, connection);
    expect((await page.request.post('/__test__/hold-downloads')).ok()).toBe(true);
    try {
        const accepted = await page.request.post('/api/extension/downloads', {
            headers: { ...companionHeaders, Authorization: `Bearer ${connection.token}` },
            data: { schema: 1, request_id: '1243cafe-6ae1-44cc-bdcc-eeeeeeeeeeee',
                page_url: 'https://video.example/watch/accepted-before-revocation',
                captured_at: Math.floor(Date.now() / 1000), cookies: [] },
        });
        expect(accepted.status()).toBe(201);
        const { id } = await accepted.json();
        await revoke(page, connection.connection_id).click();
        await expect(row(page, connection.connection_id)).toHaveCount(0);
        expect((await tokenStatus(page, connection.token)).status()).toBe(401);
        const response = await page.request.get('/api/history');
        expect(response.ok()).toBe(true);
        const attempt = (await response.json()).items.find(item => item.download_id === id);
        expect(attempt).toBeTruthy();
        expect(['starting', 'downloading', 'finished']).toContain(attempt.status);
    } finally { await page.request.post('/__test__/release-downloads'); }
});

test('held revocation explains delay after five seconds without claiming failure or sending again', async ({ page }) => {
    await ready(page);
    const connection = await pair(page);
    await show(page, connection);
    await page.clock.install();
    const held = await gate(page, connection.connection_id);
    try {
        await revoke(page, connection.connection_id).click();
        await expect.poll(() => held.requests.length).toBe(1);
        await page.clock.fastForward(5100);
        await expect(feedback(page, connection.connection_id)).toContainText(/longer|still|waiting/i);
        await expect(row(page, connection.connection_id)).toContainText('Last confirmed status: connected.');
        expect(held.requests).toHaveLength(1);
        expect((await tokenStatus(page, connection.token)).status()).toBe(200);
        held.release();
        await expect(row(page, connection.connection_id)).toHaveCount(0);
    } finally { held.release(); }
});

test('repeated rendering does not mutate live announcements or submit another request', async ({ page }) => {
    await ready(page);
    const connection = await pair(page);
    await show(page, connection);
    const held = await gate(page, connection.connection_id);
    try {
        await revoke(page, connection.connection_id).click();
        await expect.poll(() => held.requests.length).toBe(1);
        const count = await page.evaluate(id => {
            const observer = new MutationObserver(() => {});
            for (const element of document.querySelectorAll('.extension-connection-status, #extensionConnectionStatus, #extensionConnectionSummary, #extensionConnectionAnnouncement')) {
                observer.observe(element, { childList: true, characterData: true, subtree: true });
            }
            renderExtensionConnections(); renderExtensionConnections(); renderExtensionConnections();
            const records = observer.takeRecords().length;
            observer.disconnect();
            return records;
        }, connection.connection_id);
        expect(count).toBe(0);
        expect(held.requests).toHaveLength(1);
    } finally { held.release(); }
});

test('actual session invalidation rejects a held revocation and purges private presentation', async ({ page, request }) => {
    await ready(page);
    expect((await page.request.post('/api/users', { data: {
        username: 'revocation-session-admin', name: 'Session Administrator', password: 'backup-password', role: 'admin',
    } })).ok()).toBe(true);
    const connection = await pair(page, 'Session-private Firefox');
    await show(page, connection);
    const held = await gate(page, connection.connection_id);
    try {
        await revoke(page, connection.connection_id).click();
        await expect.poll(() => held.requests.length).toBe(1);
        expect((await request.post('/login', { form: { username: 'revocation-session-admin', password: 'backup-password' } })).ok()).toBe(true);
        const users = (await (await request.get('/api/users')).json()).users;
        const admin = users.find(user => user.username === 'admin');
        expect((await request.patch(`/api/users/${admin.id}`, { data: { password: 'browser-test-password' } })).ok()).toBe(true);
        held.release();
        await expect(page).toHaveURL(/\/login$/);
        await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
        const denied = await page.request.get('/api/extension/connections');
        expect(denied.status()).toBe(401);
    } finally { held.release(); }
});

for (const stateRead of ['authorized', 'failed']) {
    test(`expired missing receipt with ${stateRead} state read never invents revocation or repeats the DELETE`, async ({ page }) => {
        await ready(page);
        const connection = await pair(page);
        await show(page, connection);
        await missingReceipts(page);
        let writes = 0;
        let reads = 0;
        await page.route(`**/api/extension/connections/${connection.connection_id}`, route => {
            if (route.request().method() === 'DELETE') {
                writes++;
                return route.abort('failed');
            }
            reads++;
            return stateRead === 'failed' ? route.fulfill({ status: 503, json: {} }) : route.continue();
        });
        await revoke(page, connection.connection_id).click();
        await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
        await page.clock.install();
        await page.clock.fastForward(86_400_100);
        await page.unroute('**/api/mutations/*');
        await missingReceipts(page, { final: true });
        await recovery(page, connection.connection_id, 'check').click();
        await expect.poll(() => reads).toBeGreaterThan(0);
        await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
        await expect(row(page, connection.connection_id)).toContainText('Last confirmed status: connected.');
        if (stateRead === 'authorized') {
            await expect(recovery(page, connection.connection_id, 'resolve')).toBeVisible();
            await recovery(page, connection.connection_id, 'resolve').click();
            await expect(revoke(page, connection.connection_id)).toBeEnabled();
            await expect(status(page)).not.toContainText('Companion connection revoked.');
        } else {
            await expect(recovery(page, connection.connection_id, 'resolve')).toBeHidden();
            await expect(revoke(page, connection.connection_id)).toBeDisabled();
        }
        expect(writes).toBe(1);
        expect((await tokenStatus(page, connection.token)).status()).toBe(200);
    });
}

test('a late original acknowledgement cannot revoke a new connection after receipt recovery', async ({ page }) => {
    await ready(page);
    const connection = await pair(page, 'Reconnected Firefox');
    await show(page, connection);
    await page.clock.install();
    const held = await gate(page, connection.connection_id, { committed: true });
    try {
        await revoke(page, connection.connection_id).click();
        await expect.poll(async () => (await tokenStatus(page, connection.token)).status()).toBe(401);
        await page.clock.fastForward(30_100);
        await expect(row(page, connection.connection_id)).toHaveCount(0);
        await expect(status(page)).toContainText('Companion connection revoked.');
        const replacement = await pair(page, 'Reconnected Firefox');
        await show(page, replacement);
        await page.locator('#extensionInstallLink').focus();
        held.release();
        await expect.poll(() => held.delivered()).toBe(1);
        await expect(row(page, connection.connection_id)).toHaveCount(0);
        await expect(revoke(page, replacement.connection_id)).toBeEnabled();
        await expect(page.locator('#extensionInstallLink')).toBeFocused();
        expect((await tokenStatus(page, replacement.token)).status()).toBe(200);
        expect(await page.evaluate(() => VDL.extensionConnectionMetrics().acknowledgements)).toBe(1);
    } finally { held.release(); }
});

test('reload fetches authorized state without restoring or replaying the unknown revocation', async ({ page }) => {
    await ready(page);
    const connection = await pair(page);
    await show(page, connection);
    await missingReceipts(page);
    let writes = 0;
    await page.route(`**/api/extension/connections/${connection.connection_id}`, route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        writes++;
        return route.abort('failed');
    });
    await revoke(page, connection.connection_id).click();
    await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
    await assertNoSecret(page, connection.token);
    await ready(page);
    await show(page, connection);
    await expect(revoke(page, connection.connection_id)).toBeEnabled();
    await expect(feedback(page, connection.connection_id)).toBeEmpty();
    expect(await page.evaluate(() => extensionConnections.hasPending())).toBe(false);
    expect(writes).toBe(1);
    expect((await tokenStatus(page, connection.token)).status()).toBe(200);
});

test('expired missing receipt and absent target require explicit status resolution without claiming this attempt revoked it', async ({ page }) => {
    await ready(page);
    const connection = await pair(page);
    await show(page, connection);
    await missingReceipts(page);
    let writes = 0;
    await page.route(`**/api/extension/connections/${connection.connection_id}`, route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        writes++;
        return route.abort('failed');
    });
    await revoke(page, connection.connection_id).click();
    await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
    expect((await page.request.delete(`/api/extension/connections/${connection.connection_id}`)).status()).toBe(204);
    await page.clock.install();
    await page.clock.fastForward(86_400_100);
    await page.unroute('**/api/mutations/*');
    await missingReceipts(page, { final: true });
    await recovery(page, connection.connection_id, 'check').click();
    await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
    await expect(row(page, connection.connection_id)).toBeVisible();
    await expect(status(page)).not.toContainText('Companion connection revoked.');
    await expect(recovery(page, connection.connection_id, 'resolve')).toBeVisible();
    await recovery(page, connection.connection_id, 'resolve').click();
    await expect(row(page, connection.connection_id)).toHaveCount(0);
    await expect(status(page)).toContainText(/not confirm|not confirmed/i);
    await expect(status(page)).not.toContainText('Companion connection revoked.');
    expect(writes).toBe(1);
});

test('a newer authorized present list prevents an older absence check from removing a live connection on resolution', async ({ page }) => {
    await ready(page);
    const connection = await pair(page);
    await show(page, connection);
    await missingReceipts(page);
    let writes = 0;
    await page.route(`**/api/extension/connections/${connection.connection_id}`, route => {
        if (route.request().method() === 'DELETE') {
            writes++;
            return route.abort('failed');
        }
        return route.fulfill({ status: 404, json: { error: 'Unknown companion connection' } });
    });
    await revoke(page, connection.connection_id).click();
    await expect(feedback(page, connection.connection_id)).toContainText('Revocation not confirmed');
    await page.clock.install();
    await page.clock.fastForward(86_400_100);
    await page.unroute('**/api/mutations/*');
    await missingReceipts(page, { final: true });
    await recovery(page, connection.connection_id, 'check').click();
    await expect(recovery(page, connection.connection_id, 'resolve')).toBeVisible();
    await page.evaluate(() => loadExtensionConnections());
    await expect(row(page, connection.connection_id)).toBeVisible();
    await recovery(page, connection.connection_id, 'resolve').click();
    await expect(row(page, connection.connection_id)).toBeVisible();
    await expect(revoke(page, connection.connection_id)).toBeEnabled();
    await expect(status(page)).not.toContainText('Companion connection revoked.');
    expect((await tokenStatus(page, connection.token)).status()).toBe(200);
    expect(writes).toBe(1);
});
