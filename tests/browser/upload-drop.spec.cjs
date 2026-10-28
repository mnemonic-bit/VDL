const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openNewDownload, openCurrent, closeCurrent } = require('./support.cjs');


test.beforeEach(async ({ page }) => reset(page));

async function dropVideos(page, names) {
    await page.evaluate(names => {
        const transfer = new DataTransfer();
        for (const name of names) {
            transfer.items.add(new File([new Uint8Array([0, 1, 2, 3])], name, { type: 'video/mp4' }));
        }
        document.body.dispatchEvent(new DragEvent('dragenter', {
            bubbles: true, cancelable: true, dataTransfer: transfer,
        }));
        document.getElementById('uploadDropOverlay').dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: transfer,
        }));
    }, names);
}

test('pending registration leaves the page usable and every upload visible', async ({ page }) => {
    await seed(page, { id: 'before-drop', status: 'finished' });
    await refresh(page);
    await page.locator('#historyList .kebab-btn').click();
    await page.route('**/api/upload', () => {});
    await dropVideos(page, ['first.mp4', 'second.mp4']);
    await expect(page.locator('#uploadDropOverlay')).toBeHidden({ timeout: 1000 });
    await expect(page.locator('#currentDownloadsDrawer')).toBeHidden();
    await expect(page.locator('#currentBadge')).toHaveText('2');
    await page.locator('#newDownloadButton').click();
    await page.getByRole('button', { name: 'Close new download' }).click();
    await expect(page.locator('#currentBadge')).toHaveText('2');
    await page.locator('#currentDownloadsButton').click();
    await expect(page.locator('#activeList .history-item')).toHaveCount(2);
    await expect(page.locator('#activeList')).toContainText('first.mp4');
    await expect(page.locator('#activeList')).toContainText('second.mp4');
    await expect(page.locator('#activeList')).toContainText('Preparing upload');
});

async function assertPageUsable(page, count) {
    await expect(page.locator('#uploadDropOverlay')).toBeHidden({ timeout: 1000 });
    await expect(page.locator('#currentDownloadsDrawer')).toBeHidden();
    await openNewDownload(page);
    await page.getByRole('button', { name: 'Close new download' }).click();
    await expect(page.locator('#currentBadge')).toHaveText(String(count));
    await openCurrent(page);
    await expect(page.locator('#activeList .history-item')).toHaveCount(count);
    await closeCurrent(page);
    if (!(await page.locator('#historySearchInput').isVisible())) {
        await page.locator('#historySearchToggle').click();
    }
    await page.locator('#historySearchInput').fill('anything');
    await page.locator('#historySearchInput').fill('');
}

for (const count of [1, 2]) {
    test(`${count} held transfers leave the page usable with separate rows`, async ({ page }) => {
        let transfers = 0;
        await page.route('**/api/upload/*', () => { transfers++; });
        await dropVideos(page, Array.from({ length: count }, (_, i) => `held-${i}.mp4`));
        await expect.poll(() => transfers).toBe(count);
        await assertPageUsable(page, count);
    });
}

test('slow second registration does not block the first transfer or a later drop', async ({ page }) => {
    const transferred = [];
    await page.route('**/api/upload', route => {
        if (route.request().postDataJSON().filename === 'slow.mp4') return;
        return route.continue();
    });
    await page.route('**/api/upload/*', route => { transferred.push(route.request().url()); });
    await dropVideos(page, ['fast.mp4', 'slow.mp4']);
    await expect.poll(() => transferred.length).toBe(1);
    await assertPageUsable(page, 2);
    await dropVideos(page, ['later.mp4']);
    await expect.poll(() => transferred.length).toBe(2);
    await assertPageUsable(page, 3);
    await openCurrent(page);
    await expect(page.locator('#activeList .history-item', { hasText: 'slow.mp4' })).toContainText('Preparing upload');
});

test('slow collection reads do not block uploads or preparation rows', async ({ page }) => {
    let transfers = 0;
    let reads = 0;
    await page.route('**/api/upload/*', () => { transfers++; });
    await page.route('**/api/current-downloads', () => { reads++; });
    await page.route('**/api/library', () => {});
    await dropVideos(page, ['collection.mp4']);
    await expect.poll(() => transfers).toBe(1);
    await expect.poll(() => reads).toBeGreaterThan(0);
    await assertPageUsable(page, 1);
});

test('registration reconciles into the same row even when SSE arrives before its response', async ({ page }) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let registered = false;
    let transfers = 0;
    await page.route('**/api/upload', async route => {
        const response = await route.fetch();
        registered = true;
        await gate;
        await route.fulfill({ response });
    });
    await page.route('**/api/upload/*', () => { transfers++; });
    try {
        await dropVideos(page, ['same.mp4']);
        await openCurrent(page);
        await expect.poll(() => registered).toBe(true);
        await page.evaluate(() => fetchHistory());
        const row = page.locator('#activeList .history-item');
        await expect(row).toHaveCount(1);
        const id = await row.getAttribute('data-row-id');
        await row.evaluate(element => { window.__preparationRow = element; });
        release();
        await expect.poll(() => transfers).toBe(1);
        await expect(row).toHaveAttribute('data-row-id', id);
        expect(await row.evaluate(element => element === window.__preparationRow)).toBe(true);
        await expect(row).not.toContainText('Preparing upload');
    } finally {
        release();
    }
});

test('stopping and deleting during registration cancels only that file after acknowledgement', async ({ page }) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const transferred = [];
    let stoppedId;
    await page.route('**/api/upload', async route => {
        if (route.request().postDataJSON().filename === 'stop.mp4') {
            stoppedId = route.request().postDataJSON().id;
            await gate;
        }
        await route.continue();
    });
    await page.route('**/api/upload/*', route => { transferred.push(route.request().url()); });
    try {
        await dropVideos(page, ['stop.mp4', 'sibling.mp4']);
        await openCurrent(page);
        const row = page.locator('#activeList .history-item', { hasText: 'stop.mp4' });
        await row.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(row).toContainText('Upload stopped');
        await row.locator('.kebab-btn').click();
        await row.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(row).toHaveCount(0);
        await expect(page.locator('#currentBadge')).toHaveText('1');
        const removed = page.waitForResponse(response =>
            response.url().endsWith(`/api/remove/${stoppedId}`));
        release();
        expect((await removed).status()).toBe(200);
        await expect.poll(async () => {
            const response = await page.request.get('/api/current-downloads');
            return (await response.json()).map(info => info.id);
        }).not.toContain(stoppedId);
        await expect.poll(() => transferred.length).toBe(1);
        expect(transferred.some(url => url.endsWith(stoppedId))).toBe(false);
        await expect(page.locator('#activeList .history-item', { hasText: 'sibling.mp4' })
            .getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    } finally {
        release();
    }
});

test('mixed registration and transfer failures keep successful siblings and useful feedback', async ({ page }) => {
    const ids = new Map();
    await page.route('**/api/upload', route => {
        const data = route.request().postDataJSON();
        ids.set(data.filename, data.id);
        if (data.filename === 'rejected.mp4') {
            return route.fulfill({ status: 400, json: { error: 'Registration rejected' } });
        }
        return route.continue();
    });
    await page.route('**/api/upload/*', route => {
        if (route.request().url().endsWith(ids.get('invalid.mp4'))) {
            return route.fulfill({ status: 415, json: { error: 'No video stream' } });
        }
        return route.continue();
    });
    await dropVideos(page, ['rejected.mp4', 'invalid.mp4', 'accepted.mp4']);
    await expect(page.locator('#uploadDropOverlay')).toBeHidden();
    await expect(page.locator('#historyList .history-card', { hasText: 'accepted' })).toBeVisible();
    await openCurrent(page);
    const failed = page.locator('#activeList .history-item', { hasText: 'rejected.mp4' });
    await expect(failed).toContainText('Registration rejected');
    await expect(page.locator('#activeList .history-item', { hasText: 'invalid.mp4' })).toContainText('No video stream');
    await expect(page.locator('#historyList .history-card', { hasText: 'invalid' })).toHaveCount(0);
    await expect(failed.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
    await failed.locator('.kebab-btn').click();
    await failed.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(failed).toHaveCount(0);
});

test('validation keeps the page usable and Stop affects only one upload', async ({ page }) => {
    await page.request.post('/__test__/hold-uploads');
    try {
        await dropVideos(page, ['stop-validating.mp4', 'finish-validating.mp4']);
        await assertPageUsable(page, 2);
        await openCurrent(page);
        const stoppedRow = page.locator('#activeList .history-item', { hasText: 'stop-validating' });
        const sibling = page.locator('#activeList .history-item', { hasText: 'finish-validating' });
        await expect(stoppedRow).toContainText('Uploaded: 100%');
        await expect(sibling).toContainText('Validating video');
        await expect(sibling).toContainText('Bytes uploaded: 4.0 B');
        await expect(page.locator('#historyList .history-card')).toHaveCount(0);
        const stopped = page.waitForResponse(response => response.url().includes('/api/stop/'));
        await stoppedRow.getByRole('button', { name: 'Stop', exact: true }).click();
        expect((await stopped).status()).toBe(200);
        await expect(sibling.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    } finally {
        await page.request.post('/__test__/release-uploads');
    }
    await expect(page.locator('#historyList .history-card', { hasText: 'finish-validating' })).toBeVisible();
    await expect(page.locator('#historyList .history-card', { hasText: 'stop-validating' })).toHaveCount(0);
    await expect(page.locator('#activeList .history-item')).toHaveCount(1);
});


test('dropping a desktop video uploads it into History', async ({ page }) => {
    await openNewDownload(page);
    await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(
            [new Uint8Array([0, 1, 2, 3])],
            'desktop-video.mp4',
            { type: 'video/mp4' },
        ));
        window.__uploadTransfer = transfer;
        document.getElementById('newDownloadDialog').dispatchEvent(new DragEvent('dragenter', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
        }));
    });

    const overlay = page.locator('#uploadDropOverlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Drop video to add it');
    expect(await overlay.evaluate(element => {
        const box = element.getBoundingClientRect();
        return {
            modal: element.matches(':modal'),
            top: Math.round(box.top),
            right: Math.round(window.innerWidth - box.right),
            bottom: Math.round(window.innerHeight - box.bottom),
            left: Math.round(box.left),
        };
    })).toEqual({ modal: true, top: 0, right: 0, bottom: 0, left: 0 });

    await page.evaluate(() => {
        document.getElementById('uploadDropOverlay').dispatchEvent(new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: window.__uploadTransfer,
        }));
    });

    await expect(overlay).toBeHidden();
    await page.getByRole('button', { name: 'Close new download' }).click();
    const card = page.locator('.history-card', { hasText: 'desktop-video' });
    await expect(card).toBeVisible();
    await card.locator('.kebab-btn').click();
    await expect(card.getByRole('button', { name: 'Open URL' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Copy URL' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Info', exact: true }).click();
    await expect(card.locator('.history-source-section .history-info-label')).toHaveText('Source');
    await expect(card.locator('.history-source-field > span')).toHaveText('Local upload');
    await expect(card.locator('.history-media-row')).toContainText('Quality: 360p');
    await expect(card.locator('.history-media-row')).not.toContainText('Requested format');
    await expect(card.locator('.history-timing-row')).toContainText('Added:');
    await expect(card.locator('.history-timing-row')).not.toContainText('Duration:');
});


test('the upload overlay closes when a file drag leaves the page', async ({ page }) => {
    await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([], 'desktop-video.mp4', { type: 'video/mp4' }));
        const options = {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
        };
        document.body.dispatchEvent(new DragEvent('dragenter', options));
        document.getElementById('uploadDropOverlay').dispatchEvent(
            new DragEvent('dragenter', options),
        );
        document.documentElement.dispatchEvent(new DragEvent('dragleave', {
            ...options,
            relatedTarget: null,
        }));
    });

    await expect(page.locator('#uploadDropOverlay')).toBeHidden();
});


test('an in-progress upload can be stopped and removed from Current downloads', async ({ page }) => {
    await page.request.post('/__test__/hold-uploads');
    await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(
            [new Uint8Array([0, 1, 2, 3])],
            'slow-video.mp4',
            { type: 'video/mp4' },
        ));
        document.body.dispatchEvent(new DragEvent('dragenter', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
        }));
        document.getElementById('uploadDropOverlay').dispatchEvent(new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
        }));
    });

    await expect(page.locator('#uploadDropOverlay')).toBeHidden();
    const currentButton = page.locator('#currentDownloadsButton');
    await expect(currentButton).toBeVisible();
    await expect(currentButton.locator('#currentBadge')).toHaveText('1');
    await currentButton.click();

    const row = page.locator('#activeList .history-item', { hasText: 'slow-video' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Uploaded: 100%');
    await expect(row.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Open URL' })).toHaveCount(0);
    const stopped = page.waitForResponse(response => response.url().includes('/api/stop/'));
    await row.getByRole('button', { name: 'Stop', exact: true }).click();
    expect((await stopped).status()).toBe(200);
    await page.request.post('/__test__/release-uploads');

    await expect(row).toContainText('Uploaded: 100%');
    await expect(row.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('#activeList .history-item')).toHaveCount(0);
    await expect(currentButton).toBeHidden();
});
