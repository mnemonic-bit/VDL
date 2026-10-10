const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

async function createPlaylist(page, name, downloadIds) {
    const response = await page.request.post('/api/playlists', {
        data: { name, download_ids: downloadIds },
    });
    expect(response.status()).toBe(201);
    return response.json();
}

async function installMediaHarness(page) {
    await page.evaluate(() => {
        Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
            configurable: true,
            get() { return 100; },
        });
        Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
            configurable: true,
            get() { return false; },
        });
        HTMLMediaElement.prototype.load = function load() {
            if (this.id !== 'playerVideo') return;
            queueMicrotask(() => {
                this.dispatchEvent(new Event('loadedmetadata'));
                this.dispatchEvent(new Event('canplay'));
            });
        };
        HTMLMediaElement.prototype.pause = function pause() {};
        HTMLMediaElement.prototype.play = function play() {
            queueMicrotask(() => this.dispatchEvent(new Event('playing')));
            return Promise.resolve();
        };
    });
}

test('creates, quick-adds, reorders, and deletes a personal playlist', async ({ page }) => {
    await seed(page, { id: 'playlist-one', status: 'finished', file: true, name: 'one.mp4', title: 'One', duration_seconds: 1800 });
    await seed(page, { id: 'playlist-two', status: 'finished', file: true, name: 'two.mp4', title: 'Two', duration_seconds: 1532 });
    await seed(page, { id: 'playlist-three', status: 'finished', file: true, name: 'three.mp4', title: 'Three' });
    await refresh(page);

    await page.getByRole('button', { name: 'Create playlist' }).click();
    const editor = page.locator('#playlistEditorDialog');
    await expect(editor).toBeVisible();
    await editor.getByLabel('Playlist name').fill('Weekend');
    await editor.locator('#playlistAvailable').getByRole('button', { name: /One/ }).click();
    await editor.locator('#playlistAvailable').getByRole('button', { name: /Two/ }).click();
    await expect(editor.locator('#playlistEditorDirty')).toBeVisible();
    await editor.getByRole('button', { name: 'Save playlist' }).click();

    const card = page.locator('.playlist-card', { hasText: 'Weekend' });
    await expect(card).toBeVisible();
    const previewMeta = card.locator('.playlist-preview-meta');
    await expect(previewMeta).toHaveText('2 videos · 55:32');
    await expect(card.locator('.playlist-card-caption')).not.toContainText('2 videos');
    const badgeInsets = await previewMeta.evaluate(badge => {
        const preview = badge.closest('.playlist-card-primary').getBoundingClientRect();
        const bounds = badge.getBoundingClientRect();
        return {
            right: Math.round(preview.right - bounds.right),
            bottom: Math.round(preview.bottom - bounds.bottom),
        };
    });
    expect(badgeInsets).toEqual({ right: 9, bottom: 9 });
    await expect(card.locator('.playlist-mosaic img')).toHaveCount(2);

    const third = page.locator('[data-row-id="playlist-three"]');
    await third.locator('.kebab-btn').click();
    await third.getByRole('button', { name: 'Add to playlist…' }).click();
    const chooser = page.locator('#playlistChooserDialog');
    await chooser.getByRole('button', { name: /Weekend/ }).click();
    await expect(card).toContainText('3 videos');

    await card.locator('.kebab-btn').click();
    await card.getByRole('button', { name: 'Edit playlist' }).click();
    const selected = editor.locator('.playlist-selected-row');
    await expect(selected).toHaveCount(3);
    await selected.nth(1).getByRole('button', { name: /Move Two up/ }).click();
    await expect(editor.locator('#playlistMoveStatus')).toContainText('position 1');
    await editor.getByRole('button', { name: 'Save playlist' }).click();

    const deleteButton = card.getByRole('button', { name: 'Delete playlist' });
    await expect(async () => {
        await card.locator('.kebab-btn').click();
        await expect(deleteButton).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 3000 });
    page.once('dialog', dialog => dialog.accept());
    await deleteButton.click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('[data-row-id="playlist-one"]')).toBeVisible();
});

test('resumes in the built-in player, selects queue entries, and stops at the end', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await seed(page, { id: 'queue-one', status: 'finished', file: true, name: 'one.mp4', title: 'One', duration_seconds: 100 });
    await seed(page, { id: 'queue-two', status: 'finished', file: true, name: 'two.mp4', title: 'Two', duration_seconds: 100 });
    const playlist = await createPlaylist(page, 'Episodes', ['queue-one', 'queue-two']);
    await page.request.put(`/api/playlists/${playlist.id}/progress`, {
        data: {
            download_id: 'queue-one', position_seconds: 24,
            completed: false, write_sequence: 1,
        },
    });
    await page.evaluate(() => Promise.all([fetchHistory(), fetchPlaylists()]));
    await installMediaHarness(page);

    await page.getByRole('button', { name: 'Resume playlist: Episodes' }).click();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    await expect(page.locator('#playlistQueue')).toBeVisible();
    await expect(page.locator('.playlist-queue-row')).toHaveCount(2);
    await expect(page.locator('.playlist-queue-row').first()).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBe(24);
    const geometry = await page.locator('.player-layout').evaluate(layout => {
        const overlay = document.getElementById('playerBackdrop').getBoundingClientRect();
        const media = layout.querySelector('.player-media-column').getBoundingClientRect();
        const video = layout.querySelector('#playerVideo').getBoundingClientRect();
        const queue = layout.querySelector('.playlist-queue').getBoundingClientRect();
        return {
            queueTopInset: Math.round(queue.top - overlay.top),
            queueBottomInset: Math.round(overlay.bottom - queue.bottom),
            mediaTopInset: Math.round(media.top - overlay.top),
            mediaBottomInset: Math.round(overlay.bottom - media.bottom),
            videoCenterXOffset: Math.round(
                (video.left + video.right - media.left - media.right) / 2,
            ),
            videoCenterYOffset: Math.round(
                (video.top + video.bottom - media.top - media.bottom) / 2,
            ),
        };
    });
    expect(geometry).toEqual({
        queueTopInset: 0,
        queueBottomInset: 0,
        mediaTopInset: 0,
        mediaBottomInset: 0,
        videoCenterXOffset: 0,
        videoCenterYOffset: 0,
    });

    await page.locator('.playlist-queue-row').nth(1).click();
    await expect(page.locator('.playlist-queue-row').nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/queue-two');

    await page.locator('#playerVideo').evaluate(video => video.dispatchEvent(new Event('ended')));
    await expect(page.locator('#playerStatus')).toHaveText('Playlist complete.');
    await expect(page.locator('#playlistQueue')).toBeVisible();
    const detail = await page.request.get(`/api/playlists/${playlist.id}`);
    expect((await detail.json()).progress.completed).toBe(true);
});

test('playlist queue moves below the video on a narrow screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await seed(page, { id: 'mobile-queue', status: 'finished', file: true, name: 'mobile.mp4' });
    await createPlaylist(page, 'Mobile', ['mobile-queue']);
    await page.evaluate(() => Promise.all([fetchHistory(), fetchPlaylists()]));
    await installMediaHarness(page);
    await page.getByRole('button', { name: 'Resume playlist: Mobile' }).click();

    const order = await page.locator('.player-layout').evaluate(layout => {
        const video = layout.querySelector('.player-media-column').getBoundingClientRect();
        const queue = layout.querySelector('.playlist-queue').getBoundingClientRect();
        return { videoBottom: Math.round(video.bottom), queueTop: Math.round(queue.top) };
    });
    expect(order.queueTop).toBeGreaterThanOrEqual(order.videoBottom);
});
