const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, openSettings } = require('./support.cjs');

test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.__downloadEntryErrors = errors;
    await reset(page);
});

test.afterEach(async ({ page }) => {
    expect(page.__downloadEntryErrors).toEqual([]);
});

test('header has no New download Plus button', async ({ page }) => {
    await expect(page.locator('#newDownloadButton')).toHaveCount(0);
    await expect(page.locator('#appHeader').getByRole('button', { name: 'New download', exact: true })).toHaveCount(0);
});

for (const width of [1280, 390]) {
    for (const theme of ['light', 'dark']) {
        test(`header leaves no empty Plus slot at ${width}px in ${theme} theme`, async ({ page }) => {
            await page.setViewportSize({ width, height: 850 });
            await page.evaluate(theme => applyTheme(theme), theme);
            for (const active of [false, true]) {
                if (active) {
                    await seed(page, { id: 'header-active', status: 'downloading' });
                    await refresh(page);
                }
                const layout = await page.locator('.header-actions').evaluate(header => {
                    const controls = Array.from(header.children).filter(child => child.getClientRects().length);
                    return {
                        controls: controls.map(child => child.id || child.className),
                        gaps: controls.slice(1).map((child, i) => (
                            child.getBoundingClientRect().left - controls[i].getBoundingClientRect().right
                        )),
                        right: header.getBoundingClientRect().right,
                    };
                });
                expect(layout.controls).toEqual([
                    'historySearch', 'playbackModeControl', 'createPlaylistButton',
                    ...(active ? ['currentDownloadsButton'] : []), 'account-menu-wrap',
                ]);
                for (const gap of layout.gaps) expect(gap).toBeCloseTo(8, 0);
                expect(layout.right).toBeLessThanOrEqual(width);
            }
        });
    }
}

// ControlOrMeta sends Ctrl on Linux/Windows and Cmd on macOS, allowing the
// browser's native paste action to populate the field on the supported OS.
async function paste(page, text) {
    await page.evaluate(text => navigator.clipboard.writeText(text), text);
    await page.keyboard.press('ControlOrMeta+v');
}

for (const close of ['Escape', 'button', 'backdrop']) {
    test(`native paste opens and populates Download; ${close} restores focus and draft`, async ({ page }) => {
        const trigger = page.locator('#createPlaylistButton');
        const dialog = page.locator('#newDownloadDialog');
        const url = 'https://fixture.invalid/shortcut';
        await trigger.focus();
        await paste(page, url);
        await expect(dialog).toBeVisible();
        await expect(page.locator('#urlInput')).toBeFocused();
        await expect(page.locator('#urlInput')).toHaveValue(url);
        await expect(page.locator('#optionsQualitySelect')).toBeEnabled();
        if (close === 'Escape') await page.keyboard.press('Escape');
        else if (close === 'button') await dialog.getByRole('button', { name: 'Close new download' }).click();
        else await page.mouse.click(2, 2);
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
        // The empty-library action must still open the same preserved draft.
        await page.locator('#historyEmptyAction').click();
        await expect(page.locator('#urlInput')).toHaveValue(url);
    });
}

test('native paste from the page submits a download and restores usable focus', async ({ page }) => {
    const url = 'https://fixture.invalid/clipboard-entry';
    await page.request.post('/__test__/hold-downloads');
    try {
        await page.locator('.app-title').click();
        await paste(page, url);
        await expect(page.locator('#urlInput')).toHaveValue(url);
        await expect(page.locator('#downloadSubmit')).toBeEnabled();
        await page.locator('#downloadSubmit').click();
        await expect(page.locator('#newDownloadDialog')).toBeHidden();
        await expect(page.locator('#accountMenuButton')).toBeFocused();
        await expect(page.locator('#currentBadge')).toHaveText('1');
        const current = await (await page.request.get('/api/current-downloads')).json();
        expect(current).toHaveLength(1);
        expect(current[0].url).toBe(url);
    } finally {
        await page.request.post('/__test__/release-downloads');
    }
});

for (const tag of ['input', 'textarea', 'contenteditable']) {
    test(`native paste in ${tag} retains normal editing`, async ({ page }) => {
        await page.evaluate(tag => {
            const editor = document.createElement(tag === 'contenteditable' ? 'div' : tag);
            editor.id = 'pasteEditor';
            if (tag === 'contenteditable') editor.contentEditable = 'true';
            document.getElementById('tab-history').append(editor);
            editor.focus();
        }, tag);
        const text = 'https://fixture.invalid/editable';
        await paste(page, text);
        const editor = page.locator('#pasteEditor');
        if (tag === 'contenteditable') await expect(editor).toHaveText(text);
        else await expect(editor).toHaveValue(text);
        await expect(editor).toBeFocused();
        await expect(page.locator('#newDownloadDialog')).toBeHidden();
    });
}

for (const unavailable of ['hidden', 'removed']) {
    test(`closing Download restores fallback focus when its source is ${unavailable}`, async ({ page }) => {
        await page.locator('#createPlaylistButton').focus();
        await paste(page, 'https://fixture.invalid/focus');
        await page.locator('#createPlaylistButton').evaluate((button, unavailable) => {
            if (unavailable === 'removed') button.remove();
            else button.hidden = true;
        }, unavailable);
        await page.keyboard.press('Escape');
        await expect(page.locator('#newDownloadDialog')).toBeHidden();
        await expect(page.locator('#accountMenuButton')).toBeFocused();
    });
}

test('Current downloads falls back to the account button when its trigger disappears', async ({ page }) => {
    await seed(page, { id: 'focus-current', status: 'downloading' });
    await refresh(page);
    await openCurrent(page);
    await seed(page, { id: 'focus-current', status: 'finished' });
    await refresh(page);
    await expect(page.locator('#currentDownloadsButton')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#currentDownloadsDrawer')).toBeHidden();
    await expect(page.locator('#accountMenuButton')).toBeFocused();
});

for (const workflow of ['Current downloads', 'Settings']) {
    test(`paste does not stack Download over ${workflow}`, async ({ page }) => {
        if (workflow === 'Current downloads') {
            await seed(page, { id: 'guard-current', status: 'downloading' });
            await refresh(page);
            await openCurrent(page);
            await page.getByRole('button', { name: 'Close current downloads' }).focus();
        } else {
            await openSettings(page);
            await page.locator('#settingsBackButton').focus();
        }
        await paste(page, 'https://fixture.invalid/guarded');
        await expect(page.locator('#newDownloadDialog')).toBeHidden();
    });
}
