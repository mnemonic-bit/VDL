const { test, expect } = require('@playwright/test');
const { execFileSync, spawnSync } = require('node:child_process');
const { reset, seed, refresh } = require('./support.cjs');

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('native MP4 pins the untrimmed preview until the next hover selects only its inner excerpt', async ({ page }) => {
    test.skip(!hasFfmpeg, 'Native MP4 handoff requires ffmpeg.');
    test.setTimeout(20_000);
    const makeMontage = colors => execFileSync('ffmpeg', [
        '-v', 'error', '-filter_complex_threads', '1',
        ...colors.flatMap(color => ['-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=12:d=2`]),
        '-filter_complex', `${colors.map((_, index) => `[${index}:v]`).join('')}concat=n=${colors.length}:v=1:a=0[outv]`,
        '-map', '[outv]', '-an', '-c:v', 'libx264', '-threads', '1',
        '-pix_fmt', 'yuv420p', '-profile:v', 'baseline',
        '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
    ]);
    // Red and blue identify the removed endpoints; the retained inner excerpt is green.
    const montages = { legacy: makeMontage(['red', 'lime', 'blue']), current: makeMontage(['lime']) };
    await page.addInitScript(() => {
        window.__nativePreviewStreams = [];
        const BrowserEventSource = window.EventSource;
        window.EventSource = class extends BrowserEventSource {
            constructor(...args) { super(...args); window.__nativePreviewStreams.push(this); }
        };
    });
    await reset(page);
    let identity = 'legacy';
    await page.route('**/api/assets/demand', route => {
        const demand = route.request().postDataJSON();
        return route.fulfill({ json: { assets: Object.fromEntries(demand.ids.map(id => [id, {
            thumbnail: 'queued', montage: identity === 'legacy' ? 'queued' : 'ready',
            montage_delivery: { available: true, current: identity === 'current', identity,
                url: `/api/preview/native-hover?asset=${identity}` },
        }])) } });
    });
    await page.route('**/api/preview/native-hover?*', route => {
        const montage = montages[new URL(route.request().url()).searchParams.get('asset')];
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
        const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4', ETag: `"${new URL(route.request().url()).searchParams.get('asset')}"` };
        if (!range) return route.fulfill({ status: 200, headers, body: montage });
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : montage.length - 1, montage.length - 1);
        headers['Content-Range'] = `bytes ${start}-${end}/${montage.length}`;
        return route.fulfill({ status: 206, headers, body: montage.subarray(start, end + 1) });
    });
    await seed(page, { id: 'native-hover', status: 'finished' });
    await refresh(page);
    const preview = page.locator('[data-row-id="native-hover"] .history-preview');
    await preview.hover();
    await expect(preview).toHaveClass(/preview-playing/);
    const video = preview.locator('video');
    await expect.poll(() => video.evaluate(video => video.currentTime)).toBeGreaterThan(0.1);
    await expect.poll(() => video.evaluate(video => video.duration)).toBe(6);
    const before = await video.evaluate(video => {
        window.__nativePinnedPreview = video;
        return video.currentTime;
    });
    identity = 'current';
    await page.evaluate(() => window.__nativePreviewStreams.at(-1).dispatchEvent(new MessageEvent('assets', { data: '{}' })));
    await page.waitForTimeout(400);
    await expect(video).toHaveAttribute('src', '/api/preview/native-hover?asset=legacy');
    expect(await video.evaluate(video => video === window.__nativePinnedPreview)).toBe(true);
    expect(await video.evaluate(video => video.currentTime)).toBeGreaterThan(before);
    expect(await video.evaluate(video => ({ paused: video.paused, muted: video.muted, error: video.error }))).toEqual({ paused: false, muted: true, error: null });
    const ranged = await page.evaluate(async () => {
        const response = await fetch('/api/preview/native-hover?asset=legacy', { headers: { Range: 'bytes=0-31' } });
        return { status: response.status, length: (await response.arrayBuffer()).byteLength, etag: response.headers.get('etag') };
    });
    expect(ranged).toEqual({ status: 206, length: 32, etag: '"legacy"' });
    await page.locator('.app-header').hover();
    await preview.hover();
    await expect(video).toHaveAttribute('src', '/api/preview/native-hover?asset=current');
    await expect(preview).toHaveClass(/preview-playing/);
    await expect.poll(() => video.evaluate(video => video.duration)).toBe(2);
    await expect.poll(() => video.evaluate(video => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, 1, 1);
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
        return green > 200 && red < 30 && blue < 30;
    })).toBe(true);
    const library = await page.request.get('/api/library').then(response => response.json());
    expect(library.find(item => item.id === 'native-hover').view_count).toBe(0);
});
