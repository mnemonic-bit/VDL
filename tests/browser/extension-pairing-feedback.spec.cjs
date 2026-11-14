const { test, expect } = require('@playwright/test');
const { reset, openSettings } = require('./support.cjs');

const create = page => page.locator('#extensionCreatePairing');
const dialog = page => page.locator('#extensionPairingDialog');
const secret = page => page.locator('#extensionPairingString');
const status = page => page.locator('#extensionStatus');
const operation = page => page.locator('#extensionPairingOperationStatus');
const copy = page => page.locator('#extensionCopyPairing');
const summary = page => page.locator('#extensionPairingSummary');
const invalidate = page => page.locator('#extensionPairingInvalidate');

async function ready(page, { legacy = false } = {}) {
    await page.route('**/api/events', route => route.abort());
    if (legacy) {
        await page.route('**/api/client-capabilities', async route => {
            const response = await route.fetch();
            const capabilities = await response.json();
            delete capabilities.extension_pairing;
            capabilities.actions = capabilities.actions.filter(action => !action.startsWith('pairing.'));
            await route.fulfill({ response, json: capabilities });
        });
    }
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(tagCapabilities))).toBe(true);
    await openSettings(page);
    await page.getByRole('button', { name: 'Browser Extension', exact: true }).click();
    await expect(create(page)).toBeEnabled();
}

async function gate(page, method, { committed = false } = {}) {
    const requests = [];
    const releases = [];
    let released = false;
    const endpoint = method === 'POST'
        ? /\/api\/extension\/pairing-codes$/
        : /\/api\/extension\/pairing-codes\/current$/;
    await page.route(endpoint, async route => {
        if (route.request().method() !== method) return route.continue();
        requests.push(route.request().postDataJSON());
        const response = committed ? await route.fetch() : null;
        if (!released) await new Promise(resolve => releases.push(resolve));
        if (response) await route.fulfill({ response }).catch(() => {});
        else await route.continue().catch(() => {});
    });
    return {
        requests,
        release: () => {
            released = true;
            releases.splice(0).forEach(release => release());
        },
    };
}

async function createConfirmed(page) {
    await create(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(secret(page)).toHaveValue(/^vdl-pair-v1:/);
    await expect(copy(page)).toBeEnabled();
    return secret(page).inputValue();
}

async function current(page) {
    const response = await page.request.get('/api/extension/pairing-codes/current');
    expect(response.ok()).toBe(true);
    return response.json();
}

async function missingReceipts(page) {
    await page.route('**/api/mutations/*', route => route.fulfill({
        status: 404, json: { error: 'Mutation unavailable', final: false },
    }));
}

async function assertNoStoredSecret(page, value) {
    expect(await page.evaluate(() => typeof VDL.extensionPairingMetrics)).toBe('function');
    const storage = await page.evaluate(() => JSON.stringify({
        local: { ...localStorage }, session: { ...sessionStorage },
        diagnostics: VDL.extensionPairingMetrics(),
        pairingSnapshot: extensionPairing.snapshot(),
        sharedIntents: tagMutations.pending(),
    }));
    expect(storage).not.toContain(value);
    expect(storage).not.toContain('vdl-pair-v1:');
}

test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(25_000);

for (const theme of ['light', 'dark']) {
    test(`${theme} creation feedback appears synchronously and confirms without SSE`, async ({ page }, testInfo) => {
        await ready(page);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(value => applyTheme(value), theme);
        const held = await gate(page, 'POST');
        try {
            const observed = await create(page).evaluate(element => {
                const started = performance.now();
                element.click();
                return {
                    elapsed: performance.now() - started,
                    feedback: document.getElementById('extensionPairingOperationStatus').textContent,
                };
            });
            expect(observed.elapsed).toBeLessThan(50);
            console.info('Pairing local feedback:', JSON.stringify({ local_feedback_ms: observed.elapsed, theme }));
            expect(observed.feedback).toContain('Creating pairing…');
            await testInfo.attach('pairing-local-feedback', {
                body: JSON.stringify({ local_feedback_ms: observed.elapsed, theme }),
                contentType: 'application/json',
            });
            await expect(dialog(page)).toBeVisible();
            await expect(operation(page)).toContainText('Creating pairing…');
            const repeatedAnnouncements = await page.evaluate(() => {
                const observer = new MutationObserver(() => {});
                for (const id of ['extensionPairingOperationStatus', 'extensionStatus']) {
                    observer.observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
                }
                renderExtensionPairing();
                renderExtensionPairing();
                renderExtensionPairing();
                const changes = observer.takeRecords().length;
                observer.disconnect();
                return changes;
            });
            expect(repeatedAnnouncements).toBe(0);
            await expect(secret(page)).toHaveValue('');
            await expect(copy(page)).toBeHidden();
            await expect(create(page)).toBeDisabled();
            await page.evaluate(() => {
                createExtensionPairing();
                invalidateExtensionPairing();
                createExtensionPairing();
            });
            await expect.poll(() => held.requests.length).toBe(1);
            await page.evaluate(() => loadExtensionConnections());
            await expect(create(page)).toBeDisabled();
            held.release();
            await expect(secret(page)).toHaveValue(/^vdl-pair-v1:/);
            await expect(copy(page)).toBeEnabled();
            await expect(copy(page)).toBeFocused();
            await expect(status(page)).toContainText('Pairing string created');
            expect(held.requests).toHaveLength(1);
            expect(held.requests[0].client_mutation_id).toBeTruthy();
            expect(held.requests[0].expected_revision).toMatch(/^\d+$/);
            expect((await current(page)).pairing.status).toBe('available');
            await assertNoStoredSecret(page, await secret(page).inputValue());
        } finally { held.release(); }
    });
}

test('invalidation retains confirmed status and disables copying before acknowledgement', async ({ page }) => {
    await ready(page);
    const value = await createConfirmed(page);
    const before = await current(page);
    const held = await gate(page, 'DELETE');
    try {
        await invalidate(page).click();
        await expect(operation(page)).toContainText('Invalidating pairing…');
        await expect(copy(page)).toBeDisabled();
        await expect(invalidate(page)).toBeDisabled();
        await expect(create(page)).toBeDisabled();
        await expect(secret(page)).toHaveValue(value);
        await expect(operation(page)).not.toContainText('invalidated');
        expect((await current(page)).pairing.status).toBe('available');
        await page.evaluate(() => {
            invalidateExtensionPairing();
            createExtensionPairing();
            copyExtensionPairing();
        });
        await expect.poll(() => held.requests.length).toBe(1);
        expect(held.requests[0].generation).toBe(before.pairing.generation);
        held.release();
        await expect(dialog(page)).toBeHidden();
        await expect(secret(page)).toHaveValue('');
        await expect(status(page)).toHaveText('Pairing string invalidated.');
        expect((await current(page)).pairing.status).toBe('invalidated');
        expect(held.requests).toHaveLength(1);
    } finally { held.release(); }
});

test('closing and reopening settings discards a held credential without stealing focus', async ({ page }) => {
    await ready(page);
    const held = await gate(page, 'POST', { committed: true });
    try {
        await create(page).click();
        await expect.poll(() => held.requests.length).toBe(1);
        await dialog(page).getByRole('button', { name: 'Close pairing dialog' }).click();
        await page.locator('#settingsBackButton').click();
        await expect(summary(page)).toContainText('Creating pairing');
        await openSettings(page);
        await page.getByRole('button', { name: 'Browser Extension', exact: true }).click();
        const focusTarget = page.locator('#extensionInstallLink');
        await focusTarget.focus();
        const received = page.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname === '/api/extension/pairing-codes');
        held.release();
        await received;
        await expect(status(page)).toContainText(/cannot be recovered|no longer available|not available/i);
        await expect(dialog(page)).toBeHidden();
        await expect(secret(page)).toHaveValue('');
        await expect(focusTarget).toBeFocused();
        expect((await current(page)).pairing.status).toBe('available');
        expect(held.requests).toHaveLength(1);
    } finally { held.release(); }
});

test('authentication reset clears an existing credential and fences a pending callback', async ({ page }) => {
    await ready(page);
    const value = await createConfirmed(page);
    await dialog(page).getByRole('button', { name: 'Close pairing dialog' }).click();
    await expect(secret(page)).toHaveValue('');
    await page.locator('#extensionInvalidatePairing').click();
    await expect(status(page)).toHaveText('Pairing string invalidated.');
    const held = await gate(page, 'POST', { committed: true });
    try {
        await create(page).click();
        await expect.poll(() => held.requests.length).toBe(1);
        await page.evaluate(() => resetTagSession());
        await expect(secret(page)).toHaveValue('');
        await expect(dialog(page)).toBeHidden();
        await expect(summary(page)).toBeHidden();
        const received = page.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname === '/api/extension/pairing-codes');
        held.release();
        await received;
        await expect(secret(page)).toHaveValue('');
        await expect(dialog(page)).toBeHidden();
        await expect(summary(page)).toBeHidden();
        await assertNoStoredSecret(page, value);
    } finally { held.release(); }
});

for (const failure of ['network loss', 'generic server error', 'malformed success']) {
    test(`${failure} keeps creation unknown without automatically issuing another credential`, async ({ page }) => {
        await ready(page);
        await missingReceipts(page);
        let writes = 0;
        await page.route(/\/api\/extension\/pairing-codes$/, route => {
            writes++;
            if (failure === 'network loss') return route.abort('failed');
            return route.fulfill({ status: failure === 'malformed success' ? 201 : 500, json: {} });
        });
        await create(page).click();
        await expect(operation(page)).toContainText('Pairing request not confirmed');
        await expect(secret(page)).toHaveValue('');
        await expect(copy(page)).toBeHidden();
        await expect(create(page)).toBeDisabled();
        await page.evaluate(() => { createExtensionPairing(); invalidateExtensionPairing(); });
        await expect(operation(page)).toContainText('Pairing request not confirmed');
        expect(writes).toBe(1);
        await dialog(page).getByRole('button', { name: 'Close pairing dialog' }).click();
        await page.locator('#settingsBackButton').click();
        await expect(summary(page)).toContainText('Pairing request not confirmed');
    });
}

test('lost creation response recovers only status and requires separate invalidation then creation', async ({ page }) => {
    await ready(page);
    let writes = 0;
    let lost;
    let recoveryReads = 0;
    await page.route(/\/api\/extension\/pairing-codes$/, async route => {
        writes++;
        const response = await route.fetch();
        lost = await response.json();
        await route.abort('failed');
    });
    await page.route('**/api/mutations/*', async route => {
        recoveryReads++;
        const response = await route.fetch();
        const body = await response.json();
        expect(body).not.toHaveProperty('code');
        expect(JSON.stringify(body)).not.toContain(lost.code);
        await route.fulfill({ response });
    });
    await create(page).click();
    await expect(operation(page)).toContainText(/cannot be recovered|not available/i);
    await expect(secret(page)).toHaveValue('');
    expect(writes).toBe(1);
    expect(recoveryReads).toBeGreaterThan(0);
    expect((await current(page)).pairing.generation).toBe(lost.created_generation);
    await assertNoStoredSecret(page, lost.code);
    await invalidate(page).click();
    await expect(dialog(page)).toBeHidden();
    await expect(status(page)).toHaveText('Pairing string invalidated.');
    expect((await current(page)).pairing.status).toBe('invalidated');
    expect(writes).toBe(1);
    await page.unroute(/\/api\/extension\/pairing-codes$/);
    await createConfirmed(page);
    expect((await current(page)).pairing.generation).not.toBe(lost.created_generation);
});

test('unknown invalidation does not claim revocation or permit copying', async ({ page }) => {
    await ready(page);
    await createConfirmed(page);
    await missingReceipts(page);
    let writes = 0;
    await page.route(/\/api\/extension\/pairing-codes\/current$/, route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        writes++;
        return route.abort('failed');
    });
    await invalidate(page).click();
    await expect(operation(page)).toContainText(/invalidation.*not confirmed|not confirmed.*invalidation/i);
    await expect(operation(page)).not.toHaveText('Pairing string invalidated.');
    await expect(copy(page)).toBeDisabled();
    await expect(create(page)).toBeDisabled();
    expect((await current(page)).pairing.status).toBe('available');
    await page.evaluate(() => { createExtensionPairing(); invalidateExtensionPairing(); });
    expect(writes).toBe(1);
});

test('held creation explains the delay after five seconds and remains a single request', async ({ page }) => {
    await ready(page);
    await page.clock.install();
    const held = await gate(page, 'POST');
    try {
        await create(page).click();
        await expect.poll(() => held.requests.length).toBe(1);
        await page.clock.fastForward(5100);
        await expect(operation(page)).toContainText(/longer|still|waiting/i);
        expect(held.requests).toHaveLength(1);
        held.release();
        await expect(secret(page)).toHaveValue(/^vdl-pair-v1:/);
    } finally { held.release(); }
});

test('legacy servers show pending and unknown feedback without receipt reads or replay', async ({ page }) => {
    await ready(page, { legacy: true });
    let reads = 0;
    let writes = 0;
    let release;
    page.on('request', request => { if (/\/api\/mutations\//.test(request.url())) reads++; });
    await page.route(/\/api\/extension\/pairing-codes$/, async route => {
        writes++;
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 503, json: {} });
    });
    try {
        await create(page).click();
        await expect(operation(page)).toContainText('Creating pairing…');
        await expect.poll(() => Boolean(release)).toBe(true);
        release();
        await expect(operation(page)).toContainText('Pairing request not confirmed');
        await expect(summary(page).locator('[data-pairing-recovery="replay"]')).toBeHidden();
        await page.evaluate(() => createExtensionPairing());
        expect(writes).toBe(1);
        expect(reads).toBe(0);
    } finally { release?.(); }
});

for (const close of ['Done', 'Escape', 'native cancel', 'settings close', 'section change']) {
    test(`${close} clears the presented credential from the DOM`, async ({ page }) => {
        await ready(page);
        const value = await createConfirmed(page);
        if (close === 'Done') await dialog(page).getByRole('button', { name: 'Done', exact: true }).click();
        else if (close === 'Escape') await page.keyboard.press('Escape');
        else if (close === 'native cancel') await dialog(page).evaluate(element => {
            if (typeof element.requestClose === 'function') element.requestClose();
            else {
                const event = new Event('cancel', { cancelable: true });
                if (element.dispatchEvent(event)) element.close();
            }
        });
        else if (close === 'settings close') await page.evaluate(() => closeSettings());
        else await page.evaluate(() => document.querySelector('[data-settings-section="general"]').click());
        await expect(dialog(page)).toBeHidden();
        await expect(secret(page)).toHaveValue('');
        await expect(copy(page)).toBeHidden();
        expect((await current(page)).pairing.status).toBe('available');
        await assertNoStoredSecret(page, value);
    });
}

for (const outcome of ['resolved', 'rejected']) {
    test(`a ${outcome} clipboard promise from a closed view cannot change a new view`, async ({ page }) => {
        await ready(page);
        await createConfirmed(page);
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
                writeText: () => new Promise((resolve, reject) => {
                    window.__pairingClipboardResolve = resolve;
                    window.__pairingClipboardReject = reject;
                }),
            } });
            copyExtensionPairing();
        });
        await expect.poll(() => page.evaluate(() => typeof window.__pairingClipboardResolve)).toBe('function');
        await dialog(page).getByRole('button', { name: 'Done', exact: true }).click();
        await page.locator('#extensionInvalidatePairing').click();
        await expect(status(page)).toHaveText('Pairing string invalidated.');
        await createConfirmed(page);
        await dialog(page).locator('#extensionPairingDetails summary').focus();
        await page.evaluate(value => {
            if (value === 'resolved') window.__pairingClipboardResolve();
            else window.__pairingClipboardReject(new Error('Clipboard rejected'));
        }, outcome);
        await expect(copy(page)).toHaveText('Copy pairing string');
        await expect(page.locator('#extensionPairingFeedback')).not.toContainText(/Copied|blocked/);
        await expect(dialog(page).locator('#extensionPairingDetails summary')).toBeFocused();
        expect(await page.locator('#extensionPairingDetails').evaluate(element => element.open)).toBe(false);
    });
}

test('an invalidation held across remote replacement cannot revoke the new generation', async ({ page }) => {
    await ready(page);
    await createConfirmed(page);
    const first = await current(page);
    const held = await gate(page, 'DELETE');
    try {
        await invalidate(page).click();
        await expect(operation(page)).toContainText('Invalidating pairing…');
        await expect.poll(() => held.requests.length).toBe(1);
        const replacement = await page.request.post('/api/extension/pairing-codes');
        expect(replacement.ok()).toBe(true);
        const next = await current(page);
        expect(next.pairing.generation).not.toBe(first.pairing.generation);
        held.release();
        await expect(operation(page)).toContainText(/changed|review/i);
        await expect(secret(page)).toHaveValue('');
        expect((await current(page)).pairing.generation).toBe(next.pairing.generation);
        expect((await current(page)).pairing.status).toBe('available');
        expect(held.requests).toHaveLength(1);
    } finally { held.release(); }
});

test('a definite creation rejection explains the next action without fabricating a credential', async ({ page }) => {
    await ready(page);
    const canonical = await current(page);
    let writes = 0;
    await page.route(/\/api\/extension\/pairing-codes$/, async route => {
        writes++;
        const body = route.request().postDataJSON();
        await route.fulfill({ status: 422, json: {
            pairing: canonical.pairing,
            mutation: {
                id: body.client_mutation_id, domain: 'extension-pairing',
                revision: canonical.pairing.revision, outcome: 'rejected',
            },
            error: 'Review the pairing configuration before trying again.',
        } });
    });
    await create(page).click();
    await expect(operation(page)).toContainText(/refused|rejected/i);
    await expect(operation(page)).toContainText('Review the pairing configuration');
    await expect(secret(page)).toHaveValue('');
    await expect(copy(page)).toBeHidden();
    expect(writes).toBe(1);
    expect((await current(page)).pairing.generation).toBe(canonical.pairing.generation);
});

test('keyboard activation announces creation and copying through live status', async ({ page }) => {
    await ready(page);
    await create(page).focus();
    await page.keyboard.press('Enter');
    await expect(secret(page)).toHaveValue(/^vdl-pair-v1:/);
    await expect(copy(page)).toBeFocused();
    await expect(operation(page)).toHaveAttribute('role', 'status');
    await expect(operation(page)).toHaveAttribute('aria-live', 'polite');
    await page.keyboard.press('Space');
    await expect(copy(page)).toHaveText('Copied');
    await expect(page.locator('#extensionPairingFeedback')).toHaveText('Copied. Continue in VDL Companion.');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(secret(page)).toHaveValue('');
});

test('submitting the logout form clears the credential before logout transport completes', async ({ page }) => {
    await ready(page);
    const value = await createConfirmed(page);
    let release;
    let requests = 0;
    await page.route('**/logout', async route => {
        requests++;
        await new Promise(resolve => { release = resolve; });
        await route.continue();
    });
    try {
        const immediate = await page.evaluate(() => {
            document.querySelector('form.logout-form').requestSubmit();
            return {
                credential: document.getElementById('extensionPairingString').value,
                dialogOpen: document.getElementById('extensionPairingDialog').open,
                hasPending: extensionPairing.hasPending(),
                diagnosticsAvailable: typeof VDL.extensionPairingMetrics === 'function',
                snapshots: JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage },
                    diagnostics: VDL.extensionPairingMetrics(), pairing: extensionPairing.snapshot(),
                    sharedIntents: tagMutations.pending() }),
            };
        });
        expect(immediate).toMatchObject({ credential: '', dialogOpen: false, hasPending: false, diagnosticsAvailable: true });
        expect(immediate.snapshots).not.toContain(value);
        expect(immediate.snapshots).not.toContain('vdl-pair-v1:');
        await expect.poll(() => requests).toBe(1);
        release();
        await expect(page).toHaveURL(/\/login$/);
        await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    } finally { release?.(); }
});

test('a late original creation response cannot replace the recovered newer generation', async ({ page }) => {
    await ready(page);
    await page.clock.install();
    await page.evaluate(() => {
        const originalFetch = apiFetch;
        window.__pairingDecodedCreations = 0;
        apiFetch = async (...args) => {
            const response = await originalFetch(...args);
            if (args[0] === '/api/extension/pairing-codes' && args[1]?.method === 'POST') {
                const decode = response.json.bind(response);
                response.json = async () => {
                    try { return await decode(); }
                    finally { window.__pairingDecodedCreations++; }
                };
            }
            return response;
        };
    });
    let writes = 0;
    let committed = false;
    let release;
    await page.route(/\/api\/extension\/pairing-codes$/, async route => {
        writes++;
        if (writes !== 1) return route.continue();
        const response = await route.fetch();
        committed = true;
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ response });
    });
    try {
        await create(page).click();
        await expect.poll(() => committed).toBe(true);
        await page.clock.fastForward(30_100);
        await expect(operation(page)).toContainText(/cannot be recovered/);
        await invalidate(page).click();
        await expect(dialog(page)).toBeHidden();
        await createConfirmed(page);
        const newerSecret = await secret(page).inputValue();
        const newer = await current(page);
        await dialog(page).locator('#extensionPairingDetails summary').focus();
        release();
        await expect.poll(() => page.evaluate(() => window.__pairingDecodedCreations)).toBe(2);
        await expect(secret(page)).toHaveValue(newerSecret);
        expect(await page.evaluate(() => extensionPairing.snapshot().recoveryGeneration)).toBe(newer.pairing.generation);
        await expect(dialog(page).locator('#extensionPairingDetails summary')).toBeFocused();
        let invalidatedGeneration;
        await page.route(/\/api\/extension\/pairing-codes\/current$/, route => {
            if (route.request().method() === 'DELETE') invalidatedGeneration = route.request().postDataJSON().generation;
            return route.continue();
        });
        await invalidate(page).click();
        await expect(status(page)).toHaveText('Pairing string invalidated.');
        expect(invalidatedGeneration).toBe(newer.pairing.generation);
        expect((await current(page)).pairing.status).toBe('invalidated');
        expect(writes).toBe(2);
    } finally { release?.(); }
});

test('resolving unknown creation against newer available status still requires invalidation', async ({ page }) => {
    await ready(page);
    await missingReceipts(page);
    let writes = 0;
    await page.route(/\/api\/extension\/pairing-codes$/, route => {
        writes++;
        return route.abort('failed');
    });
    await create(page).click();
    await expect(operation(page)).toContainText('Pairing request not confirmed');
    const replacement = await page.request.post('/api/extension/pairing-codes');
    expect(replacement.ok()).toBe(true);
    const newer = await current(page);
    await page.evaluate(() => recoverExtensionPairing('check'));
    await expect(operation(page)).toContainText('Pairing request not confirmed');
    await page.evaluate(() => recoverExtensionPairing('resolve'));
    await expect(operation(page)).toContainText(/cannot be recovered|invalidate/i);
    await expect(create(page)).toBeDisabled();
    await expect(secret(page)).toHaveValue('');
    await expect(invalidate(page)).toBeEnabled();
    await page.evaluate(() => createExtensionPairing());
    expect(writes).toBe(1);
    expect((await current(page)).pairing.generation).toBe(newer.pairing.generation);
    await invalidate(page).click();
    await expect(status(page)).toHaveText('Pairing string invalidated.');
    await expect(create(page)).toBeEnabled();
    expect(writes).toBe(1);
});
