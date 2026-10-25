const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`real media prebuffers and continues through a fullscreen overlap (${reducedMotion})`, async ({ page }) => {
        test.setTimeout(20_000);
        await reset(page);
        await page.emulateMedia({ reducedMotion });
        for (const id of ['real-old', 'real-current']) {
            await seed(page, {
                id, name: `${id}.webm`, status: 'finished', file: true,
                media_fixture: 'crossfade', resolution: '90p',
                duration_seconds: 14, media_metadata_probed: true,
            });
        }
        await refresh(page);
        await expect(page.locator('[data-row-id="real-current"]')).toBeVisible();
        await page.locator('#endlessPlaybackButton').click();
        await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
        await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(0);
        await page.evaluate(() => {
            window.__outgoingVideo = document.getElementById('playerVideo');
            window.__outgoingVideo.volume = 0.7;
            window.__outgoingVideo.currentTime = 4.2;
        });
        await expect(page.locator('#playerStandby source')).toHaveAttribute('src', '/api/file/real-old');
        await expect.poll(() => page.locator('#playerStandby').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
        expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
        // Request fullscreen from a real click, so both pictures share one surface.
        await page.mouse.move(500, 350);
        await page.getByRole('button', { name: 'Fullscreen', exact: true }).click({ force: true });
        await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerMediaStage');
        await page.evaluate(() => { window.__outgoingVideo.currentTime = 10.8; });
        await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true).catch(async error => {
            console.log('Media handoff state:', await page.evaluate(() => ({
                phase: endlessPlayback.phase, presentation: endlessPlayback.presentation,
                disabled: playerPreparation?.disabled, committing: playerPreparation?.committing,
                item: playerPreparation?.item?.id, response: playerPreparation?.response?.status,
                videos: [...document.querySelectorAll('#playerMediaStage video')].map(video => ({
                    id: video.id, time: video.currentTime, duration: video.duration,
                    ready: video.readyState, paused: video.paused, seeking: video.seeking,
                    error: video.error?.message,
                })),
            })));
            throw error;
        });
        expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
        expect(await page.evaluate(() => window.__outgoingVideo.paused)).toBe(false);
        await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(0.5);
        const blend = await page.evaluate(() => ({
            opacity: Number(document.getElementById('playerVideo').style.opacity),
            oldVolume: window.__outgoingVideo.volume,
            newVolume: document.getElementById('playerVideo').volume,
        }));
        if (reducedMotion === 'reduce') expect(blend.opacity).toBe(1);
        else {
            expect(blend.opacity).toBeGreaterThan(0);
            expect(blend.opacity).toBeLessThan(1);
        }
        expect(blend.oldVolume).toBeLessThan(0.7);
        expect(blend.newVolume).toBeGreaterThan(0);
        await expect.poll(() => page.evaluate(() => playerPreparation === null), {
            timeout: 4500, intervals: [100],
        }).toBe(true);
        const elapsed = await page.locator('#playerVideo').evaluate(video => video.currentTime);
        expect(elapsed).toBeGreaterThan(2.5);
        expect(elapsed).toBeLessThan(4.5);
        await expect(page.locator('#playerStandby source')).toHaveCount(0);
        expect(await page.locator('#playerVideo').evaluate(video => video.volume)).toBeCloseTo(0.7);
        expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('playerMediaStage');
        await page.getByRole('button', { name: 'Close fullscreen player' }).click();
        await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
        await expect(page.locator('#playerMediaStage source')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    });
}

test('real Shuffle Clips preloads the random position and continues through consecutive five-second overlaps', async ({ page }) => {
    test.setTimeout(25_000);
    await reset(page);
    await page.evaluate(() => { Math.random = () => 0; });
    for (const id of ['real-clip-one', 'real-clip-two']) {
        await seed(page, {
            id, name: `${id}.webm`, status: 'finished', file: true,
            media_fixture: 'crossfade', resolution: '90p', duration_seconds: 14,
            media_metadata_probed: true,
        });
    }
    await refresh(page);
    await page.getByRole('button', { name: 'Choose playback mode' }).click();
    await page.getByRole('menuitem', { name: 'Shuffle Clips', exact: true }).click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await expect.poll(() => page.locator('#playerStandby').evaluate(video => playerBoundaries.get(video)?.ready)).toBe(true);
    const initial = await page.locator('#playerVideo').evaluate(video => {
        const bounds = playerBoundaries.get(video);
        return { start: bounds.start, end: bounds.end, time: video.currentTime };
    });
    expect(initial.end - initial.start).toBeCloseTo(5);
    expect(initial.time).toBeGreaterThanOrEqual(initial.start);
    const prepared = await page.locator('#playerStandby').evaluate(video => {
        const bounds = playerBoundaries.get(video);
        return { start: bounds.start, end: bounds.end, time: video.currentTime };
    });
    expect(prepared.time).toBeCloseTo(prepared.start, 1);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade)), {
        timeout: 5000, intervals: [50],
    }).toBe(true);
    const committedBounds = await page.locator('#playerVideo').evaluate(video => {
        const bounds = playerBoundaries.get(video);
        return { start: bounds.start, end: bounds.end };
    });
    expect(committedBounds).toEqual({ start: prepared.start, end: prepared.end });
    await expect.poll(() => page.locator('#playerVideo').evaluate(video =>
        video.currentTime - playerBoundaries.get(video).start)).toBeGreaterThan(0.5);
    const overlap = await page.evaluate(() => ({
        opacity: Number(document.getElementById('playerVideo').style.opacity),
        gains: [playerPreparation.outgoing.volume, playerPreparation.incoming.volume],
        playing: !playerPreparation.outgoing.paused && !playerPreparation.incoming.paused,
    }));
    expect(overlap.opacity).toBeGreaterThan(0);
    expect(overlap.opacity).toBeLessThan(1);
    expect(overlap.gains[0]).toBeGreaterThan(0);
    expect(overlap.gains[0]).toBeLessThan(1);
    expect(overlap.gains[1]).toBeGreaterThan(0);
    expect(overlap.gains[1]).toBeLessThan(1);
    expect(overlap.playing).toBe(true);
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence), {
        timeout: 7000, intervals: [50],
    }).toBeGreaterThanOrEqual(2);
    expect(await page.locator('#playerMediaStage video').count()).toBe(2);
    const continued = await page.locator('#playerVideo').evaluate(video => ({
        time: video.currentTime, start: playerBoundaries.get(video).start,
        end: playerBoundaries.get(video).end,
    }));
    expect(continued.time).toBeGreaterThanOrEqual(continued.start);
    expect(continued.time).toBeLessThanOrEqual(continued.end);
    await page.evaluate(() => closePlayer());
    await expect(page.locator('#playerMediaStage source')).toHaveCount(0);
});
