const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { checkCodeqlPins } = require('../scripts/check-codeql-pins.cjs');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/codeql.yml'), 'utf8');
const first = 'a'.repeat(40);
const second = 'b'.repeat(40);

test('repository CodeQL pins agree', () => {
    assert.equal(checkCodeqlPins(workflow), 2);
});

test('matching actual refs pass regardless of release comments and YAML quoting', () => {
    assert.equal(checkCodeqlPins(`
jobs:
    analyze:
        steps:
            - uses: "github/codeql-action/init@${first}" # v4.0.0
            - { uses: 'github/codeql-action/analyze@${first}' } # v4.1.0
            - uses: actions/checkout@${second}
`), 2);
});

test('all CodeQL subactions are checked, while independent jobs may use different refs', () => {
    const source = `
jobs:
    python:
        steps:
            - uses: github/codeql-action/init@${first}
            - uses: github/codeql-action/analyze@${first}
            - uses: github/codeql-action/upload-sarif@${first}
    javascript:
        steps:
            - uses: github/codeql-action/init@${second}
            - uses: github/codeql-action/analyze@${second}
`;
    assert.equal(checkCodeqlPins(source), 5);
    assert.throws(() => checkCodeqlPins(source.replace(
        `upload-sarif@${first}`, `upload-sarif@${second}`
    )), /conflicting CodeQL revisions/);
});

test('moving tags, abbreviated SHAs, and missing refs are rejected', () => {
    for (const ref of ['@v4', '@123abcd', '', `@${first}@extra`]) {
        assert.throws(() => checkCodeqlPins(`
jobs:
    analyze:
        steps:
            - uses: github/codeql-action/init${ref}
            - uses: github/codeql-action/analyze${ref}
`), /must use a full commit SHA/);
    }
});

test('empty or malformed workflows fail rather than reporting agreement', () => {
    assert.throws(() => checkCodeqlPins('jobs: {}'), /no CodeQL action steps/);
    assert.throws(() => checkCodeqlPins('jobs: [broken'));
});

test('CLI rejects a one-step update with the conflicting names and refs', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-codeql-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'codeql.yml');
    const baseline = workflow.replace(/github\/codeql-action\/([^@\s]+)@[0-9a-f]{40}/g,
        `github/codeql-action/$1@${first}`);
    const changed = baseline.replace(`github/codeql-action/analyze@${first}`,
        `github/codeql-action/analyze@${second}`);
    assert.notEqual(changed, baseline);
    fs.writeFileSync(filename, changed);
    const result = spawnSync(process.execPath,
        [path.join(root, 'scripts/check-codeql-pins.cjs'), filename], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /job analyze has conflicting CodeQL revisions/);
    assert.ok(result.stderr.includes(`Initialise CodeQL: github/codeql-action/init@${first}`));
    assert.ok(result.stderr.includes(`Analyse: github/codeql-action/analyze@${second}`));
    fs.writeFileSync(filename, baseline);
    assert.equal(spawnSync(process.execPath,
        [path.join(root, 'scripts/check-codeql-pins.cjs'), filename]).status, 0);
});
