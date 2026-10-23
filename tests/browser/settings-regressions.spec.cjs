const { test, expect } = require('@playwright/test');
const { reset, openSettings } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

for (const viewport of [
    { width: 1000, height: 500 },
    { width: 1000, height: 800 },
    { width: 390, height: 650 },
]) {
    test(`Settings index follows manual scrolling at ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await openSettings(page);
        const active = page.locator('.settings-nav [aria-current="page"]');
        const scrollToSection = async (name, offset = 0) => {
            await page.evaluate(({ name, offset }) => {
                const section = document.querySelector(`#settings-${name}`);
                let top = document.querySelector('.app-header').getBoundingClientRect().bottom;
                if (window.innerWidth <= 560) {
                    const nav = document.querySelector('.settings-nav');
                    top = parseFloat(getComputedStyle(nav).top) + nav.getBoundingClientRect().height;
                }
                window.scrollBy(0, section.getBoundingClientRect().top - top + offset);
            }, { name, offset });
            await expect(active).toHaveCount(1);
            await expect(active).toHaveAttribute('data-settings-section', name);
        };
        await expect(active).toHaveAttribute('data-settings-section', 'general');
        await scrollToSection('playback', 80);
        await scrollToSection('browser-extension', 20);
        if (viewport.height < 800) await scrollToSection('users', 20);
        await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
        await expect(active).toHaveAttribute('data-settings-section',
            viewport.height === 800 ? 'users' : 'danger');
        await scrollToSection('playback', 160);
        await scrollToSection('general', 200);
        await page.getByRole('button', { name: 'Playback', exact: true }).click();
        await expect(active).toHaveAttribute('data-settings-section', 'playback');
        await scrollToSection('general');
        await page.getByRole('searchbox', { name: 'Search settings' }).fill('full screen');
        await expect(active).toHaveAttribute('data-settings-section', 'playback');
        await page.getByRole('searchbox', { name: 'Search settings' }).fill('not a setting');
        await expect(active).toHaveCount(0);
        await page.getByRole('searchbox', { name: 'Search settings' }).fill('');
        await expect(active).toHaveAttribute('data-settings-section', 'general');
        await scrollToSection('playback', 80);
        await page.getByRole('button', { name: 'Back to videos', exact: true }).click();
        await openSettings(page);
        await expect(active).toHaveAttribute('data-settings-section', 'general');
    });
}

test('Settings index follows smooth navigation and resizes across sticky layouts', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 500 });
    await openSettings(page);
    const active = page.locator('.settings-nav [aria-current="page"]');
    await page.getByRole('button', { name: 'Playback', exact: true }).click();
    await expect.poll(() => page.locator('#settings-playback').evaluate(section =>
        Math.abs(section.getBoundingClientRect().top
            - document.querySelector('.app-header').getBoundingClientRect().bottom),
    )).toBeLessThan(2);
    await expect(active).toHaveAttribute('data-settings-section', 'playback');
    await page.mouse.wheel(0, -2000);
    await expect(active).toHaveAttribute('data-settings-section', 'general');

    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await expect(active).toHaveAttribute('data-settings-section', 'danger');
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(active).toHaveAttribute('data-settings-section', 'users');
    await page.setViewportSize({ width: 390, height: 650 });
    await page.getByRole('button', { name: 'Playback', exact: true }).click();
    await expect(active).toHaveAttribute('data-settings-section', 'playback');
    await page.setViewportSize({ width: 580, height: 650 });
    await page.getByRole('button', { name: 'General', exact: true }).click();
    await expect(active).toHaveAttribute('data-settings-section', 'general');
});
