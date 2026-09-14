const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: '.',
    testMatch: '*.spec.cjs',
    fullyParallel: false,
    workers: 1,
    timeout: 10_000,
    expect: { timeout: 3_000 },
    use: {
        baseURL: process.env.VDL_BROWSER_BASE_URL,
        headless: true,
        permissions: ['clipboard-read', 'clipboard-write'],
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    outputDir: 'test-results',
    reporter: [['list']],
});
