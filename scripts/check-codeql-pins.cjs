#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const DEFAULT_WORKFLOW = path.join(__dirname, '../.github/workflows/codeql.yml');

function checkCodeqlPins(source, filename = 'CodeQL workflow') {
    const workflow = YAML.parse(source);
    let count = 0;
    for (const [jobId, job] of Object.entries(workflow?.jobs || {})) {
        const pins = [];
        for (const [index, step] of (job.steps || []).entries()) {
            if (typeof step.uses !== 'string'
                    || !/^github\/codeql-action\//i.test(step.uses)) continue;
            const label = step.name || step.id || `step ${index + 1}`;
            const ref = step.uses.split('@')[1];
            if (!/^[0-9a-f]{40}$/i.test(ref || '') || step.uses.split('@').length !== 2) {
                throw new Error(`${filename}: job ${jobId}, ${label}: ${step.uses} must use a full commit SHA`);
            }
            pins.push({ label, uses: step.uses, ref: ref.toLowerCase() });
        }
        if (new Set(pins.map(pin => pin.ref)).size > 1) {
            const details = pins.map(pin => `  ${pin.label}: ${pin.uses}`).join('\n');
            throw new Error(`${filename}: job ${jobId} has conflicting CodeQL revisions:\n${details}`);
        }
        count += pins.length;
    }
    if (!count) throw new Error(`${filename}: no CodeQL action steps found`);
    return count;
}

if (require.main === module) {
    const filename = process.argv[2] || DEFAULT_WORKFLOW;
    try {
        const count = checkCodeqlPins(fs.readFileSync(filename, 'utf8'), filename);
        console.log(`${filename}: ${count} CodeQL action pins agree within each job`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { checkCodeqlPins };
