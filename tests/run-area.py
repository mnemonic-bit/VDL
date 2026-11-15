#!/usr/bin/env python3
"""Select reviewed functional test areas without discovering or importing tests."""

import argparse
import json
import keyword
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
LAYERS = ('python', 'node', 'browser', 'media', 'container')
CONTAINER_CHECKS = {
    'companion-states': 'tests/container/check-companion-states.py',
    'dependency-lock': 'tests/container/check-lock.sh',
    'preview-maintenance': 'tests/container/check-preview-maintenance.py',
    'smoke': 'tests/container/smoke.sh',
}
# These directories contain prerequisites, fixture inputs, or generated artifacts.
EXCLUDED_DIRS = frozenset({
    'node_modules', '__pycache__', 'fixtures', 'support', 'test-results',
    'playwright-report', 'blob-report', '.fixture-media', 'generated',
    'dist', 'htmlcov', '.venv', 'venv',
})


class MapError(ValueError):
    """A command, map, or selection violates the area contract."""


class PrerequisiteError(RuntimeError):
    """A selected execution tool or native dependency is unavailable."""


def _keys(value, expected, location):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise MapError(f'{location}: expected exactly keys {", ".join(expected)}')


def _string(value, location):
    if not isinstance(value, str) or not value.strip():
        raise MapError(f'{location}: expected a nonempty string')


def _list(value, location):
    if not isinstance(value, list):
        raise MapError(f'{location}: expected a list')


def _path(value, root, location):
    _string(value, location)
    path = PurePosixPath(value)
    if (path.is_absolute() or '\\' in value or '\x00' in value
            or ':' in value or any(part in ('', '.', '..') for part in value.split('/'))
            or path.as_posix() != value):
        raise MapError(f'{location}: expected a normalized repository-relative POSIX path: {value!r}')
    resolved = (root / value).resolve()
    if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
        raise MapError(f'{location}: missing regular file or path outside repository: {value}')
    return path


def _layer_for(path):
    parts = path.parts
    if not parts or parts[0] != 'tests' or any(part in EXCLUDED_DIRS for part in parts[1:-1]):
        return None
    if path.name.startswith('test_') and path.suffix == '.py':
        return 'media' if len(parts) > 2 and parts[1] == 'integration' else 'python'
    if path.name.endswith('.test.cjs'):
        return 'node'
    if len(parts) > 2 and parts[1] == 'browser' and path.name.endswith('.spec.cjs'):
        return 'browser'
    return None


def _selector(value, layer, root, location):
    _string(value, location)
    if layer == 'container':
        if value not in CONTAINER_CHECKS:
            raise MapError(f'{location}: unknown fixed container check {value!r}')
        _path(CONTAINER_CHECKS[value], root, location)
        return
    path = _path(value, root, location)
    if _layer_for(path) != layer:
        raise MapError(f'{location}: wrong layer or suffix for {value!r} ({layer})')
    if layer in ('python', 'media'):
        components = (*path.parts[:-1], path.stem)
        if any(not part.isidentifier() or keyword.iskeyword(part) for part in components):
            raise MapError(f'{location}: Python test path has no unambiguous importable module: {value}')
        for index in range(1, len(components)):
            if (root.joinpath(*components[:index]).with_suffix('.py')).exists():
                raise MapError(f'{location}: ambiguous Python module path: {value}')
        if (root.joinpath(*components) / '__init__.py').is_file():
            raise MapError(f'{location}: ambiguous Python module and package: {value}')


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise MapError(f'duplicate JSON object key: {key}')
        result[key] = value
    return result


def load_map(path, root, check_inventory=False):
    try:
        with Path(path).open(encoding='utf-8') as source:
            data = json.load(source, object_pairs_hook=_unique_pairs)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MapError(f'Cannot read area map {path}: {error}') from error
    return validate_map(data, Path(root), check_inventory=check_inventory)


def validate_map(data, root, check_inventory=False):
    root = Path(root)
    _keys(data, ('schema_version', 'areas'), 'map')
    if type(data['schema_version']) is not int or data['schema_version'] != 1:
        raise MapError('schema_version: expected supported integer version 1')
    areas = data['areas']
    if not isinstance(areas, dict) or not areas:
        raise MapError('areas: expected a nonempty object')
    for area_id, area in areas.items():
        if not isinstance(area_id, str) or not re.fullmatch(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*', area_id):
            raise MapError(f'invalid area ID: {area_id!r}')
        _keys(area, ('summary', 'source_hints', 'tests', 'expands_to'), area_id)
        _string(area['summary'], f'{area_id}.summary')
        _list(area['source_hints'], f'{area_id}.source_hints')
        if not area['source_hints']:
            raise MapError(f'{area_id}.source_hints: at least one source hint is required')
        for hint in area['source_hints']:
            _keys(hint, ('path', 'scope'), f'{area_id}.source_hints')
            _string(hint['scope'], f'{area_id}.source_hints.scope')
            _path(hint['path'], root, f'{area_id}.source_hints.path')
        _keys(area['tests'], LAYERS, f'{area_id}.tests')
        for layer, selectors in area['tests'].items():
            _list(selectors, f'{area_id}.tests.{layer}')
            seen = set()
            for selector in selectors:
                _selector(selector, layer, root, f'{area_id}.tests.{layer}')
                if selector in seen:
                    raise MapError(f'{area_id}.tests.{layer}: duplicate selector {selector}')
                seen.add(selector)
        _list(area['expands_to'], f'{area_id}.expands_to')
        targets = set()
        for edge in area['expands_to']:
            _keys(edge, ('area', 'reason'), f'{area_id}.expands_to')
            _string(edge['area'], f'{area_id}.expands_to.area')
            _string(edge['reason'], f'{area_id}.expands_to.reason')
            if edge['area'] not in areas:
                raise MapError(f'{area_id}: missing expansion target {edge["area"]!r}')
            if edge['area'] in targets:
                raise MapError(f'{area_id}: duplicate expansion target {edge["area"]!r}')
            targets.add(edge['area'])
        if not targets and not any(area['tests'].values()):
            raise MapError(f'{area_id}: requires at least one selector or expansion')
    visited = set()
    active = []

    def visit(area_id):
        if area_id in active:
            raise MapError('expansion cycle: ' + ' -> '.join(active + [area_id]))
        if area_id in visited:
            return
        active.append(area_id)
        for edge in sorted(areas[area_id]['expands_to'], key=lambda item: item['area']):
            visit(edge['area'])
        active.pop()
        visited.add(area_id)

    for area_id in sorted(areas):
        visit(area_id)
    if check_inventory:
        inventory = discover_inventory(root)
        mapped = {layer: set() for layer in LAYERS}
        for area in areas.values():
            for layer in LAYERS:
                mapped[layer].update(area['tests'][layer])
        missing = [f'{layer}: {selector}' for layer in LAYERS
                   for selector in sorted(inventory[layer] - mapped[layer])]
        if missing:
            raise MapError('Unmapped test files/checks:\n' + '\n'.join(missing))
    return data


def discover_inventory(root):
    inventory = {layer: set() for layer in LAYERS}
    inventory['container'].update(CONTAINER_CHECKS)
    for directory, directories, filenames in os.walk(Path(root) / 'tests'):
        directories[:] = sorted(name for name in directories if name not in EXCLUDED_DIRS)
        for filename in filenames:
            path = (Path(directory) / filename).relative_to(root)
            layer = _layer_for(PurePosixPath(path.as_posix()))
            # Ownership checks must surface misplaced specs rather than hide them.
            if layer is None and filename.endswith('.spec.cjs'):
                layer = 'browser'
            if layer:
                inventory[layer].add(path.as_posix())
    return inventory


def _python():
    return os.environ.get('VDL_PYTHON') or sys.executable


def _command(layer, argv, env=None, prerequisites=None):
    return {'layer': layer, 'argv': argv, 'cwd': '.', 'env': env or {},
            'prerequisites': prerequisites or []}


def _commands(root, selected):
    python = _python()
    commands = []
    app = 'Native selected Python with requirements.txt (Flask and yt-dlp)'
    if selected['python']:
        modules = [path[:-3].replace('/', '.') for path in selected['python']]
        commands.append(_command('python', [python, '-m', 'unittest', *modules, '-v'], prerequisites=[app]))
    if selected['node']:
        commands.append(_command('node', ['node', '--test', *selected['node']],
                                 {'VDL_PYTHON': python},
                                 [app, 'Node.js and root tooling dependencies (npm ci)']))
    if selected['browser']:
        # Playwright applies file arguments as regexes to absolute filenames.
        specs = ['^' + re.escape(str((root / path).resolve())) + '$' for path in selected['browser']]
        browser_env = {'VDL_PYTHON': python}
        for name in ('VDL_TEST_BROWSER', 'PLAYWRIGHT_CLI'):
            if name in os.environ:
                browser_env[name] = os.environ[name]
        commands.append(_command('browser', [python, 'tests/browser/run.py', *specs],
                                 browser_env,
                                 [app, 'Playwright CLI and @playwright/test',
                                  'Installed browser: ' + os.environ.get('VDL_TEST_BROWSER', 'chromium'),
                                  'Spec arguments are escaped absolute regexes anchored at both ends; '
                                  'relative suffix matching could also select nested files']))
    if selected['media']:
        modules = [path[:-3].replace('/', '.') for path in selected['media']]
        commands.append(_command('media', [python, '-m', 'unittest', *modules, '-v'],
                                 {'VDL_RUN_MEDIA': '1', 'VDL_REQUIRE_MEDIA_TOOLS': '1'},
                                 [app, 'ffmpeg and ffprobe on PATH']))
    for check in selected['container']:
        script = CONTAINER_CHECKS[check]
        argv = [python, script] if script.endswith('.py') else [script]
        prerequisites = ['Docker or Podman; script-specific prerequisites']
        if check == 'smoke':
            argv.append('--build')
            prerequisites.append('Builds current sources; may pull image dependencies over the network')
        elif check == 'preview-maintenance':
            argv.extend(['--image', os.environ.get('VDL_IMAGE', 'vdl:local')])
            prerequisites.append('Build the image from current sources first; tag presence does not establish freshness')
        elif check == 'dependency-lock':
            prerequisites = ['Python with pip; package-index network access; downloads wheels without installation']
        elif check == 'companion-states':
            prerequisites.append('Git and package artifacts; builds images and may fetch image dependencies')
        container_env = {name: os.environ[name] for name in
                         ('CONTAINER_ENGINE', 'VDL_IMAGE', 'VDL_LOCK_PYTHON') if name in os.environ}
        commands.append(_command('container', argv, env=container_env, prerequisites=prerequisites))
    return commands


def build_plan(data, root, areas, layers=None, all_areas=False):
    root = Path(root)
    available = data['areas']
    if all_areas and areas:
        raise MapError('--all-areas cannot be combined with positional area IDs')
    requested = sorted(available if all_areas else set(areas))
    if not requested:
        raise MapError('Select at least one area or --all-areas')
    unknown = set(requested) - available.keys()
    if unknown:
        raise MapError('Unknown areas: ' + ', '.join(sorted(unknown)))
    if layers is not None and (not layers or set(layers) - set(LAYERS)):
        raise MapError('Unknown or empty layers: ' + ', '.join(sorted(set(layers) - set(LAYERS))))
    chosen_layers = [layer for layer in LAYERS if layer in (layers if layers is not None else ('python', 'node'))]
    expanded = set()
    expansions = {}

    def expand(area_id):
        if area_id in expanded:
            return
        expanded.add(area_id)
        for edge in available[area_id]['expands_to']:
            expansions[(area_id, edge['area'])] = {'from': area_id, 'to': edge['area'], 'reason': edge['reason']}
            expand(edge['area'])

    for area_id in requested:
        expand(area_id)
    owners = {layer: {} for layer in LAYERS}
    for area_id in sorted(expanded):
        for layer in LAYERS:
            for selector in available[area_id]['tests'][layer]:
                owners[layer].setdefault(selector, []).append(area_id)
    if layers is not None:
        for layer in chosen_layers:
            if not owners[layer]:
                raise MapError(f'Explicit layer {layer} has no selectors in the expanded area union')
    selectors = [{'layer': layer, 'selector': selector, 'areas': owners[layer][selector]}
                 for layer in chosen_layers for selector in sorted(owners[layer])]
    if not selectors:
        raise MapError('Selection has no selectors in the requested layers')
    selected = {layer: sorted(owners[layer]) if layer in chosen_layers else [] for layer in LAYERS}
    return {
        'schema_version': 1,
        'requested_areas': requested,
        'expanded_areas': sorted(expanded),
        'expansions': [expansions[key] for key in sorted(expansions)],
        'layers': chosen_layers,
        'layer_selection': 'default' if layers is None else 'explicit',
        'selectors': selectors,
        'commands': _commands(root, selected),
        'omitted_layers': [layer for layer in LAYERS if layer not in chosen_layers and owners[layer]],
        'omitted_selectors': {layer: sorted(owners[layer]) for layer in LAYERS
                              if layer not in chosen_layers and owners[layer]},
    }


def print_plan(plan):
    print('Requested areas: ' + ', '.join(plan['requested_areas']))
    print('Expanded areas: ' + ', '.join(plan['expanded_areas']))
    print(f'Layers ({plan["layer_selection"]}): ' + ', '.join(plan['layers']))
    for edge in plan['expansions']:
        print(f'  {edge["from"]} -> {edge["to"]}: {edge["reason"]}')
    for layer in plan['layers']:
        selectors = [item for item in plan['selectors'] if item['layer'] == layer]
        print(f'{layer}: {len(selectors)} file/check(s)')
        for item in selectors:
            owners = ', '.join(item['areas'])
            direct = ', '.join(area for area in item['areas'] if area in plan['requested_areas'])
            print(f'  {item["selector"]} [areas: {owners}]' + (f' [direct: {direct}]' if direct else ' [expanded above]'))
    print('Available but omitted layers: ' + (', '.join(plan['omitted_layers']) or 'none'))
    for layer in plan['omitted_layers']:
        selectors = plan['omitted_selectors'][layer]
        print(f'  Omitted {layer}: {len(selectors)} file/check(s): ' + ', '.join(selectors))
    for command in plan['commands']:
        print(f'Command ({command["layer"]}, cwd={command["cwd"]}): {shlex.join(command["argv"])}')
        if command['env']:
            print('  Environment overrides: ' + json.dumps(command['env'], sort_keys=True))
        for requirement in command['prerequisites']:
            print('  Prerequisite: ' + requirement)
    print('Focused results do not satisfy completion gates by themselves.')
    print('Plan prerequisites are intended requirements, not availability checks.')
    sys.stdout.flush()


def _probe(argv, root, guidance, env=None):
    try:
        result = subprocess.run(argv, cwd=root, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PrerequisiteError(f'{guidance}: {error}') from error
    if result.returncode:
        raise PrerequisiteError(guidance)


def _require_tool(tool, guidance):
    if not tool or not shutil.which(tool):
        raise PrerequisiteError(guidance)


def preflight(plan, root):
    root = Path(root)
    layers = {command['layer'] for command in plan['commands']}
    python = _python()
    if layers & {'python', 'node', 'browser', 'media'}:
        _require_tool(python, 'Set VDL_PYTHON to a native Python interpreter with requirements.txt installed')
        _probe([python, '-c', 'import flask, yt_dlp'], root,
               'Install requirements.txt in the selected native Python; no container fallback is used')
    if 'node' in layers or 'browser' in layers:
        _require_tool('node', 'Install Node.js before running Node or browser layers')
    if 'node' in layers:
        try:
            dependencies = json.loads((root / 'package.json').read_text(encoding='utf-8')).get('devDependencies', {})
        except (OSError, ValueError) as error:
            raise PrerequisiteError(f'Cannot read root tooling dependencies: {error}') from error
        _probe(['node', '-e', 'for (const name of JSON.parse(process.argv[1])) require.resolve(name);',
                json.dumps(sorted(dependencies))], root, 'Install root tooling dependencies with npm ci')
    if 'browser' in layers:
        env = os.environ.copy()
        explicit = env.get('PLAYWRIGHT_CLI')
        local = root / 'tests/browser/node_modules/.bin/playwright'
        cli = explicit or (str(local) if local.is_file() else '/usr/bin/playwright')
        _require_tool(cli, 'Install browser tooling in tests/browser with npm ci, or set PLAYWRIGHT_CLI')
        if not explicit and cli == '/usr/bin/playwright':
            env['NODE_PATH'] = os.pathsep.join(filter(None, (env.get('NODE_PATH'), '/usr/lib/node_modules')))
        browser = env.get('VDL_TEST_BROWSER', 'chromium')
        if browser not in ('chromium', 'firefox', 'webkit'):
            raise PrerequisiteError(f'Unsupported VDL_TEST_BROWSER: {browser}')
        script = ('const fs = require("node:fs"); const pw = require("@playwright/test"); '
                  'fs.accessSync(pw[process.argv[1]].executablePath(), fs.constants.X_OK);')
        _probe(['node', '-e', script, browser], root / 'tests/browser',
               f'Install @playwright/test and the selected browser with npx playwright install {browser}', env)
    if 'media' in layers:
        for tool in ('ffmpeg', 'ffprobe'):
            _require_tool(tool, f'Install ffmpeg/ffprobe before running media checks (missing {tool})')
    for command in plan['commands']:
        if command['layer'] != 'container':
            continue
        argv = command['argv']
        script = next(value for value in argv if value.startswith('tests/container/'))
        if script.endswith('.sh'):
            _require_tool('sh', 'Install a POSIX shell before running container shell checks')
        if script.endswith('check-lock.sh'):
            for tool in ('mktemp', 'mkdir', 'rm'):
                _require_tool(tool, f'Install {tool} before running dependency-lock')
            lock_python = os.environ.get('VDL_LOCK_PYTHON', 'python3')
            _require_tool(lock_python, 'Install Python/pip or set VDL_LOCK_PYTHON for dependency-lock')
            _probe([lock_python, '-m', 'pip', '--version'], root, 'Install pip in VDL_LOCK_PYTHON for dependency-lock')
        else:
            engine_names = ('podman', 'docker') if script.endswith('check-preview-maintenance.py') else ('docker', 'podman')
            engine = os.environ.get('CONTAINER_ENGINE') or next(
                (found for name in engine_names if (found := shutil.which(name))), None)
            _require_tool(engine, 'Install Docker/Podman or set CONTAINER_ENGINE for container checks')
            _probe([engine, 'info'], root, 'Start the selected container engine before running container checks')
            if script.endswith('.py'):
                _require_tool(python, 'Set VDL_PYTHON to a Python interpreter for container scripts')
            if script.endswith('check-companion-states.py'):
                _require_tool('git', 'Install Git before running companion-states')
            if script.endswith('smoke.sh') or script.endswith('check-companion-states.py'):
                for tool in ('sh', 'grep', 'date', 'seq', 'cut', 'sleep'):
                    _require_tool(tool, f'Install {tool} before running the container smoke checks')
            if script.endswith('check-preview-maintenance.py'):
                _probe([engine, 'image', 'inspect', os.environ.get('VDL_IMAGE', 'vdl:local')], root,
                       'Build VDL_IMAGE from current sources before preview-maintenance; a tag cannot prove freshness')


def _signal_child(child, sig):
    if os.name == 'posix':
        os.killpg(child.pid, sig)
    else:
        child.send_signal(sig)


def _group_alive(child):
    try:
        os.killpg(child.pid, 0)
    except ProcessLookupError:
        return False
    return True


def _wait_group(child, timeout):
    deadline = time.monotonic() + timeout
    while _group_alive(child):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(0.05, remaining))
    return True


def _stop_child(child):
    # A separate session lets fixture and browser descendants clean up together.
    for sig, grace in ((signal.SIGINT, 10), (signal.SIGTERM, 5), (signal.SIGKILL, 1)):
        started = time.monotonic()
        try:
            _signal_child(child, sig)
        except ProcessLookupError:
            child.wait()
            return
        try:
            child.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            pass
        else:
            if os.name != 'posix':
                return
        if os.name == 'posix' and _wait_group(child, max(0, grace - (time.monotonic() - started))):
            return
    child.wait()


def execute_plan(plan, root):
    commands = plan['commands']
    results = [{'status': 'not_run', 'exit_code': None, 'elapsed': 0.0} for _ in commands]
    exit_code = 0
    try:
        preflight(plan, root)
    except (PrerequisiteError, KeyboardInterrupt) as error:
        print(f'Preflight failed: {error}', file=sys.stderr)
        exit_code = 130 if isinstance(error, KeyboardInterrupt) else 1
    else:
        for index, command in enumerate(commands):
            started = time.monotonic()
            child = None
            try:
                env = dict(os.environ, **command['env'])
                child = subprocess.Popen(command['argv'], cwd=Path(root) / command['cwd'], env=env,
                                         start_new_session=(os.name == 'posix'))
                code = child.wait()
                results[index].update(status='passed' if code == 0 else 'failed', exit_code=code)
                if code:
                    exit_code = 1
            except KeyboardInterrupt:
                if child is not None:
                    _stop_child(child)
                results[index].update(status='inconclusive', exit_code=130)
                exit_code = 130
            except OSError as error:
                print(f'Cannot execute command: {error}', file=sys.stderr)
                results[index].update(status='failed', exit_code=1)
                exit_code = 1
            results[index]['elapsed'] = time.monotonic() - started
            if exit_code:
                break
    print('Results (successful commands retain their visible skips):')
    for command, result in zip(commands, results):
        print(f'  {command["layer"]}: {result["status"]}; exit={result["exit_code"]}; '
              f'elapsed={result["elapsed"]:.3f}s; {shlex.join(command["argv"])}')
    return exit_code


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('areas', nargs='*', help='functional area IDs from --list')
    parser.add_argument('--all-areas', action='store_true')
    parser.add_argument('--layer', action='append', choices=LAYERS)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--list', action='store_true')
    modes.add_argument('--check', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_intermixed_args(argv)
    try:
        if (args.list or args.check) and (args.areas or args.all_areas or args.layer or args.dry_run or args.json):
            raise MapError('--list and --check accept no selection or planning flags')
        if args.json and not args.dry_run:
            raise MapError('--json requires --dry-run')
        data = load_map(ROOT / 'tests/areas.json', ROOT, check_inventory=args.check)
        if args.list:
            for area_id, area in sorted(data['areas'].items()):
                print(f'{area_id}: {area["summary"]}')
            return 0
        if args.check:
            inventory = discover_inventory(ROOT)
            print('Area map passed; inventory: ' + ', '.join(f'{layer}={len(inventory[layer])}' for layer in LAYERS)
                  + ' files/checks')
            return 0
        plan = build_plan(data, ROOT, args.areas, args.layer, args.all_areas)
        if args.json:
            print(json.dumps(plan, indent=4, sort_keys=True))
        else:
            print_plan(plan)
        if args.dry_run:
            return 0
        return execute_plan(plan, ROOT)
    except MapError as error:
        print(f'Area selection error: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
