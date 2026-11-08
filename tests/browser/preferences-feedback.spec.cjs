const { test, expect } = require('@playwright/test');
const { reset, openSettings, switchAccount } = require('./support.cjs');

const status = page => page.locator('#preferenceSaveStatus');
async function ready(page) {
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await openSettings(page);
    await expect.poll(() => page.evaluate(() => hasPreferenceProtocol())).toBe(true);
}
function saveGate(page, { committed = false } = {}) {
    const requests = [];
    const releases = [];
    const installed = page.route('**/api/preferences', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        requests.push(route.request().postDataJSON());
        const response = committed ? await route.fetch() : null;
        await new Promise(resolve => releases.push(resolve));
        if (response) await route.fulfill({ response });
        else await route.continue();
    });
    return { installed, requests, releases };
}
async function release(gate) {
    await expect.poll(() => gate.releases.length).toBeGreaterThan(0);
    gate.releases.shift()();
}

test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(20_000);

test('saving feedback appears within 50ms and canonical acknowledgement needs no SSE or collection read', async ({ page }) => {
    await ready(page);
    await page.locator('#prefMax').fill('0004');
    const gate = saveGate(page);
    await gate.installed;
    let reads = 0;
    page.on('request', request => {
        if (/\/api\/(library|history|current-downloads)(\?|$)/.test(request.url())) reads++;
    });
    await page.locator('#saveBtn').evaluate(button => {
        button.addEventListener('click', () => { window.preferenceStarted = performance.now(); }, true);
        window.addEventListener('click', () => {
            window.preferenceFeedbackMs = performance.now() - window.preferenceStarted;
            window.preferenceFeedbackText = document.getElementById('preferenceSaveStatus').textContent;
        }, { once: true });
    });
    await page.locator('#saveBtn').click();
    await expect(status(page)).toContainText('Saving settings');
    expect(await page.evaluate(() => window.preferenceFeedbackText)).toContain('Saving settings');
    expect(await page.evaluate(() => window.preferenceFeedbackMs)).toBeLessThan(50);
    await expect(page.locator('#prefMax')).toBeEnabled();
    await expect.poll(() => gate.requests.length).toBe(1);
    await release(gate);
    await expect(status(page)).toHaveText('Settings saved.');
    await expect(page.locator('#prefMax')).toHaveValue('4');
    expect(reads).toBe(0);
    const metrics = await page.evaluate(() => VDL.preferenceMutationMetrics());
    expect(metrics.acknowledgements).toBe(1);
    expect(metrics.latestLocalFeedbackMs).toBeLessThan(50);
});

test('newer editable drafts retain focus, theme preview, and unsaved status after an older save', async ({ page }) => {
    await ready(page);
    const originalPlayer = await page.evaluate(() => playerMode);
    await page.locator('#prefPlayer').selectOption('new_tab');
    await page.locator('#prefTheme').selectOption('dark');
    const gate = saveGate(page); await gate.installed;
    await page.locator('#saveBtn').click();
    expect(await page.evaluate(() => playerMode)).toBe(originalPlayer);
    await page.locator('#prefMax').fill('7');
    await page.locator('#prefTheme').selectOption('light');
    await page.locator('#prefMax').focus();
    await release(gate);
    await expect(status(page)).toContainText('Newer edits remain unsaved');
    await expect(page.locator('#prefMax')).toHaveValue('7');
    await expect(page.locator('#prefMax')).toBeFocused();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => playerMode)).toBe('new_tab');
    await expect(page.locator('#saveBtn')).toBeEnabled();
});

test('duplicate Save submits once and closed Settings retains a recovery summary', async ({ page }) => {
    await ready(page);
    await page.locator('#prefMax').fill('8');
    const gate = saveGate(page); await gate.installed;
    await page.evaluate(() => { savePreferences(); savePreferences(); });
    await expect.poll(() => gate.requests.length).toBe(1);
    await page.locator('#settingsBackButton').click();
    await expect(page.locator('#preferenceMutationSummary')).toBeVisible();
    await expect(page.locator('#preferenceMutationSummary')).toContainText('Saving settings');
    await page.locator('#preferenceMutationSummary button').click();
    await expect(page.locator('#prefMax')).toHaveValue('8');
    await page.locator('#prefMax').fill('9');
    await release(gate);
    await expect(status(page)).toContainText('Newer edits remain unsaved');
    await expect(page.locator('#prefMax')).toHaveValue('9');
});

test('old reads cannot replace newer drafts or regress an acknowledged revision', async ({ page }) => {
    await ready(page);
    let releaseRead; let captured;
    await page.route('**/api/preferences', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        captured = await route.fetch();
        await new Promise(resolve => { releaseRead = resolve; });
        await route.fulfill({ response: captured });
    });
    await page.evaluate(() => { window.oldPreferenceRead = loadPreferences(); });
    await expect.poll(() => !!releaseRead).toBe(true);
    await page.locator('#prefMax').fill('11');
    await page.locator('#saveBtn').click();
    await expect(status(page)).toHaveText('Settings saved.');
    const revision = await page.evaluate(() => tagState.selectPreferences().preferences_revision);
    releaseRead();
    await page.evaluate(() => window.oldPreferenceRead);
    await expect(page.locator('#prefMax')).toHaveValue('11');
    expect(await page.evaluate(() => tagState.selectPreferences().preferences_revision)).toBe(revision);
});

test('a definite validation rejection identifies the field and retains editable values', async ({ page }) => {
    await ready(page);
    await page.locator('#prefDir').fill('/dev/null/cannot-create');
    await page.locator('#prefTheme').selectOption('dark');
    await page.locator('#saveBtn').click();
    await expect(status(page)).not.toContainText('Saving settings');
    await expect(page.locator('#prefDir')).toHaveValue('/dev/null/cannot-create');
    await expect(page.locator('#prefDir')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#prefDirSaveError')).toBeVisible();
    await expect(page.locator('#saveBtn')).toBeEnabled();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(status(page)).not.toHaveText('Settings saved.');
});

test('generic server errors remain unknown and block another save without applying sensitive settings', async ({ page }) => {
    await ready(page);
    const before = await page.evaluate(() => playerMode);
    await page.route('**/api/preferences', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"temporary failure"}' })
        : route.continue());
    await page.locator('#prefPlayer').selectOption('new_tab');
    await page.locator('#saveBtn').click();
    await expect(status(page)).toContainText('Save not confirmed');
    await expect(page.locator('#saveBtn')).toBeDisabled();
    await expect(page.locator('#prefPlayer')).toBeEnabled();
    expect(await page.evaluate(() => playerMode)).toBe(before);
    await expect(page.locator('#preferenceCheck')).toBeVisible();
});

test('lost acknowledgement replays the same immutable attempt once while newer drafts survive', async ({ page }) => {
    await ready(page);
    const attempts = [];
    let first = true;
    await page.route('**/api/mutations/**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Mutation unavailable","final":false}' }));
    await page.route('**/api/preferences', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        attempts.push(route.request().postDataJSON());
        if (first) {
            first = false;
            await route.fetch();
            return route.abort();
        }
        return route.continue();
    });
    await page.locator('#prefMax').fill('6');
    await page.locator('#saveBtn').click();
    await expect(status(page)).toContainText('Save not confirmed');
    await page.locator('#prefMax').fill('12');
    const revision = (await (await page.request.get('/api/preferences')).json()).preferences_revision;
    await page.locator('#preferenceReplay').click();
    await expect(status(page)).toContainText('Newer edits remain unsaved');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(page.locator('#prefMax')).toHaveValue('12');
    expect((await (await page.request.get('/api/preferences')).json()).preferences_revision).toBe(revision);
});

test('conflicts require explicit review and preserve the newer draft for a new attempt', async ({ page }) => {
    await ready(page);
    await page.locator('#prefMax').fill('6');
    const gate = saveGate(page); await gate.installed;
    await page.locator('#saveBtn').click();
    await expect.poll(() => gate.requests.length).toBe(1);
    await page.request.post('/api/preferences', { data: { max_concurrent: '10' } });
    await release(gate);
    await expect(status(page)).toContainText('Settings changed elsewhere');
    await expect(page.locator('#prefMax')).toHaveValue('6');
    await expect(page.locator('#preferenceResubmit')).toBeHidden();
    await page.locator('#preferenceReview').click();
    await expect(page.locator('#preferenceCurrentValues')).toContainText('max concurrent: 10');
    await page.locator('#prefMax').fill('13');
    await page.locator('#preferenceResubmit').click();
    await expect.poll(() => gate.requests.length).toBe(2);
    expect(gate.requests[1].client_mutation_id).not.toBe(gate.requests[0].client_mutation_id);
    await release(gate);
    await expect(status(page)).toHaveText('Settings saved.');
    await expect(page.locator('#prefMax')).toHaveValue('13');
});

test('after five seconds waiting has explanatory text without declaring success', async ({ page }) => {
    await ready(page); await page.clock.install();
    await page.locator('#prefMax').fill('5');
    const gate = saveGate(page); await gate.installed;
    await page.locator('#saveBtn').click();
    await page.clock.fastForward(5100);
    await expect(status(page)).toContainText('Still waiting for settings confirmation');
    await expect(page.locator('#saveBtn')).toBeDisabled();
    await release(gate);
    await expect(status(page)).toHaveText('Settings saved.');
});

test('authentication reset clears drafts and fences late save and load callbacks', async ({ page }) => {
    await ready(page);
    await page.locator('#prefDir').fill('/tmp/private-unsaved-directory');
    const gate = saveGate(page); await gate.installed;
    await page.locator('#saveBtn').click();
    await expect.poll(() => gate.requests.length).toBe(1);
    await page.evaluate(() => resetTagSession());
    await expect(page.locator('#prefDir')).toHaveValue('');
    await release(gate);
    await expect(status(page)).toHaveText('');
    await expect(page.locator('#prefDir')).toHaveValue('');
    expect(await page.evaluate(() => preferenceSubmission)).toBeNull();
});

for (const theme of ['light', 'dark']) {
    test(`keyboard feedback remains readable in ${theme} and narrow reduced-motion layouts`, async ({ page }) => {
        await ready(page);
        await page.setViewportSize({ width: 390, height: 700 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.locator('#prefTheme').selectOption(theme);
        const gate = saveGate(page); await gate.installed;
        await page.locator('#saveBtn').focus();
        await page.locator('#saveBtn').press('Enter');
        await expect(status(page)).toBeVisible();
        await expect(status(page)).toHaveAttribute('role', 'status');
        await expect(page.locator('#prefTheme')).toBeEnabled();
        expect(await page.locator('.pref-actions').evaluate(element => {
            const items = [element, ...element.children].filter(child => !child.hidden);
            return items.every(child => { const rect = child.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; });
        })).toBe(true);
        await release(gate);
        await expect(status(page)).toHaveText('Settings saved.');
    });
}

test('a newer remote revision remains canonical when an older acknowledgement arrives', async ({ page }) => {
    await ready(page);
    await page.locator('#prefMax').fill('6');
    const gate = saveGate(page, { committed: true }); await gate.installed;
    await page.locator('#saveBtn').click();
    await expect.poll(() => gate.releases.length).toBe(1);
    await page.request.post('/api/preferences', { data: { max_concurrent: '22' } });
    await page.evaluate(() => loadPreferences());
    await expect(page.locator('#prefMax')).toHaveValue('6');
    await release(gate);
    await expect(page.locator('#prefMax')).toHaveValue('22');
    await expect(status(page)).toContainText('Newer settings changes are now shown');
});

test('matching reads on reopen cannot confirm an unknown save or apply its playback effects', async ({ page }) => {
    await ready(page);
    const player = await page.evaluate(() => playerMode);
    await page.route('**/api/mutations/**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Mutation unavailable","final":false}' }));
    await page.route('**/api/preferences', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        await route.fetch();
        return route.abort();
    });
    await page.locator('#prefPlayer').selectOption('new_tab');
    await page.locator('#saveBtn').click();
    await expect(status(page)).toContainText('Save not confirmed');
    await page.locator('#settingsBackButton').click();
    await openSettings(page);
    await expect(status(page)).toContainText('Save not confirmed');
    expect(await page.evaluate(() => playerMode)).toBe(player);
    await expect(page.locator('#prefPlayer')).toHaveValue('new_tab');
    await expect(page.locator('#saveBtn')).toBeDisabled();
});

test('malformed success remains unknown and preserves the editable draft', async ({ page }) => {
    await ready(page);
    await page.route('**/api/preferences', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }) : route.continue());
    await page.locator('#prefMax').fill('6');
    await page.locator('#saveBtn').click();
    await expect(status(page)).toContainText('Save not confirmed');
    await expect(page.locator('#prefMax')).toHaveValue('6');
    await expect(page.locator('#saveBtn')).toBeDisabled();
});

test('a server without preference receipts retains pending drafts and explains unknown recovery', async ({ page }) => {
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.actions = data.actions.filter(action => action !== 'preference.set');
        await route.fulfill({ response, json: data });
    });
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await openSettings(page);
    expect(await page.evaluate(() => hasPreferenceProtocol())).toBe(false);
    await page.locator('#prefMax').fill('4');
    const gate = saveGate(page); await gate.installed;
    await page.locator('#saveBtn').click();
    await expect(status(page)).toContainText('Saving settings');
    await page.locator('#prefMax').fill('7');
    await release(gate);
    await expect(status(page)).toContainText('Newer edits remain unsaved');
    await page.unroute('**/api/preferences');
    await page.route('**/api/preferences', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"temporary failure"}' }) : route.continue());
    await page.locator('#saveBtn').click();
    await expect(status(page)).toContainText('This server has no receipt recovery');
    await expect(page.locator('#preferenceReload')).toBeVisible();
    await expect(page.locator('#preferenceUseCurrent')).toBeHidden();
    await expect(page.locator('#preferenceReplay')).toBeHidden();
});

test('changing the download directory leaves confirmed playback paths intact', async ({ page }) => {
    const { seed } = require('./support.cjs');
    await ready(page);
    await seed(page, { id: 'preference-path', status: 'finished' });
    const before = await (await page.request.get('/api/downloads/preference-path/editable-state')).json();
    const directory = await page.locator('#prefDir').inputValue();
    await page.locator('#prefDir').fill(`${directory}/new-downloads`);
    await page.locator('#saveBtn').click();
    await expect(status(page)).toHaveText('Settings saved.');
    const after = await (await page.request.get('/api/downloads/preference-path/editable-state')).json();
    expect(after.filename).toBe(before.filename);
    expect((await page.request.get('/api/file/preference-path')).ok()).toBeTruthy();
});


test('switching accounts clears unsaved preference drafts and ignores the previous save callback', async ({ page }) => {
    await ready(page);
    expect((await page.request.post('/api/users', { data: {
        username: 'preference-next-account', name: 'Next Preference Account', password: 'next-password', role: 'normal',
    } })).ok()).toBeTruthy();
    await page.locator('#prefMax').fill('5');
    let releaseOld;
    await page.route('**/api/preferences', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        await new Promise(resolve => { releaseOld = resolve; });
        await route.fulfill({ response }).catch(() => {});
    });
    await page.locator('#saveBtn').click();
    await expect.poll(() => !!releaseOld).toBe(true);
    await page.locator('#prefFormat').selectOption('__custom__');
    await page.locator('#prefFormatCustom').fill('private-old-account-draft');
    await switchAccount(page, 'preference-next-account', 'next-password');
    releaseOld();
    await expect(page.locator('#currentUsername')).toHaveText('preference-next-account');
    expect(await page.evaluate(() => preferenceSubmission)).toBeNull();
    expect(await page.evaluate(() => preferenceDirty)).toBe(false);
    await expect(page.locator('#prefFormatCustom')).not.toHaveValue('private-old-account-draft');
    await expect(page.locator('#preferenceMutationSummary')).toBeHidden();
});

test('permission loss clears the preference editor and fences its old response', async ({ page }) => {
    await ready(page);
    await page.locator('#prefDir').fill('/tmp/private-denied-preference');
    await page.locator('#prefFormat').selectOption('__custom__');
    await page.locator('#prefFormatCustom').fill('private-custom-format');
    await page.route('**/api/preferences', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Access denied"}' }) : route.continue());
    await page.locator('#saveBtn').click();
    await expect(page.locator('#prefDir')).toHaveValue('');
    await expect(page.locator('#prefFormatCustom')).toHaveValue('');
    await expect(status(page)).toHaveText('');
    expect(await page.evaluate(() => preferenceSubmission)).toBeNull();
    expect(await page.evaluate(() => tagState.selectPreferences())).toBeNull();
});

test('an obsolete denied load cannot clear a newer acknowledged editor', async ({ page }) => {
    await ready(page);
    let releaseDenied;
    await page.route('**/api/preferences', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        await new Promise(resolve => { releaseDenied = resolve; });
        await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Access denied"}' });
    });
    await page.evaluate(() => { window.obsoleteDeniedLoad = loadPreferences(); });
    await expect.poll(() => !!releaseDenied).toBe(true);
    await page.locator('#prefMax').fill('17');
    await page.locator('#saveBtn').click();
    await expect(status(page)).toHaveText('Settings saved.');
    releaseDenied();
    await page.evaluate(() => window.obsoleteDeniedLoad);
    await expect(page.locator('#prefMax')).toHaveValue('17');
    await expect(page.locator('#saveBtn')).toBeEnabled();
    expect(await page.evaluate(() => tagState.selectPreferences().values.max_concurrent)).toBe('17');
});


test('unknown saves announce a polite recovery status after Settings closes without repeated churn', async ({ page }) => {
    await ready(page);
    let releaseResponse;
    await page.route('**/api/preferences', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        await new Promise(resolve => { releaseResponse = resolve; });
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"temporary failure"}' });
    });
    await page.locator('#prefMax').fill('6');
    await page.locator('#saveBtn').click();
    await expect.poll(() => !!releaseResponse).toBe(true);
    await page.locator('#settingsBackButton').click();
    const summary = page.locator('#preferenceMutationSummary');
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute('role', 'status');
    await expect(summary).toHaveAttribute('aria-live', 'polite');
    await expect(status(page)).toBeHidden();
    releaseResponse();
    await expect(summary).toContainText('Save not confirmed');
    const mutations = await summary.locator('span').evaluate(async element => {
        let changes = 0;
        const observer = new MutationObserver(records => { changes += records.length; });
        observer.observe(element, { childList: true, characterData: true, subtree: true });
        renderPreferenceStatus();
        renderPreferenceStatus();
        await Promise.resolve();
        observer.disconnect();
        return changes;
    });
    expect(mutations).toBe(0);
    await summary.getByRole('button', { name: 'Open Settings' }).click();
    await expect(summary).toBeHidden();
    await expect(status(page)).toBeVisible();
    await expect(status(page)).toContainText('Save not confirmed');
    await expect(page.locator('#preferenceCheck')).toBeVisible();
    await expect(page.locator('#preferenceReplay')).toBeVisible();
});
