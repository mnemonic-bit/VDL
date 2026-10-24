const { test, expect } = require('@playwright/test');
const { reset, closeCurrent, openNewDownload } = require('./support.cjs');

test.beforeEach(async ({ page }) => {
    await reset(page);
    await openNewDownload(page);
});

test('empty Options accepts the disabled-fields-behind-message contract', async ({ page }) => {
    await page.locator('.options-summary').click();
    await expect(page.locator('#optionsOverlay')).toBeVisible();
    await expect(page.locator('#optionsOverlay')).toContainText('URL');
    await expect(page.locator('#optionsQualitySelect')).toBeDisabled();
    await expect(page.locator('#optionsContainerSelect')).toBeDisabled();
    await expect(page.locator('.options-summary svg')).toHaveCount(1);
    expect(await page.locator('.options-summary').evaluate(el => getComputedStyle(el).listStyleType)).toBe('none');
});

test('MP4 option builds a compatible MP4-video plus M4A-audio selector', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/options');
    await expect(page.locator('#optionsQualitySelect')).toBeEnabled({ timeout: 3000 });
    await page.locator('#optionsQualitySelect').selectOption('bestvideo[height<=360]+bestaudio/best');
    await page.locator('#optionsContainerSelect').selectOption('mp4');
    let payload;
    await page.route('**/api/download', async route => {
        payload = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"format01"}' });
    });
    await page.locator('#downloadForm button[type=submit]').click();
    await expect(page.locator('#urlInput')).toHaveValue('');
    expect(payload.format).toBe('bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]');
});

test('select interaction does not dismiss New download', async ({ page }) => {
    const url = 'https://fixture.invalid/select';
    await page.locator('#urlInput').fill(url);
    const quality = page.locator('#optionsQualitySelect');
    await expect(quality).toBeEnabled({ timeout: 3000 });

    // Native select popups can report the option click without useful viewport
    // coordinates. It is still an interaction with a control inside the dialog.
    await quality.dispatchEvent('click', { clientX: 0, clientY: 0 });

    await expect(page.locator('#newDownloadDialog')).toBeVisible();
    await expect(page.locator('#urlInput')).toHaveValue(url);
});

test('probe quality controls never emit NaN selectors', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/options');
    await expect(page.locator('#optionsQualitySelect')).toBeEnabled({ timeout: 3000 });
    const values = await page.locator('#optionsQualitySelect option').evaluateAll(options => options.map(option => option.value));
    expect(values.some(value => value.includes('NaN'))).toBeFalsy();
});

test('only the newest probe can update Options', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/slow-probe-A');
    await page.waitForRequest(request => request.url().endsWith('/api/probe'));
    const slowProbe = page.waitForResponse(response => (
        response.url().endsWith('/api/probe')
        && response.request().postDataJSON().url.endsWith('/slow-probe-A')
    ));
    await page.locator('#urlInput').fill('https://fixture.invalid/fast-B');
    await expect(page.locator('#optionsFilename')).toHaveAttribute('placeholder', /fast-B/);
    await slowProbe;
    await expect(page.locator('#optionsFilename')).toHaveAttribute('placeholder', /fast-B/);
});

test('clearing the URL invalidates an in-flight probe', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/slow-probe-A');
    await page.waitForRequest(request => request.url().endsWith('/api/probe'));
    const slowProbe = page.waitForResponse(response => response.url().endsWith('/api/probe'));
    await page.locator('#urlClear').click();
    await slowProbe;
    await expect(page.locator('#optionsFilename')).toHaveAttribute(
        'placeholder',
        'Will be auto-filled from video title',
    );
    await expect(page.locator('#optionsQualitySelect')).toBeDisabled();
    await expect(page.locator('#optionsContainerSelect')).toBeDisabled();
    await expect(page.locator('#optionsOverlay')).not.toHaveClass(/hidden/);
    await expect(page.locator('#optionsFilename')).toBeDisabled();
    await expect(page.locator('#downloadSubmit')).toBeDisabled();
    await expect(page.locator('#optionsSpinner')).toBeHidden();
    await expect(page.locator('#optionsContent')).toHaveAttribute('aria-busy', 'false');
});

test('probe title is assigned as raw text to the filename hint', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/raw-title');
    await expect(page.locator('#optionsFilename')).toHaveAttribute(
        'placeholder',
        'Will be auto-filled: Rock & Roll <Live>',
        { timeout: 3000 },
    );
});

test('custom filename controls the resulting downloaded basename', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/custom');
    await page.locator('#optionsFilename').fill('chosen-browser-name');
    await page.locator('#downloadForm button[type=submit]').click();
    await closeCurrent(page);
    await expect(page.locator('#historyList')).toContainText('chosen-browser-name.mp4', { timeout: 5000 });
});

async function expectDependentControlsDisabled(page) {
    for (const id of ['optionsQualitySelect', 'optionsContainerSelect', 'optionsFilename', 'downloadSubmit']) {
        await expect(page.locator(`#${id}`)).toBeDisabled();
    }
}

const readyProbe = { title: 'Ready video', resolutions: ['720p'], containers: ['mp4'] };

test('checking starts during debounce and stays busy until metadata arrives', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    // Installing the clock still lets time pass during assertions and input.
    // Pause before typing so only runFor advances the debounce deadline.
    await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    let pendingProbe;
    let submissions = 0;
    await page.route('**/api/probe', route => { pendingProbe = route; });
    await page.route('**/api/download', route => {
        submissions += 1;
        return route.fulfill({ json: { id: 'unexpected' } });
    });
    await page.locator('#urlInput').fill('https://fixture.invalid/checking');
    await page.clock.runFor(100);
    await expect(page.locator('#optionsSpinner')).toBeVisible();
    await expect(page.locator('#optionsMessage')).toHaveText('Checking video information…');
    await expect(page.locator('#optionsContent')).toHaveAttribute('aria-busy', 'true');
    await expectDependentControlsDisabled(page);
    await expect(page.locator('#urlInput')).toBeEditable();
    await expect(page.locator('#urlClear')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Close new download' })).toBeEnabled();
    await page.locator('#urlInput').press('Enter');
    await page.evaluate(() => startDownload());
    expect(submissions).toBe(0);
    await page.clock.runFor(399);
    expect(pendingProbe).toBeUndefined();
    await page.clock.runFor(1);
    await expect.poll(() => Boolean(pendingProbe)).toBe(true);
    await expectDependentControlsDisabled(page);
    await pendingProbe.fulfill({ json: readyProbe });
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await expect(page.locator('#optionsSpinner')).toBeHidden();
    await expect(page.locator('#optionsContent')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#optionsFilename')).toBeEnabled();
    await expect(page.locator('#downloadReadinessStatus')).toContainText('ready');
});

test('changing a ready URL immediately resets its options and filename hint', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/first');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await page.locator('#optionsQualitySelect').selectOption('bestvideo[height<=360]+bestaudio/best');
    await page.locator('#optionsContainerSelect').selectOption('mp4');
    await page.clock.install();
    await page.locator('#urlInput').fill('https://fixture.invalid/replacement');
    await expectDependentControlsDisabled(page);
    await expect(page.locator('#optionsQualitySelect option')).toHaveCount(1);
    await expect(page.locator('#optionsContainerSelect option')).toHaveCount(1);
    await expect(page.locator('#optionsFilename')).toHaveAttribute('placeholder', 'Will be auto-filled from video title');
    await expect(page.locator('#optionsContent')).toHaveAttribute('data-state', 'checking');
});

for (const response of [
    { name: 'empty menus', json: { resolutions: [], containers: [] }, qualityDisabled: true, containerDisabled: true },
    { name: 'audio-only formats', json: { resolutions: [], containers: ['m4a'] }, qualityDisabled: true, containerDisabled: false },
    { name: 'no containers', json: { resolutions: ['360p'], containers: [], title: null }, qualityDisabled: false, containerDisabled: true },
]) {
    test(`successful probe with ${response.name} still permits Download`, async ({ page }) => {
        await page.route('**/api/probe', route => route.fulfill({ json: response.json }));
        await page.locator('#urlInput').fill('https://fixture.invalid/empty-options');
        await expect(page.locator('#downloadSubmit')).toBeEnabled();
        await expect(page.locator('#optionsFilename')).toBeEnabled();
        await expect(page.locator('#optionsFilename')).toHaveAttribute('placeholder', 'Will be auto-filled from video title');
        if (response.qualityDisabled) await expect(page.locator('#optionsQualitySelect')).toBeDisabled();
        else await expect(page.locator('#optionsQualitySelect')).toBeEnabled();
        if (response.containerDisabled) await expect(page.locator('#optionsContainerSelect')).toBeDisabled();
        else await expect(page.locator('#optionsContainerSelect')).toBeEnabled();
        if (response.name === 'empty menus') {
            let payload;
            await page.route('**/api/download', route => {
                payload = route.request().postDataJSON();
                return route.fulfill({ json: { id: 'defaults' } });
            });
            await page.locator('#downloadSubmit').click();
            await expect(page.locator('#newDownloadDialog')).toBeHidden();
            expect(payload.format).toBeUndefined();
        }
    });
}

for (const failure of [
    { name: 'HTTP error', status: 503, json: readyProbe },
    { name: 'extractor error', json: { error: '<img src=x onerror=alert(1)>' } },
    { name: 'null response', json: null },
    { name: 'missing metadata', json: {} },
    { name: 'invalid containers', json: { resolutions: [], containers: [123] } },
    { name: 'invalid title', json: { resolutions: [], containers: [], title: {} } },
    { name: 'invalid JSON', body: 'not JSON', contentType: 'application/json' },
    { name: 'network error', abort: true },
]) {
    test(`${failure.name} disables Download and offers a safe Retry`, async ({ page }) => {
        const url = 'https://fixture.invalid/retry';
        const requests = [];
        await page.route('**/api/probe', route => {
            requests.push(route.request().postDataJSON().url);
            if (requests.length > 1) return route.fulfill({ json: readyProbe });
            if (failure.abort) return route.abort('failed');
            const { name, ...response } = failure;
            return route.fulfill(response);
        });
        await page.locator('#urlInput').fill(url);
        await expect(page.locator('#optionsMessage')).toContainText('Could not load video information');
        await expect(page.locator('#optionsRetry')).toBeVisible();
        await expectDependentControlsDisabled(page);
        await expect(page.locator('#optionsContent')).toHaveAttribute('aria-busy', 'false');
        await expect(page.locator('#optionsOverlay img')).toHaveCount(0);
        await page.locator('#urlInput').press('Enter');
        await expect(page.locator('#newDownloadDialog')).toBeVisible();
        await page.locator('#optionsRetry').click();
        await expect(page.locator('#downloadSubmit')).toBeEnabled();
        expect(requests).toEqual([url, url]);
    });
}

for (const staleFailure of [false, true]) {
    test(`late probe ${staleFailure ? 'failure' : 'success'} cannot replace the current ready state`, async ({ page }) => {
        let olderProbe;
        await page.route('**/api/probe', route => {
            if (route.request().postDataJSON().url.endsWith('/old')) {
                olderProbe = route;
                return;
            }
            return route.fulfill({ json: readyProbe });
        });
        await page.locator('#urlInput').fill('https://fixture.invalid/old');
        await expect.poll(() => Boolean(olderProbe)).toBe(true);
        await page.locator('#urlInput').fill('https://fixture.invalid/new');
        await expect(page.locator('#downloadSubmit')).toBeEnabled();
        await olderProbe.fulfill({ json: staleFailure ? { error: 'obsolete failure' } : { ...readyProbe, title: 'Obsolete' } });
        // Drain response callbacks before checking that the accepted UI survived.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(page.locator('#optionsFilename')).toHaveAttribute('placeholder', 'Will be auto-filled: Ready video');
        await expect(page.locator('#downloadSubmit')).toBeEnabled();
        await expect(page.locator('#optionsRetry')).toBeHidden();
    });
}

test('closing and reopening preserves checking, ready, and error states', async ({ page }) => {
    let pendingProbe;
    await page.route('**/api/probe', route => { pendingProbe = route; });
    await page.locator('#urlInput').fill('https://fixture.invalid/draft');
    await expect.poll(() => Boolean(pendingProbe)).toBe(true);
    await page.getByRole('button', { name: 'Close new download' }).click();
    await openNewDownload(page);
    await expect(page.locator('#optionsSpinner')).toBeVisible();
    await expectDependentControlsDisabled(page);
    await pendingProbe.fulfill({ json: readyProbe });
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await page.locator('#optionsFilename').fill('preserved-draft');
    await page.keyboard.press('Escape');
    await openNewDownload(page);
    await expect(page.locator('#optionsFilename')).toHaveValue('preserved-draft');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await page.route('**/api/probe', route => route.fulfill({ json: { error: 'failed' } }));
    await page.locator('#urlInput').fill('https://fixture.invalid/failure');
    await expect(page.locator('#optionsRetry')).toBeVisible();
    await page.keyboard.press('Escape');
    await openNewDownload(page);
    await expect(page.locator('#optionsRetry')).toBeVisible();
    await expectDependentControlsDisabled(page);
});

for (const theme of ['light', 'dark']) {
    test(`${theme} narrow layout shows readable status, reduced-motion spinner, and green Ready button`, async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        let pendingProbe;
        await page.route('**/api/probe', route => { pendingProbe = route; });
        const neutralColor = await page.locator('#downloadSubmit').evaluate(el => getComputedStyle(el).backgroundColor);
        await page.locator('#urlInput').fill('https://fixture.invalid/theme');
        await expect.poll(() => Boolean(pendingProbe)).toBe(true);
        await expect(page.locator('#optionsSpinner')).toBeVisible();
        expect(await page.locator('#optionsSpinner').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
        const dialog = await page.locator('#newDownloadDialog').boundingBox();
        const status = await page.locator('#optionsMessage').boundingBox();
        expect(status.x).toBeGreaterThanOrEqual(dialog.x);
        expect(status.x + status.width).toBeLessThanOrEqual(dialog.x + dialog.width);
        await expect(page.locator('#downloadReadinessStatus')).toHaveAttribute('role', 'status');
        await pendingProbe.fulfill({ json: readyProbe });
        const button = page.locator('#downloadSubmit');
        await expect(button).toBeEnabled();
        expect(await button.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(neutralColor);
        expect(await button.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(31, 138, 59)');
        await page.locator('#urlInput').focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        await expect(button).toBeFocused();
        expect(await button.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    });
}

test('pasting over a ready URL immediately starts a new checking cycle', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/before-paste');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    let pendingProbe;
    await page.route('**/api/probe', route => { pendingProbe = route; });
    await page.evaluate(() => navigator.clipboard.writeText('https://fixture.invalid/pasted'));
    await page.locator('#urlInput').selectText();
    await page.keyboard.press('Control+v');
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/pasted');
    await expectDependentControlsDisabled(page);
    await expect(page.locator('#optionsSpinner')).toBeVisible();
    await expect.poll(() => Boolean(pendingProbe)).toBe(true);
    await pendingProbe.fulfill({ json: readyProbe });
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
});

test('clearing and immediately entering another URL keeps the checking panel open', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/original');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    let pendingProbe;
    await page.route('**/api/probe', route => { pendingProbe = route; });
    await page.locator('#urlClear').click();
    await page.locator('#urlInput').fill('https://fixture.invalid/replacement');
    await expect.poll(() => Boolean(pendingProbe)).toBe(true);
    await expect(page.locator('#optionsSpinner')).toBeVisible();
    await pendingProbe.fulfill({ json: readyProbe });
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
});
