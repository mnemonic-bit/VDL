const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const YAML = require('yaml');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, '.github/workflows/main.yml'), 'utf8');
const workflow = YAML.parse(source);
const resolver = workflow.jobs['sign-extension'];
const publisher = workflow.jobs.publish;
const stepWith = (job, text) => job.steps.find(step => step.run?.includes(text));

test('publication requires successful validation and explicit resolution, without failure bypasses', () => {
    assert.equal(resolver.needs, 'validation');
    assert.deepEqual(publisher.needs, ['validation', 'sign-extension']);
    assert.equal(resolver.if, "github.ref == 'refs/heads/main'");
    assert.equal(publisher.if, "github.ref == 'refs/heads/main'");
    for (const job of Object.values(workflow.jobs)) {
        assert.ok(!job['continue-on-error']);
        assert.ok(!job.if?.includes('always()'));
        for (const step of job.steps || []) {
            assert.ok(!step['continue-on-error']);
            assert.ok(!step.if?.includes('always()'));
        }
    }
});

test('only the protected read-only AMO step receives signing credentials', () => {
    assert.equal(resolver.environment, 'amo-signing');
    assert.deepEqual(resolver.permissions, { contents: 'read' });
    assert.equal(resolver.env, undefined);
    const amo = stepWith(resolver, 'extension_release.py sign');
    assert.deepEqual(amo.env, {
        WEB_EXT_API_KEY: '${{ secrets.AMO_JWT_ISSUER }}',
        WEB_EXT_API_SECRET: '${{ secrets.AMO_JWT_SECRET }}',
    });
    for (const step of resolver.steps.filter(step => step !== amo)) {
        assert.doesNotMatch(JSON.stringify(step), /AMO_JWT|WEB_EXT_API/);
    }
    assert.doesNotMatch(JSON.stringify(publisher), /AMO_JWT|WEB_EXT_API/);
    assert.doesNotMatch(fs.readFileSync(path.join(root, '.github/workflows/validation.yml'), 'utf8'),
        /AMO_JWT|WEB_EXT_API|extension_release\.py sign/);
});

test('publisher consumes the selected current-run artifact before build and checks both architectures before pushes', () => {
    const download = publisher.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    assert.equal(download.with['run-id'], undefined);
    assert.match(download.with.name, /steps.extension-artifact.outputs.name/);
    const stage = stepWith(publisher, 'extension_release.py stage');
    const build = stepWith(publisher, 'docker buildx build');
    const push = publisher.steps.findIndex(step => step.run?.includes('docker push'));
    assert.ok(publisher.steps.indexOf(download) < publisher.steps.indexOf(stage));
    assert.ok(publisher.steps.indexOf(stage) < publisher.steps.indexOf(build));
    const smoke = publisher.steps.filter(step => step.run === './tests/container/smoke.sh');
    assert.deepEqual(smoke.map(step => step.env.DOCKER_DEFAULT_PLATFORM), ['linux/amd64', 'linux/arm64']);
    for (const step of smoke) {
        assert.equal(step.env.VDL_EXPECT_COMPANION_SIGNED, `\u0024{{ steps.${stage.id}.outputs.signed }}`);
        assert.equal(step.env.VDL_EXPECT_COMPANION_SHA256, `\u0024{{ steps.${stage.id}.outputs.xpi_sha256 }}`);
        assert.ok(publisher.steps.indexOf(step) > publisher.steps.indexOf(build));
        assert.ok(publisher.steps.indexOf(step) < push);
    }
});

test('release policy refuses an existing immutable commit image or unknown registry failure', () => {
    const policy = stepWith(publisher, 'commit_inspect_error=').run;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-workflow-'));
    try {
        for (const existing of [true, false]) {
            fs.writeFileSync(path.join(temp, 'docker'), existing
                ? '#!/bin/sh\nexit 0\n'
                : '#!/bin/sh\necho "unknown registry failure" >&2\nexit 1\n', { mode: 0o755 });
            const result = spawnSync('bash', ['-c', policy], {
                cwd: root, encoding: 'utf8', env: {
                    ...process.env, PATH: `${temp}:${process.env.PATH}`,
                    GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'a'.repeat(40),
                    RUNNER_TEMP: temp, GITHUB_ENV: path.join(temp, 'env'),
                    GITHUB_OUTPUT: path.join(temp, 'output'),
                },
            });
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, existing ? /already published and immutable/ : /unknown registry failure/);
            assert.equal(fs.existsSync(path.join(temp, 'output')), false);
        }
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
