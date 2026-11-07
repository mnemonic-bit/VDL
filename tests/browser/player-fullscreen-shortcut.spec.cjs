const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => {
    await reset(page);
    await seed(page, {
        id: 'fullscreen-shortcut', name: 'fullscreen-shortcut.webm', status: 'finished',
        file: true, media_fixture: 'crossfade', resolution: '720p',
        duration_seconds: 14, media_metadata_probed: true,
    });
    await refresh(page);
    await page.locator('[data-row-id="fullscreen-shortcut"]')
        .getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime))
        .toBeGreaterThan(0);
    await page.locator('#playerContainer').evaluate(container => {
        const requestFullscreen = container.requestFullscreen.bind(container);
        window.__shortcutFullscreenRequests = 0;
        container.requestFullscreen = (...args) => {
            window.__shortcutFullscreenRequests += 1;
            return requestFullscreen(...args);
        };
    });
});

async function tabTo(page, id) {
    for (let index = 0; index < 20; index++) {
        if (await page.locator(`#${id}`).evaluate(control => control === document.activeElement)) return;
        await page.keyboard.press('Tab');
    }
    await expect(page.locator(`#${id}`)).toBeFocused();
}

async function expectFullscreen(page, paused) {
    await page.keyboard.press('f');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id || null))
        .toBe('playerContainer');
    expect(await page.evaluate(() => window.__shortcutFullscreenRequests)).toBe(1);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(paused);
    await page.keyboard.press('f');
    expect(await page.evaluate(() => window.__shortcutFullscreenRequests)).toBe(1);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(paused);
}

for (const paused of [false, true]) {
    for (const control of ['playback', 'seek', 'volume', 'speed']) {
        test(`F enters fullscreen after ${control} interaction while ${paused ? 'paused' : 'playing'}`, async ({ page }) => {
            await page.locator('#playerPlayPause').click();
            if (!paused) await page.locator('#playerPlayPause').click();
            if (control === 'playback') {
                await expect(page.locator('#playerPlayPause')).toBeFocused();
            } else if (control === 'seek') {
                await page.locator('#playerSeek').click({ position: { x: 40, y: 5 } });
                await expect(page.locator('#playerSeek')).toBeFocused();
                const before = Number(await page.locator('#playerSeek').inputValue());
                await page.keyboard.press('ArrowRight');
                expect(Number(await page.locator('#playerSeek').inputValue())).toBeGreaterThan(before);
            } else if (control === 'volume') {
                await tabTo(page, 'playerVolume');
                await page.keyboard.press('ArrowLeft');
                await expect(page.locator('#playerVolume')).toHaveValue('99');
                await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.volume)).toBeCloseTo(0.99);
            } else {
                await tabTo(page, 'playerSpeed');
                // A closed native select also accepts arrow-key selection.
                // Headless Firefox cannot drive options in its OS popup.
                await page.keyboard.press('ArrowDown');
                await expect(page.locator('#playerSpeed')).toBeFocused();
                await expect(page.locator('#playerSpeed')).toHaveValue('1.25');
                expect(await page.locator('#playerSpeed').evaluate(select => select.matches(':open'))).toBe(false);
                expect(await page.locator('#playerVideo').evaluate(video => video.playbackRate)).toBe(1.25);
            }
            await expectFullscreen(page, paused);
        });
    }
}

test('native Space and Enter activate the focused playback button once', async ({ page }) => {
    await page.locator('#playerPlayPause').click();
    await page.keyboard.press('Space');
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    await page.keyboard.press('Enter');
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    expect(await page.evaluate(() => window.__shortcutFullscreenRequests)).toBe(0);
});

test('an open speed selector keeps native keyboard input', async ({ page }) => {
    await page.locator('#playerPlayPause').click();
    await tabTo(page, 'playerSpeed');
    await page.keyboard.press('Space');
    await expect.poll(() => page.locator('#playerSpeed').evaluate(select => select.matches(':open'))).toBe(true);
    await page.keyboard.press('f');
    expect(await page.evaluate(() => window.__shortcutFullscreenRequests)).toBe(0);
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
});

test('editable fields, repeat, modifiers, and a closed player do not request fullscreen', async ({ page }) => {
    await page.locator('#playerPlayPause').click();
    for (const key of ['Control+f', 'Meta+f', 'Alt+f']) await page.keyboard.press(key);
    await page.locator('#playerPlayPause').dispatchEvent('keydown', { key: 'f', repeat: true });
    expect(await page.evaluate(() => window.__shortcutFullscreenRequests)).toBe(0);
    await page.locator('#playerContainer').evaluate(container => {
        const editor = document.createElement('div');
        editor.id = 'shortcutEditor';
        editor.contentEditable = 'true';
        editor.textContent = 'Edit';
        container.appendChild(editor);
    });
    await page.locator('#shortcutEditor').click();
    await page.keyboard.press('f');
    await expect(page.locator('#shortcutEditor')).toContainText('f');
    expect(await page.evaluate(() => window.__shortcutFullscreenRequests)).toBe(0);
    await page.locator('.player-close').click();
    const consumed = await page.evaluate(() => {
        const event = new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
    });
    expect(consumed).toBe(false);
    expect(await page.evaluate(() => window.__shortcutFullscreenRequests)).toBe(0);
});
