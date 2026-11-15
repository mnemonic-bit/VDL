const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const YAML = require('yaml');

const root = path.resolve(__dirname, '..');
const workflow = YAML.parse(fs.readFileSync(
    path.join(root, '.github/workflows/validation.yml'), 'utf8'));

test('validation checks test-area ownership before dependency installation', () => {
    const steps = workflow.jobs['deterministic-gate'].steps;
    const python = steps.findIndex(step => step.name === 'Set up Python');
    const check = steps.findIndex(step => step.run === 'python tests/run-area.py --check');
    const install = steps.findIndex(step => step.name === 'Install workflow and extension tooling');
    assert.ok(check > python, 'map validation must use the configured Python');
    assert.ok(check < install, 'map validation must precede expensive test setup');
    assert.ok(steps.some(step => step.run === './tests/run-all.sh --all'),
        'focused selection must retain the complete deterministic gate');
});

test('validation installs server dependencies before JavaScript tests that import the server', () => {
    const steps = workflow.jobs['deterministic-gate'].steps;
    const install = steps.findIndex(step => step.run?.includes('python -m pip install -r requirements.txt'));
    const suite = steps.findIndex(step => step.run?.includes('node --test tests/*.test.cjs'));
    assert.ok(install >= 0, 'server dependency installation must remain in the gate');
    assert.ok(suite > install, 'JavaScript tests must run after server dependency installation');
    assert.equal(steps[suite].env?.VDL_PYTHON, 'python',
        'server parity must use the interpreter that received requirements.txt');
});
