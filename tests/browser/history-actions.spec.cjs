const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent } = require('./support.cjs');

async function openInfo(row) {
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await expect(row.locator('.history-info-popover')).toBeVisible();
}

test.beforeEach(async ({ page }) => reset(page));

test('fixed header opens the full-height Current drawer and Settings dialog', async ({ page }) => {
    await seed(page, { id: 'drawer001', status: 'downloading', progress: '25%' });
    await refresh(page);

    await expect(page.locator('[data-tab]')).toHaveCount(0);
    await expect(page.locator('#tab-history')).toBeVisible();
    await expect(page.locator('#tab-history').getByRole('button', { name: 'Clear History' })).toHaveCount(0);
    await expect(page.locator('#tab-history')).toHaveAttribute('aria-label', 'Download history');
    await expect(page.getByRole('heading', { name: 'Download History' })).toHaveCount(0);

    const header = page.locator('#appHeader');
    const headerPosition = await header.evaluate(element => {
        const box = element.getBoundingClientRect();
        return {
            position: getComputedStyle(element).position,
            top: Math.round(box.top),
            left: Math.round(box.left),
            right: Math.round(window.innerWidth - box.right),
        };
    });
    expect(headerPosition).toEqual({ position: 'fixed', top: 0, left: 0, right: 0 });

    const newDownloadButton = page.locator('#newDownloadButton');
    const currentButton = page.locator('#currentDownloadsButton');
    const settingsButton = page.locator('#settingsButton');
    await expect(newDownloadButton).toContainText('New download');
    await expect(currentButton).toContainText('Current downloads');
    await expect(currentButton.locator('#currentBadge')).toHaveText('1');
    expect(await currentButton.evaluate((button, settings) => (
        button.getBoundingClientRect().right <= document.querySelector(settings).getBoundingClientRect().left
    ), '#settingsButton')).toBeTruthy();

    await newDownloadButton.click();
    const newDownloadDialog = page.locator('#newDownloadDialog');
    await expect(newDownloadDialog).toBeVisible();
    await expect(newDownloadDialog.getByRole('heading', { name: 'New download' })).toBeVisible();
    expect(await newDownloadDialog.evaluate(element => element.matches(':modal'))).toBe(true);
    await newDownloadDialog.getByRole('button', { name: 'Close new download' }).click();
    await expect(newDownloadDialog).toBeHidden();
    await expect(newDownloadButton).toBeFocused();

    await currentButton.click();
    const drawer = page.locator('#currentDownloadsDrawer');
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate(element => element.matches(':modal'))).toBe(true);
    expect(await drawer.evaluate(element => {
        const style = getComputedStyle(element);
        return { name: style.animationName, duration: style.animationDuration };
    })).toEqual({ name: 'current-drawer-slide-in', duration: '0.28s' });
    await drawer.evaluate(element => Promise.all(
        element.getAnimations().map(animation => animation.finished),
    ));
    const drawerPosition = await drawer.evaluate(element => {
        const box = element.getBoundingClientRect();
        return {
            top: Math.round(box.top),
            bottom: Math.round(window.innerHeight - box.bottom),
            right: Math.round(window.innerWidth - box.right),
        };
    });
    expect(drawerPosition).toEqual({ top: 0, bottom: 0, right: 0 });
    await expect(drawer.locator('[data-row-id="drawer001"]')).toBeVisible();
    await drawer.getByRole('button', { name: 'Close current downloads' }).click();
    await expect(drawer).toBeHidden();
    await expect(currentButton).toBeFocused();

    await expect(settingsButton).toBeVisible();
    await expect(settingsButton).toHaveAttribute('aria-label', 'Settings');
    await expect(settingsButton.locator('use')).toHaveAttribute('href', '#i-cog');
    await expect(settingsButton).toHaveText('');
    await settingsButton.click();

    const dialog = page.locator('#settingsDialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
    expect(await dialog.evaluate(element => getComputedStyle(element, '::backdrop').backgroundColor))
        .not.toBe('rgba(0, 0, 0, 0)');
    await expect(dialog.getByRole('button', { name: 'Clear History' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(dialog).toBeHidden();
});

test('Current drawer respects reduced-motion preferences', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#currentDownloadsButton').click();

    const drawer = page.locator('#currentDownloadsDrawer');
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    expect(await drawer.evaluate(element => getComputedStyle(element, '::backdrop').animationName)).toBe('none');
});

test('Current drawer becomes a full-height full-width sheet on small screens', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await seed(page, { id: 'mobile-current', status: 'paused', progress: 'Paused' });
    await refresh(page);

    const button = page.locator('#currentDownloadsButton');
    await expect(button.locator('.current-downloads-label')).toBeHidden();
    await expect(button.locator('#currentBadge')).toHaveText('1');
    await button.click();

    const drawer = page.locator('#currentDownloadsDrawer');
    await drawer.evaluate(element => Promise.all(
        element.getAnimations().map(animation => animation.finished),
    ));
    const position = await drawer.evaluate(element => {
        const box = element.getBoundingClientRect();
        return {
            left: Math.round(box.left),
            top: Math.round(box.top),
            bottom: Math.round(window.innerHeight - box.bottom),
            width: Math.round(box.width),
        };
    });
    expect(position).toEqual({ left: 0, top: 0, bottom: 0, width: 390 });
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(button).toBeFocused();
});

test('History groups media details and shows a human-readable duration', async ({ page }) => {
    const fixtures = [
        ['history-day', 86400 + 5 * 3600 + 17 * 60, '1 Day and 5 Hours'],
        ['history-hours', 11 * 3600 + 35 * 60, '11 Hours and 35 Minutes'],
        ['history-minutes', 3 * 60 + 45, '3 Minutes and 45 Seconds'],
        ['history-singular', 60 + 1, '1 Minute and 1 Second'],
    ];

    for (const [id, durationSeconds] of fixtures) {
        const row = await seed(page, {
            id, status: 'finished', resolution: '720p', filesize: 2048,
        });
        await seed(page, {
            id, status: 'finished', finished_at: row.created_at + durationSeconds,
        });
    }

    await refresh(page);

    for (const [id, , durationLabel] of fixtures) {
        const row = page.locator(`[data-row-id="${id}"]`);
        await openInfo(row);
        await expect(row.locator('.history-media-row')).toHaveText('Quality: 720p · Size: 2.0 KB');
        await expect(row.locator('.history-timing-row')).toContainText('Started:');
        await expect(row.locator('.history-timing-row')).toContainText(`Duration: ${durationLabel}`);
        await expect(row).not.toContainText('Finished:');
        await row.getByRole('button', { name: 'Close info', exact: true }).click();
    }
});

test('History places a readable requested format on the media line', async ({ page }) => {
    await seed(page, {
        id: 'history-format-id',
        status: 'finished',
        resolution: '2160p',
        filesize: 2048,
        requested_format: '625',
        formats: JSON.stringify([{
            format_id: '625',
            ext: 'mp4',
            height: 2160,
            fps: 60,
            vcodec: 'av01',
            acodec: 'none',
        }]),
    });
    await seed(page, {
        id: 'history-format-selector',
        status: 'finished',
        requested_format: 'bestvideo[height<=720]+bestaudio/best',
    });

    await refresh(page);

    const idRow = page.locator('[data-row-id="history-format-id"]');
    await openInfo(idRow);
    await expect(idRow.locator('.history-media-row')).toHaveText(
        'Quality: 2160p · Size: 2.0 KB · Requested format: 2160p 60fps MP4 video'
    );
    await expect(idRow.locator('.fmt-code')).toHaveCount(0);
    await idRow.getByRole('button', { name: 'Close info', exact: true }).click();

    const selectorRow = page.locator('[data-row-id="history-format-selector"]');
    await openInfo(selectorRow);
    await expect(selectorRow.locator('.history-media-row')).toHaveText(
        'Requested format: Up to 720p video + audio'
    );
});

test('inline rename supports cancel, save, and extension preservation', async ({ page }) => {
    await seed(page, { id: 'rename01', status: 'finished', file: true, name: 'original.mp4' });
    await refresh(page);
    const row = page.locator('[data-row-id="rename01"]');
    await openInfo(row);
    await row.getByRole('button', { name: 'Edit name', exact: true }).click();
    await row.locator('.rename-input').fill('discarded');
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(row.locator('.rename-display')).toHaveText('original.mp4');
    await row.getByRole('button', { name: 'Edit name', exact: true }).click();
    await row.locator('.rename-input').fill('renamed.webm');
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row.locator('.rename-display')).toHaveText('renamed.mp4');
});

test('Copy URL uses plain confirmation icon and restores the copy action', async ({ page }) => {
    await page.clock.install();
    const url = 'https://fixture.invalid/copy';
    await seed(page, { id: 'copy0001', status: 'finished', file: true, url });
    await refresh(page);
    const row = page.locator('[data-row-id="copy0001"]');
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Copy URL', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Copied', exact: true }).locator('use')).toHaveAttribute('href', '#i-check');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await page.clock.fastForward(1600);
    await expect(row.getByRole('button', { name: 'Copy URL', exact: true })).toBeVisible();
});

test('error details fold and Reload removes then resubmits the stored URL', async ({ page }) => {
    const url = 'https://fixture.invalid/missing';
    await seed(page, { id: 'error001', status: 'error', progress: 'HTTP Error 404', url });
    await refresh(page);
    const row = page.locator('[data-row-id="error001"]');
    await openInfo(row);
    await row.locator('.error-details summary').click();
    await expect(row.locator('.error-text')).toContainText('404');
    const calls = [];
    await page.route('**/api/remove/error001', async route => {
        calls.push('remove');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/download', async route => {
        calls.push(route.request().postDataJSON().url);
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"retry001"}' });
    });
    await row.getByRole('button', { name: 'Close info', exact: true }).click();
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls).toEqual(['remove', url]);
});

test('stored URL remains data for Open, Reload, Continue, and Copy actions', async ({ page }) => {
    const url = "https://fixture.invalid/a');window.__injected=1;//<b>";
    for (const [id, status] of [['safe-error', 'error'], ['safe-cancel', 'cancelled']]) {
        await seed(page, { id, status, progress: 'fixture error', url });
    }
    await refresh(page);
    await refresh(page);
    const errorRow = page.locator('[data-row-id="safe-error"]');
    const actions = errorRow.locator('[data-url-action]');
    await expect(actions).toHaveCount(3);
    for (const action of await actions.all()) {
        await expect(action).not.toHaveAttribute('onclick', /./);
        expect(await action.getAttribute('data-url')).toBe(url);
    }
    await openCurrent(page);
    const continueAction = page.locator('[data-row-id="safe-cancel"] [data-url-action="continue"]');
    await expect(continueAction).not.toHaveAttribute('onclick', /./);
    expect(await continueAction.getAttribute('data-url')).toBe(url);
    expect(await page.evaluate(() => window.__injected)).toBeUndefined();
});

test('renamed filename remains data when Play is clicked', async ({ page }) => {
    await seed(page, { id: 'safe-play', status: 'finished', file: true, name: 'original.mp4' });
    await refresh(page);
    const row = page.locator('[data-row-id="safe-play"]');
    await openInfo(row);
    const hostileName = 'safe&apos;);self[&quot;__filenameInjected&quot;]=1;void(&apos;';
    await row.getByRole('button', { name: 'Edit name', exact: true }).click();
    await row.locator('.rename-input').fill(hostileName);
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row.locator('.rename-display')).toContainText(hostileName);

    await row.getByRole('button', { name: 'Close info', exact: true }).click();

    const play = row.getByRole('button', { name: 'Play', exact: true });
    const inlineHandler = await play.getAttribute('onclick');
    expect(await play.getAttribute('data-play-label')).toBe(`${hostileName}.mp4`);
    await play.click();
    expect(await page.evaluate(() => window.__filenameInjected)).toBeUndefined();
    expect(inlineHandler).toBeNull();
});

test('History cards show preview first and preview click starts playback', async ({ page }) => {
    await seed(page, {
        id: 'preview01', status: 'finished', file: true,
        name: 'preview.mp4', title: 'Preview title',
    });
    await refresh(page);

    const card = page.locator('[data-row-id="preview01"]');
    await expect(card.locator('.history-preview')).toBeVisible();
    await expect(card.locator('.history-card-title')).toHaveText('Preview title');
    await expect(card.locator('.history-info-popover')).toBeHidden();
    const children = await card.locator(':scope > *').evaluateAll(elements =>
        elements.map(element => element.className));
    expect(children[0]).toContain('history-preview');

    await card.locator('.history-preview').click();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/preview01');
});

test('History info is wider on desktop and points back to its menu', async ({ page }) => {
    await seed(page, {
        id: 'popover01', status: 'finished', file: true,
        name: 'popover.mp4', title: 'Popover sizing',
    });
    await refresh(page);

    const row = page.locator('[data-row-id="popover01"]');
    await page.setViewportSize({ width: 1200, height: 800 });
    await openInfo(row);

    const popover = row.locator('.history-info-popover');
    await expect(popover).toHaveCSS('width', '560px');
    expect(await popover.getAttribute('data-placement')).toMatch(/^(above|below)$/);
    const pointer = await popover.evaluate(element => ({
        x: Number.parseFloat(getComputedStyle(element).getPropertyValue('--popover-pointer-x')),
        width: element.getBoundingClientRect().width,
        beforeContent: getComputedStyle(element, '::before').content,
        pointerViewportX: element.getBoundingClientRect().left
            + Number.parseFloat(getComputedStyle(element).getPropertyValue('--popover-pointer-x')),
    }));
    const menuCenter = await row.locator('.kebab-btn').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.left + rect.width / 2;
    });
    expect(pointer.x).toBeGreaterThanOrEqual(16);
    expect(pointer.x).toBeLessThanOrEqual(pointer.width - 16);
    expect(pointer.beforeContent).not.toBe('none');
    expect(Math.abs(pointer.pointerViewportX - menuCenter)).toBeLessThan(1);

    await page.setViewportSize({ width: 390, height: 800 });
    await openInfo(row);
    await expect(popover).toHaveCSS('width', '366px');
});

test('History lays out one through five cards and left-aligns incomplete rows', async ({ page }) => {
    for (let index = 1; index <= 6; index += 1) {
        await seed(page, {
            id: `grid000${index}`, status: 'finished', file: true,
            name: `grid-${index}.mp4`, title: `Grid ${index}`,
        });
    }
    await refresh(page);

    for (const [width, expectedColumns] of [
        [480, 1], [650, 2], [900, 3], [1150, 4], [1500, 5],
    ]) {
        await page.setViewportSize({ width, height: 900 });
        const columns = await page.locator('#historyList .history-card').evaluateAll(cards => {
            const firstTop = cards[0].getBoundingClientRect().top;
            return cards.filter(card => (
                Math.abs(card.getBoundingClientRect().top - firstTop) < 2
            )).length;
        });
        expect(columns).toBe(expectedColumns);
    }

    await page.setViewportSize({ width: 1500, height: 900 });
    const alignment = await page.locator('#historyList').evaluate(element => {
        const cards = Array.from(element.querySelectorAll('.history-card'));
        const first = cards[0].getBoundingClientRect();
        const last = cards[cards.length - 1].getBoundingClientRect();
        return {
            firstLeft: first.left,
            lastLeft: last.left,
        };
    });
    expect(Math.abs(alignment.firstLeft - alignment.lastLeft)).toBeLessThan(2);
});

test('fixed footer reports every stored download', async ({ page }) => {
    await seed(page, { id: 'count-current', status: 'cancelled' });
    await seed(page, { id: 'count-history', status: 'finished', file: true });
    await refresh(page);

    await expect(page.locator('#itemCount')).toHaveText('2 items');
    const footerPosition = await page.locator('#versionFooter').evaluate(element => {
        const box = element.getBoundingClientRect();
        return {
            position: getComputedStyle(element).position,
            bottom: Math.round(window.innerHeight - box.bottom),
        };
    });
    expect(footerPosition).toEqual({ position: 'fixed', bottom: 0 });
});

test('Clear History confirms and deletes stored files', async ({ page }) => {
    await seed(page, { id: 'clear001', status: 'finished', file: true });
    await page.locator('#settingsButton').click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear History', exact: true }).click();
    await expect(page.locator('[data-row-id="clear001"]')).toHaveCount(0);
    expect((await page.request.get('/api/file/clear001')).status()).toBe(404);
});

test('Clear History leaves resumable Current rows intact', async ({ page }) => {
    await seed(page, { id: 'finished1', status: 'finished', file: true });
    await seed(page, { id: 'cancelled1', status: 'cancelled', progress: 'Stopped' });
    await page.locator('#settingsButton').click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear History', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await openCurrent(page);
    await expect(page.locator('[data-row-id="cancelled1"]')).toBeVisible();
});
