const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/tag-identity.js'), 'utf8');

test('checked-in identity versions negotiate without approximating unknown versions', () => {
    const context = vm.createContext({});
    vm.runInContext(source, context);
    const identity = context.VDL.tagIdentity;
    for (const version of ['14.0.0', '15.0.0', '15.1.0', '16.0.0']) {
        assert.equal(identity.useVersion(`python-casefold-${version}-v1`), true);
        assert.equal(identity.normalize(' Straße  Σς İ ').key, 'strasse σσ i̇');
        assert.equal(identity.normalize('😀'.repeat(64)).name.length, 128);
        assert.throws(() => identity.normalize('😀'.repeat(65)));
        assert.throws(() => identity.normalize('bad\tname'));
    }
    const before = identity.version;
    assert.equal(identity.supports('unknown'), false);
    assert.equal(identity.useVersion('__proto__'), false);
    assert.equal(identity.version, before);
    // Unicode 15 introduced this emoji. Unicode 14 must still reject it as
    // unassigned, matching that version of the server's category validation.
    identity.useVersion('python-casefold-14.0.0-v1');
    assert.throws(() => identity.normalize('\u{1fae8}'));
    identity.useVersion('python-casefold-16.0.0-v1');
    assert.equal(identity.normalize('\u{1fae8}').name, '\u{1fae8}');
});

test('normalization agrees with the actual server across Unicode folds and category boundaries', () => {
    const python = process.env.VDL_PYTHON || (fs.existsSync(path.join(root, '.venv/bin/python'))
        ? path.join(root, '.venv/bin/python') : 'python3');
    const result = spawnSync(python, ['-c', `
import json
import unicodedata
import vdl

candidates = ['  Music   Videos ', '\\u00a0Straße\\u2003Videos ', 'İstanbul', 'Σςσ',
              '😀' * 64, '😀' * 65, 'bad,tag', '', '\\ud800', '<img src=x onerror=alert(1)>']
previous = None
for code in range(0x110000):
    character = chr(code)
    category = unicodedata.category(character)
    if character.casefold() != character or character.isspace():
        candidates.append(character)
    if category != previous:
        candidates.extend([character, chr(max(0, code - 1))])
    previous = category
results = []
for value in candidates:
    try:
        name, key = vdl._validated_tag_name(value)
        results.append([value, {'name': name, 'key': key}])
    except ValueError:
        results.append([value, None])
print(json.dumps({'version': vdl.TAG_IDENTITY_VERSION, 'cases': results}, ensure_ascii=True))
`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    const context = vm.createContext({});
    vm.runInContext(source, context);
    const identity = context.VDL.tagIdentity;
    assert.equal(identity.useVersion(data.version), true, `missing server tables: ${data.version}`);
    for (const [input, expected] of data.cases) {
        if (expected === null) assert.throws(() => identity.normalize(input), JSON.stringify(input));
        else assert.deepEqual(JSON.parse(JSON.stringify(identity.normalize(input))), expected, JSON.stringify(input));
    }
});
