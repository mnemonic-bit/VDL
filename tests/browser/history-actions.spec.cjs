const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, openSettings } = require('./support.cjs');

async function openInfo(row) {
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await expect(row.locator('.history-info-popover')).toBeVisible();
}

test.beforeEach(async ({ page }) => reset(page));

test('fixed header opens the Current drawer and full Settings page', async ({ page }) => {
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
    const accountButton = page.locator('#accountMenuButton');
    const accountMenu = page.locator('#accountMenu');
    const settingsButton = page.locator('#settingsButton');
    await expect(newDownloadButton).toHaveText('');
    expect(await newDownloadButton.evaluate(button => {
        const box = button.getBoundingClientRect();
        return {
            width: Math.round(box.width),
            height: Math.round(box.height),
            borderRadius: getComputedStyle(button).borderRadius,
        };
    })).toEqual({ width: 40, height: 40, borderRadius: '50%' });
    await expect(currentButton).toContainText('Current downloads');
    await expect(currentButton).toBeVisible();
    await expect(currentButton.locator('#currentBadge')).toHaveText('1');
    await expect(accountButton).toContainText('admin');
    await expect(accountButton).toHaveAttribute('aria-expanded', 'false');
    await expect(accountMenu).toBeHidden();
    expect(await accountButton.evaluate((button, currentSelector) => (
        button.getBoundingClientRect().left
            >= document.querySelector(currentSelector).getBoundingClientRect().right
    ), '#currentDownloadsButton')).toBeTruthy();

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

    await accountButton.click();
    await expect(accountMenu).toBeVisible();
    await expect(accountButton).toHaveAttribute('aria-expanded', 'true');
    expect(await accountMenu.evaluate((menu, buttonSelector) => (
        Math.abs(menu.getBoundingClientRect().right
            - document.querySelector(buttonSelector).getBoundingClientRect().right) < 2
    ), '#accountMenuButton')).toBeTruthy();
    await expect(settingsButton).toBeVisible();
    await expect(settingsButton.locator('use')).toHaveAttribute('href', '#i-cog');
    await expect(settingsButton).toContainText('Preferences');
    await expect(accountMenu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await settingsButton.click();

    const settingsPage = page.locator('#settingsPage');
    await expect(settingsPage).toBeVisible();
    await expect(page.locator('#tab-history')).toBeHidden();
    await expect(settingsPage.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
    await expect(settingsPage.getByRole('button', { name: 'Clear History' })).toBeVisible();
    await expect(settingsPage.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await settingsPage.getByRole('button', { name: 'Back to videos', exact: true }).click();
    await expect(settingsPage).toBeHidden();
    await expect(page.locator('#tab-history')).toBeVisible();
    await expect(accountButton).toBeFocused();
});

test('account menu supports keyboard navigation and closes outside', async ({ page }) => {
    const accountButton = page.locator('#accountMenuButton');
    const accountMenu = page.locator('#accountMenu');

    await accountButton.focus();
    await accountButton.press('ArrowDown');
    await expect(accountMenu).toBeVisible();
    await expect(page.locator('#settingsButton')).toBeFocused();
    await page.locator('#settingsButton').press('ArrowDown');
    await expect(accountMenu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(accountMenu).toBeHidden();
    await expect(accountButton).toBeFocused();

    await accountButton.click();
    await page.locator('#tab-history').click({ position: { x: 1, y: 1 } });
    await expect(accountMenu).toBeHidden();
});

test('Current downloads button only appears while the drawer has work', async ({ page }) => {
    const button = page.locator('#currentDownloadsButton');
    await expect(button).toBeHidden();

    await seed(page, { id: 'interrupted-only', status: 'interrupted' });
    await refresh(page);
    await expect(button).toBeVisible();

    await seed(page, { id: 'paused-active', status: 'paused' });
    await refresh(page);
    await expect(button).toBeVisible();

    await seed(page, { id: 'interrupted-only', status: 'finished', file: true });
    await seed(page, { id: 'paused-active', status: 'finished', file: true });
    await refresh(page);
    await expect(button).toBeHidden();
});

test('Current drawer respects reduced-motion preferences', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seed(page, { id: 'reduced-motion', status: 'downloading' });
    await refresh(page);
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

test('History info panel keeps its details aligned and copies the source URL', async ({ page }) => {
    const url = 'https://fixture.invalid/info-panel';
    await seed(page, {
        id: 'info-panel', status: 'finished', file: true,
        name: 'aligned.mp4', title: 'Aligned information', url,
    });
    await refresh(page);

    const row = page.locator('[data-row-id="info-panel"]');
    await openInfo(row);
    const popover = row.locator('.history-info-popover');
    const header = popover.locator('.history-info-header');

    await expect(header.locator('.history-info-heading')).toHaveText('INFO');
    await expect(header.locator('.history-info-heading use')).toHaveAttribute('href', '#i-info');

    const layout = await popover.evaluate(element => {
        const content = element.querySelector('.history-info-content');
        const headerElement = element.querySelector('.history-info-header');
        const title = element.querySelector('.history-info-title');
        const tags = element.querySelector('.history-info-section');
        const file = element.querySelector('.history-file-section');
        const visibility = element.querySelector('.history-visibility-section');
        const status = element.querySelector('.history-status-row');
        const source = element.querySelector('.history-source-section');
        const rect = node => node.getBoundingClientRect();
        return {
            topGap: Math.round(rect(headerElement).top - rect(content).top),
            firstLineGap: Math.round(rect(title).top - rect(headerElement).bottom),
            ordered: rect(tags).top < rect(file).top
                && rect(file).top < rect(visibility).top
                && rect(visibility).top < rect(source).top
                && rect(source).top < rect(status).top,
            fileWidthDifference: Math.abs(
                rect(file.querySelector('.rename-wrap')).width
                - rect(visibility.querySelector('select')).width
            ),
            fileHeight: Math.round(rect(file.querySelector('.rename-wrap')).height),
            visibilityHeight: Math.round(rect(visibility.querySelector('select')).height),
        };
    });
    expect(Math.abs(layout.topGap - layout.firstLineGap)).toBeLessThanOrEqual(1);
    expect(layout.ordered).toBe(true);
    expect(layout.fileWidthDifference).toBeLessThanOrEqual(1);
    expect(layout.fileHeight).toBe(layout.visibilityHeight);
    await expect(popover.locator('.history-file-section .history-info-label')).toHaveText('File');
    await expect(popover.locator('.history-source-section .history-info-label')).toHaveText('Original URL');
    await expect(popover.locator('.history-source-field > span')).toHaveText(url);

    const tagRow = popover.locator('.tag-display-row');
    const displayHeight = (await tagRow.boundingBox()).height;
    await tagRow.click();
    const tagInput = popover.locator('.tag-entry-input');
    await expect(tagInput).toBeFocused();
    const editorHeight = (await popover.locator('.tag-token-input').boundingBox()).height;
    expect(editorHeight).toBe(displayHeight);
    await tagInput.press('Escape');
    await expect(popover.locator('.tag-display-row')).toBeVisible();

    const copyButton = popover.getByRole('button', { name: 'Copy original URL', exact: true });
    await expect(copyButton).toHaveText('Copy');
    await copyButton.click();
    await expect(popover.getByRole('button', { name: 'Copied', exact: true }).locator('use')).toHaveAttribute('href', '#i-check');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
});

test('History info shows the downloader and changes video visibility', async ({ page }) => {
    await seed(page, {
        id: 'visibility-row', status: 'finished', file: true,
        name: 'visibility.mp4', title: 'Visibility controls',
    });
    await refresh(page);

    const row = page.locator('[data-row-id="visibility-row"]');
    await openInfo(row);
    const popover = row.locator('.history-info-popover');
    await expect(popover.locator('.history-owner-row')).toHaveText(
        'Downloaded by: admin · NEW');

    const visibility = popover.getByLabel('Visibility');
    await expect(visibility).toHaveValue('public');
    await visibility.selectOption('private');
    await expect(visibility).toHaveValue('private');
    await expect(popover.locator('.history-visibility-help')).toHaveText(
        'Visible only to you and administrators');

    const rows = await page.request.get('/api/history').then(response => response.json());
    expect(rows.find(item => item.id === 'visibility-row').visibility).toBe('private');
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

test('Copy URL stays in Info and is omitted from the three-dot menu', async ({ page }) => {
    await page.clock.install();
    const url = 'https://fixture.invalid/copy';
    await seed(page, { id: 'copy0001', status: 'finished', file: true, url });
    await refresh(page);
    const row = page.locator('[data-row-id="copy0001"]');
    await row.locator('.kebab-btn').click();
    await expect(row.locator('.kebab-menu').getByRole('button', { name: 'Copy URL', exact: true })).toHaveCount(0);
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await row.getByRole('button', { name: 'Copy original URL', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Copied', exact: true }).locator('use')).toHaveAttribute('href', '#i-check');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await page.clock.fastForward(1600);
    await expect(row.getByRole('button', { name: 'Copy original URL', exact: true })).toBeVisible();
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

test('stored URL remains data for Open, Reload, Continue, and Info Copy actions', async ({ page }) => {
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

    const dialogTop = await row.locator('.history-info-popover').evaluate(element => (
        element.getBoundingClientRect().top
    ));
    const headerBottom = await page.locator('#appHeader').evaluate(element => (
        element.getBoundingClientRect().bottom
    ));
    expect(dialogTop).toBeGreaterThan(headerBottom);

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
    const preview = card.locator('.history-preview');
    await expect(preview).toBeVisible();
    await expect(preview).not.toHaveAttribute('title', /.+/);
    await expect(card.locator('.favorite-toggle')).toHaveAttribute(
        'title', 'Add to favorites');
    await expect(card.locator('.history-card-title')).toHaveText('Preview title');
    await expect(card.locator('.history-info-popover')).toBeHidden();
    const children = await card.locator(':scope > *').evaluateAll(elements =>
        elements.map(element => element.className));
    expect(children[0]).toContain('history-preview-wrap');
    await expect(card.locator('.history-preview-play')).toHaveCount(0);
    await preview.focus();
    await expect(preview).toHaveCSS('outline-style', 'solid');

    await preview.click();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/preview01');
});

test('History preview labels show compact quality and clear new after playback', async ({ page }) => {
    await seed(page, {
        id: 'quality-4k', status: 'finished', file: true,
        name: 'quality-4k.mp4', resolution: '3840x2160',
    });
    await seed(page, {
        id: 'quality-hd', status: 'finished', file: true,
        name: 'quality-hd.mp4', resolution: '720p',
    });
    await refresh(page);

    const fourK = page.locator('[data-row-id="quality-4k"]');
    const hd = page.locator('[data-row-id="quality-hd"]');
    await expect(fourK.locator('.history-preview-quality')).toHaveText('4k');
    await expect(fourK.locator('.history-preview-new')).toHaveText('new');
    await expect(fourK.locator('.history-preview-new')).toHaveCSS(
        'background-color', 'rgba(31, 138, 59, 0.52)');
    await expect(fourK.locator('.history-preview-quality')).toHaveCSS(
        'background-color', 'rgba(31, 138, 59, 0.52)');
    await expect(hd.locator('.history-preview-quality')).toHaveText('720p');
    await expect(hd.locator('.history-preview-quality')).toHaveCSS(
        'background-color', 'rgba(0, 0, 0, 0.52)');

    await fourK.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(async () => {
        const rows = await page.request.get('/api/history').then(response => response.json());
        return rows.find(row => row.id === 'quality-4k').view_count;
    }).toBe(1);
    await expect(fourK.locator('.history-preview-new')).toHaveCount(0);
    await expect(hd.locator('.history-preview-new')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await openInfo(fourK);
    await expect(fourK.locator('.history-owner-row')).toHaveText(
        'Downloaded by: admin · Views: 1');
});

test('hover previews wait before loading and only play one montage at a time', async ({ page }) => {
    await seed(page, {
        id: 'hover01', status: 'finished', file: true,
        name: 'hover-one.mp4', title: 'Hover one',
    });
    await seed(page, {
        id: 'hover02', status: 'finished', file: true,
        name: 'hover-two.mp4', title: 'Hover two',
    });
    await refresh(page);
    await page.evaluate(() => {
        window.__hoverPreviewPlays = 0;
        window.__hoverPreviewPauses = 0;
        HTMLMediaElement.prototype.load = function () {};
        HTMLMediaElement.prototype.play = function () {
            window.__hoverPreviewPlays += 1;
            this.dispatchEvent(new Event('playing'));
            return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function () {
            window.__hoverPreviewPauses += 1;
        };
    });

    const first = page.locator('[data-row-id="hover01"] .history-preview');
    const second = page.locator('[data-row-id="hover02"] .history-preview');
    const firstVideo = first.locator('.history-preview-video');
    const secondVideo = second.locator('.history-preview-video');
    // The browser fixture stores sentinel bytes instead of real video, so its
    // thumbnail endpoint intentionally fails. Clear that unrelated fallback
    // state to exercise the hover lifecycle in isolation.
    await expect(first).toHaveClass(/thumbnail-unavailable/);
    await expect(second).toHaveClass(/thumbnail-unavailable/);
    await first.evaluate(element => element.classList.remove('thumbnail-unavailable'));
    await second.evaluate(element => element.classList.remove('thumbnail-unavailable'));
    await expect(firstVideo).not.toHaveAttribute('src', /./);

    await first.hover();
    await page.waitForTimeout(300);
    await expect(firstVideo).not.toHaveAttribute('src', /./);
    expect(await page.evaluate(() => window.__hoverPreviewPlays)).toBe(0);
    await expect.poll(() => page.evaluate(() => window.__hoverPreviewPlays)).toBe(1);
    await expect(firstVideo).toHaveAttribute('src', '/api/preview/hover01?v=3');
    await expect(first).toHaveClass(/preview-playing/);

    await page.locator('[data-row-id="hover01"] .favorite-toggle').hover();
    await expect(firstVideo).toHaveAttribute('src', '/api/preview/hover01?v=3');
    await expect(first).toHaveClass(/preview-playing/);
    expect(await page.evaluate(() => window.__hoverPreviewPauses)).toBe(0);

    await second.hover();
    await expect(firstVideo).not.toHaveAttribute('src', /./);
    await expect(first).not.toHaveClass(/preview-playing/);
    await expect.poll(() => page.evaluate(() => window.__hoverPreviewPlays)).toBe(2);
    await expect(secondVideo).toHaveAttribute('src', '/api/preview/hover02?v=3');
    await expect(second).toHaveClass(/preview-playing/);

    await page.locator('.app-header').hover();
    await expect(secondVideo).not.toHaveAttribute('src', /./);
    await expect(second).not.toHaveClass(/preview-playing/);
    expect(await page.evaluate(() => window.__hoverPreviewPauses)).toBeGreaterThan(0);
});

test('reduced motion keeps history previews static', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seed(page, {
        id: 'hover-reduced', status: 'finished', file: true,
        name: 'hover-reduced.mp4', title: 'Reduced motion',
    });
    await refresh(page);

    const preview = page.locator('[data-row-id="hover-reduced"] .history-preview');
    const video = preview.locator('.history-preview-video');
    await expect(preview).toHaveClass(/thumbnail-unavailable/);
    await preview.evaluate(element => element.classList.remove('thumbnail-unavailable'));
    await page.evaluate(() => {
        window.__reducedMotionPreviewPlays = 0;
        HTMLMediaElement.prototype.load = function () {};
        HTMLMediaElement.prototype.play = function () {
            window.__reducedMotionPreviewPlays += 1;
            return Promise.resolve();
        };
    });
    await preview.hover();
    await page.waitForTimeout(600);
    await expect(video).not.toHaveAttribute('src', /./);
    await expect(preview).not.toHaveClass(/preview-loading|preview-playing/);
    expect(await page.evaluate(() => window.__reducedMotionPreviewPlays)).toBe(0);
});

test('favorite sorting runs on reload and filtering without moving a clicked card', async ({ page }) => {
    await seed(page, {
        id: 'favorite-old', status: 'finished', file: true,
        name: 'favorite-old.mp4', title: 'Older video',
    });
    await seed(page, {
        id: 'favorite-new', status: 'finished', file: true,
        name: 'favorite-new.mp4', title: 'Newer video',
    });
    await refresh(page);

    const cards = page.locator('#historyList [data-row-id]');
    await expect(cards.first()).toHaveAttribute('data-row-id', 'favorite-new');

    const oldCard = page.locator('[data-row-id="favorite-old"]');
    const star = oldCard.getByRole('button', { name: 'Add to favorites' });
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await expect(star.locator('svg')).toHaveCSS('fill', 'none');
    await expect(star).toHaveCSS('color', 'rgb(154, 160, 166)');
    await expect(star).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await star.focus();
    await expect(star).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await star.hover();
    await page.waitForTimeout(200);
    const starBackground = await star
        .evaluate(element => getComputedStyle(element).backgroundColor);
    const starAlpha = Number(starBackground.match(/[\d.]+(?=\)$)/)[0]);
    expect(starAlpha).toBeGreaterThan(0.5);
    expect(starAlpha).toBeLessThan(0.6);
    await star.click();

    await expect(cards.first()).toHaveAttribute('data-row-id', 'favorite-new');
    const selectedStar = page.locator('[data-row-id="favorite-old"]')
        .getByRole('button', { name: 'Remove from favorites' });
    await expect(selectedStar).toHaveAttribute('aria-pressed', 'true');
    expect(await selectedStar.locator('svg').evaluate(element => {
        const style = getComputedStyle(element);
        return style.fill === style.color;
    })).toBeTruthy();

    await page.reload();
    await expect(cards.first()).toHaveAttribute('data-row-id', 'favorite-old');

    await page.locator('#historySearchToggle').click();
    await page.locator('#historySearchInput').fill('video');
    await expect(cards.first()).toHaveAttribute('data-row-id', 'favorite-old');

    await selectedStar.click();
    await expect(cards.first()).toHaveAttribute('data-row-id', 'favorite-old');
    await page.locator('#historySearchClear').click();
    await expect(cards.first()).toHaveAttribute('data-row-id', 'favorite-new');
    await expect(page.locator('[data-row-id="favorite-old"]')
        .getByRole('button', { name: 'Add to favorites' }))
        .toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await expect(cards.first()).toHaveAttribute('data-row-id', 'favorite-new');
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
    await openSettings(page);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear History', exact: true }).click();
    await expect(page.locator('[data-row-id="clear001"]')).toHaveCount(0);
    expect((await page.request.get('/api/file/clear001')).status()).toBe(404);
});

test('Clear History leaves resumable Current rows intact', async ({ page }) => {
    await seed(page, { id: 'finished1', status: 'finished', file: true });
    await seed(page, { id: 'cancelled1', status: 'cancelled', progress: 'Stopped' });
    await openSettings(page);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear History', exact: true }).click();
    await page.getByRole('button', { name: 'Back to videos', exact: true }).click();
    await openCurrent(page);
    await expect(page.locator('[data-row-id="cancelled1"]')).toBeVisible();
});
