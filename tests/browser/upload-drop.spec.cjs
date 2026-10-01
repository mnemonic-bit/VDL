const { test, expect } = require('@playwright/test');
const { reset, openNewDownload } = require('./support.cjs');


test.beforeEach(async ({ page }) => reset(page));


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

    await expect(overlay).toContainText('Upload started');
    await expect(overlay).toBeHidden();
    await page.getByRole('button', { name: 'Close new download' }).click();
    const card = page.locator('.history-card', { hasText: 'desktop-video' });
    await expect(card).toBeVisible();
    await card.locator('.kebab-btn').click();
    await expect(card.getByRole('button', { name: 'Open URL' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Copy URL' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Info', exact: true }).click();
    await expect(card.locator('.history-url-row')).toHaveText('Source: Local upload');
    await expect(card.locator('.history-media-row')).toContainText('Quality: 360p');
    await expect(card.locator('.history-media-row')).not.toContainText('Requested format');
    await expect(card.locator('.history-timing-row')).toContainText('Added:');
    await expect(card.locator('.history-timing-row')).not.toContainText('Duration:');
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

    await expect(page.locator('#uploadDropOverlay')).toContainText('Upload started');
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
    await row.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.request.post('/__test__/release-uploads');

    await expect(row).toContainText('Uploaded: 100%');
    await expect(row.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('#activeList .history-item')).toHaveCount(0);
    await expect(currentButton).toBeHidden();
});
