const { test, expect } = require('@playwright/test');
const { reset, openSettings } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

async function expectControlTheme(page, theme) {
    await expect(page.locator('#prefMax')).toHaveCSS('color-scheme', theme);
    await expect(page.locator('#prefSkipVideoEdges')).toHaveCSS('color-scheme', theme);
}

async function captureControl(control, testInfo, name) {
    const path = testInfo.outputPath(`${name}.png`);
    await control.locator('..').screenshot({ path });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('native number and checkbox controls follow the selected theme', async ({ page }, testInfo) => {
    await openSettings(page);
    const number = page.locator('#prefMax');
    const checkbox = page.locator('#prefSkipVideoEdges');
    for (const theme of ['dark', 'light']) {
        await page.locator('#prefTheme').selectOption(theme);
        await expectControlTheme(page, theme);
        await number.fill('3');
        await number.press('ArrowUp');
        await expect(number).toHaveValue('4');
        await number.press('ArrowDown');
        await expect(number).toHaveValue('3');
        await number.hover();
        await captureControl(number, testInfo, `${theme}-number-hover-focus`);
        await checkbox.uncheck();
        await checkbox.focus();
        await captureControl(checkbox, testInfo, `${theme}-checkbox-unchecked-focus`);
        await checkbox.press('Space');
        await expect(checkbox).toBeChecked();
        await captureControl(checkbox, testInfo, `${theme}-checkbox-checked-focus`);
        await checkbox.press('Space');
        await expect(checkbox).not.toBeChecked();
        // Exercise native disabled rendering without introducing a settings dependency.
        await checkbox.evaluate(control => { control.disabled = true; });
        await expect(checkbox).toBeDisabled();
        await captureControl(checkbox, testInfo, `${theme}-checkbox-disabled`);
        await checkbox.evaluate(control => { control.disabled = false; });
    }
});

test('native control theme survives saving and reloading and follows system changes', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openSettings(page);
    await page.locator('#prefTheme').selectOption('dark');
    await page.locator('#saveBtn').click();
    await expect(page.locator('#saveBtn')).toContainText('Saved');
    await page.reload();
    await openSettings(page);
    await expectControlTheme(page, 'dark');
    await page.locator('#prefTheme').selectOption('system');
    await expectControlTheme(page, 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectControlTheme(page, 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expectControlTheme(page, 'light');
});
