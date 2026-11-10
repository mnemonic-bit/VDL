const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const YAML = require('yaml');

const root = path.resolve(__dirname, '..');
const workflow = YAML.parse(fs.readFileSync(
    path.join(root, '.github/workflows/validation.yml'), 'utf8'));

test('validation installs server dependencies before JavaScript tests that import the server', () => {
    const steps = workflow.jobs['deterministic-gate'].steps;
    const install = steps.findIndex(step => step.run?.includes('python -m pip install -r requirements.txt'));
    const suite = steps.findIndex(step => step.run?.includes('node --test tests/*.test.cjs'));
    assert.ok(install >= 0, 'server dependency installation must remain in the gate');
    assert.ok(suite > install, 'JavaScript tests must run after server dependency installation');
    assert.equal(steps[suite].env?.VDL_PYTHON, 'python',
        'server parity must use the interpreter that received requirements.txt');
});
