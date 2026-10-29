const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => {
    await reset(page);
    await page.request.post('/api/preferences', { data: { skip_video_edges: true } });
    await page.evaluate(() => loadPreferences());
    for (const id of ['edges-real-old', 'edges-real-current']) {
        await seed(page, {
            id, name: `${id}.webm`, status: 'finished', file: true,
            media_fixture: 'edges', duration_seconds: 30, media_metadata_probed: true,
        });
    }
    await refresh(page);
});

test('real playback starts beyond the intro and pauses on the original timeline before the outro', async ({ page }) => {
    await page.evaluate(() => {
        window.__edgeFirstTimes = [];
        for (const video of document.querySelectorAll('#playerMediaStage video')) {
            video.addEventListener('playing', () => window.__edgeFirstTimes.push(video.currentTime));
        }
        playVideo('edges-real-current', 'Real edges', 'webm');
    });
    await expect.poll(() => page.evaluate(() => window.__edgeFirstTimes.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__edgeFirstTimes[0])).toBeGreaterThanOrEqual(10);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(10);
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = 19.8; });
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', true);
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(20, 1);
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    await page.evaluate(() => togglePlayerPlayback());
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThanOrEqual(10);
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeLessThan(13);
    expect(await page.locator('#playerVideo').evaluate(video => video.duration)).toBeCloseTo(30, 0);
});

test('real fullscreen crossfade prebuffers at the incoming start and retains its elapsed media time', async ({ page }) => {
    test.setTimeout(15_000);
    await page.locator('#endlessPlaybackButton').click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await expect.poll(() => page.locator('#playerStandby').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
    await expect.poll(() => page.locator('#playerStandby').evaluate(video => video.seeking)).toBe(false);
    expect(await page.locator('#playerStandby').evaluate(video => video.currentTime)).toBeCloseTo(10, 1);
    await page.mouse.move(500, 350);
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click({ force: true });
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
    await page.evaluate(() => {
        window.__edgeOutgoing = document.getElementById('playerVideo');
        window.__edgeOutgoing.currentTime = 16.8;
    });
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await page.evaluate(() => {
        window.__edgeFade = playerPreparation;
        window.__edgeOutgoingEmptied = false;
        window.__edgeOutgoing.addEventListener('emptied', () => {
            window.__edgeOutgoingEmptied = true;
        }, { once: true });
    });
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(10);
    // A trimmed successor can immediately prepare another item. Track this
    // overlap's completion instead of requiring a gap between preparations.
    await expect.poll(() => page.evaluate(() => !window.__edgeFade.fade
        && playerPreparation !== window.__edgeFade), {
        timeout: 4500, intervals: [100],
    }).toBe(true);
    const time = await page.locator('#playerVideo').evaluate(video => video.currentTime);
    expect(time).toBeGreaterThan(12.5);
    expect(time).toBeLessThan(14.5);
    await expect.poll(() => page.evaluate(() => window.__edgeOutgoingEmptied)).toBe(true);
    expect(await page.evaluate(() => window.__edgeOutgoing.paused)).toBe(true);
    await expect(page.locator('#playerStandby')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
});
