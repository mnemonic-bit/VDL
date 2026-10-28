const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

async function startHeldClips(page, hold = 'response') {
    await reset(page);
    await page.evaluate(() => { Math.random = () => 0; });
    if (hold === 'seek') await page.evaluate(() => {
        const seeking = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'seeking');
        const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        const held = new Set();
        Object.defineProperty(HTMLMediaElement.prototype, 'seeking', {
            configurable: true,
            get() { return held.has(this) || seeking.get.call(this); },
        });
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
            configurable: true,
            get: time.get,
            set(value) {
                if (this.id === 'playerStandby' && value > 0) held.add(this);
                time.set.call(this, value);
            },
        });
        document.addEventListener('seeked', event => {
            if (held.has(event.target)) event.stopImmediatePropagation();
        }, true);
        window.__releaseClipSeek = () => {
            for (const video of held) {
                held.delete(video);
                video.dispatchEvent(new Event('seeked'));
                video.dispatchEvent(new Event('canplay'));
            }
        };
    });
    for (const id of ['continuity-one', 'continuity-two']) {
        await seed(page, {
            id, name: `${id}.webm`, status: 'finished', file: true,
            media_fixture: id === 'continuity-one' ? 'crossfade' : 'clips-red',
            resolution: '90p', duration_seconds: 14,
            media_metadata_probed: true,
        });
    }
    let first;
    let incomingUrl;
    let releaseNext;
    const nextGate = new Promise(resolve => { releaseNext = resolve; });
    let held;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    if (hold === 'confirmation') await page.route('**/api/playback-sessions/*/advance', async route => {
        const response = await route.fetch();
        held = true;
        await gate;
        await route.fulfill({ response });
    });
    await page.route('**/api/file/*', async route => {
        const url = route.request().url();
        if (!first) first = url;
        if (url === first && !incomingUrl) return route.continue();
        if (!incomingUrl) incomingUrl = url;
        if (hold !== 'confirmation') held = true;
        if (url !== incomingUrl) await nextGate;
        else if (hold === 'response') await gate;
        await route.continue();
    });
    await refresh(page);
    await page.evaluate(() => startEndlessPlayback(null, '', '', 'shuffle_clips'));
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    if (hold === 'response') await expect.poll(() => held).toBe(true);
    if (hold === 'seek') {
        await expect.poll(() => page.locator('#playerStandby').evaluate(video => video.seeking)).toBe(true);
        await expect.poll(() => page.locator('#playerStandby').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
        expect(await page.locator('#playerStandby').evaluate(video => playerBoundaries.get(video).ready)).toBe(false);
    }
    if (hold === 'confirmation' || hold === 'early') {
        await expect.poll(() => page.locator('#playerStandby').evaluate(video => playerBoundaries.get(video).ready)).toBe(true);
    }
    await page.evaluate(() => {
        window.__continuityOutgoing = document.getElementById('playerVideo');
        window.__continuityEnd = playerBoundaries.get(window.__continuityOutgoing).end;
        window.__continuityOutgoing.controls = false;
        window.__continuityPromotions = 0;
        new MutationObserver(records => {
            window.__continuityPromotions += records.filter(record =>
                record.oldValue === 'playerStandby' && record.target.id === 'playerVideo').length;
        }).observe(document.getElementById('playerMediaStage'), {
            subtree: true, attributes: true, attributeFilter: ['id'], attributeOldValue: true,
        });
    });
    return {
        release: async () => {
            release();
            if (hold === 'seek') await page.evaluate(() => window.__releaseClipSeek());
        },
        releaseNext,
        outgoingChannel: first.endsWith('continuity-one') ? 2 : 0,
    };
}

test('ready clips wait for the schedule and distinct pictures overlap through consecutive short clips', async ({ page }) => {
    test.setTimeout(20_000);
    const { release, releaseNext } = await startHeldClips(page, 'early');
    try {
        expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
        expect(await page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(false);
        await expect.poll(() => page.evaluate(() => endlessPlayback.sequence), { timeout: 5000 }).toBe(1);
        await expect.poll(() => page.locator('#playerVideo').evaluate(video =>
            video.currentTime - playerBoundaries.get(video).start)).toBeGreaterThan(0.6);
        const first = await picture(page);
        expect(first[0]).toBeGreaterThan(20);
        expect(first[2]).toBeGreaterThan(20);
        releaseNext();
        await expect.poll(() => page.evaluate(() => endlessPlayback.sequence), { timeout: 5000 }).toBe(2);
        await expect.poll(() => page.locator('#playerVideo').evaluate(video =>
            video.currentTime - playerBoundaries.get(video).start)).toBeGreaterThan(0.6);
        const second = await picture(page);
        expect(second[0]).toBeGreaterThan(20);
        expect(second[2]).toBeGreaterThan(20);
        expect(await page.evaluate(() => playerPreparation.incoming.paused || playerPreparation.outgoing.paused)).toBe(false);
        expect(await page.locator('#playerMediaStage video').count()).toBe(2);
    } finally {
        await release();
        releaseNext();
        await page.evaluate(() => closePlayer());
    }
});

test('pause while waiting keeps the outgoing picture and starts one fade only after resume', async ({ page }) => {
    const { release, releaseNext, outgoingChannel } = await startHeldClips(page);
    try {
        await page.evaluate(() => { window.__continuityOutgoing.currentTime = window.__continuityEnd - 0.3; });
        await expect.poll(() => page.evaluate(() => window.__continuityOutgoing.currentTime
            - window.__continuityEnd)).toBeGreaterThan(0.2);
        const pausedAt = await page.evaluate(() => {
            window.__continuityOutgoing.pause();
            return window.__continuityOutgoing.currentTime;
        });
        await release();
        await expect.poll(() => page.locator('#playerStandby').evaluate(video => playerBoundaries.get(video).ready)).toBe(true);
        expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
        expect(await page.evaluate(() => window.__continuityOutgoing.currentTime)).toBe(pausedAt);
        expect(await page.locator('#playerStandby').evaluate(video => video.paused)).toBe(true);
        expect((await picture(page))[outgoingChannel]).toBeGreaterThan(200);
        await page.evaluate(() => window.__continuityOutgoing.play());
        await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
        expect(await page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    } finally {
        await release();
        releaseNext();
        await page.evaluate(() => closePlayer());
    }
});

for (const action of ['close', 'stop', 'mode']) {
    test(`${action} cancels a waiting clip and ignores late media completion`, async ({ page }) => {
        const { release, releaseNext } = await startHeldClips(page);
        await page.evaluate(action => {
            if (action === 'close') closePlayer();
            else if (action === 'stop') stopEndlessPlayback();
            else startEndlessPlayback(null, '', '', 'shuffle');
        }, action);
        await release();
        releaseNext();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await page.evaluate(() => playerPreparation?.fade || false)).toBe(false);
        expect(await page.evaluate(() => document.getElementById('playerVideo') === window.__continuityOutgoing)).toBe(true);
        if (action === 'mode') {
            await expect.poll(() => page.evaluate(() => endlessPlayback.mode)).toBe('shuffle');
        } else {
            expect(await page.locator('#playerMediaStage source').count()).toBe(0);
            expect(await page.evaluate(() => endlessPlayback.active)).toBe(false);
        }
        await page.evaluate(() => closePlayer());
    });
}

test('natural EOF retains the last picture until the delayed successor is playable', async ({ page }) => {
    const { release, releaseNext, outgoingChannel } = await startHeldClips(page);
    try {
        await page.evaluate(() => { window.__continuityOutgoing.playbackRate = 16; });
        await expect.poll(() => page.evaluate(() => window.__continuityOutgoing.ended)).toBe(true);
        await page.evaluate(() => { window.__continuityOutgoing.playbackRate = 1; });
        expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
        expect((await picture(page))[outgoingChannel]).toBeGreaterThan(200);
        await release();
        await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
        await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
        expect((await picture(page))[2 - outgoingChannel]).toBeGreaterThan(200);
    } finally {
        await release();
        releaseNext();
        await page.evaluate(() => closePlayer());
    }
});

async function picture(page) {
    const png = await page.locator('#playerMediaStage').screenshot({
        style: 'video::-webkit-media-controls { display: none !important; }',
    });
    return page.evaluate(async png => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        return [...ctx.getImageData(image.width / 2, image.height / 2, 1, 1).data].slice(0, 3);
    }, png.toString('base64'));
}

for (const hold of ['response', 'seek', 'confirmation']) {
    test(`late incoming ${hold} keeps outgoing picture and clock beyond the excerpt end`, async ({ page }) => {
        test.setTimeout(20_000);
        const { release, releaseNext, outgoingChannel } = await startHeldClips(page, hold);
        const incomingChannel = 2 - outgoingChannel;
        try {
            await page.evaluate(() => { window.__continuityOutgoing.currentTime = window.__continuityEnd - 0.3; });
            await expect.poll(() => page.evaluate(() => window.__continuityOutgoing.currentTime
                - window.__continuityEnd)).toBeGreaterThan(0.25);
            expect(await page.evaluate(() => window.__continuityOutgoing.paused)).toBe(false);
            const outgoingPicture = await picture(page);
            expect(outgoingPicture[outgoingChannel]).toBeGreaterThan(200);
            expect(outgoingPicture[incomingChannel]).toBeLessThan(40);
            await release();
            await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
            await expect.poll(() => page.locator('#playerVideo').evaluate(video =>
                video.currentTime - playerBoundaries.get(video).start)).toBeGreaterThan(0.4);
            const blend = await picture(page);
            expect(blend[0]).toBeGreaterThan(20);
            expect(blend[2]).toBeGreaterThan(20);
            await expect.poll(() => page.evaluate(() => playerPreparation?.fade || false), {
                timeout: 4000,
            }).toBe(false);
            expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(1);
            expect(await page.evaluate(() => window.__continuityPromotions)).toBe(1);
            expect(await page.locator('#playerVideo').evaluate(video =>
                video.currentTime - playerBoundaries.get(video).start)).toBeGreaterThan(2);
            const incomingPicture = await picture(page);
            expect(incomingPicture[incomingChannel]).toBeGreaterThan(200);
            expect(incomingPicture[outgoingChannel]).toBeLessThan(40);
        } finally {
            await release();
            await page.evaluate(() => closePlayer());
            releaseNext();
        }
    });
}
