"""Selection and adapter contracts without importing application or test modules."""

import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('vdl_area_runner', ROOT / 'tests/run-area.py')
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
LAYERS = ('python', 'node', 'browser', 'media', 'container')
CHECKS = ('companion-states', 'dependency-lock', 'preview-maintenance', 'smoke')


class AreaFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='vdl area tests ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.write('vdl.py', "raise AssertionError('application imported during selection')\n")
        self.write('tests/__init__.py')
        self.write('tests/integration/__init__.py')
        for filename in ('smoke.sh', 'check-lock.sh', 'check-companion-states.py',
                         'check-preview-maintenance.py'):
            self.write('tests/container/' + filename)
        self.map = {'schema_version': 1, 'areas': {}}

    def write(self, name, text=''):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def area(self, name, tests=None, expands=()):
        members = {layer: [] for layer in LAYERS}
        members.update(tests or {})
        for layer, selectors in members.items():
            if layer != 'container':
                for selector in selectors:
                    self.write(selector)
        area = {
            'summary': name + ' behavior',
            'source_hints': [{'path': 'vdl.py', 'scope': name + ' handlers'}],
            'tests': members,
            'expands_to': [{'area': target, 'reason': reason} for target, reason in expands],
        }
        self.map['areas'][name] = area
        return area

    def save(self, data=None):
        return self.write('tests/areas.json', json.dumps(self.map if data is None else data))

    def plan(self, areas, layers=None, all_areas=False):
        data = runner.validate_map(self.map, self.root)
        return runner.build_plan(data, self.root, areas, layers=layers, all_areas=all_areas)

    def cli(self, argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(runner, 'ROOT', self.root), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                code = runner.main(argv)
            except SystemExit as exc:
                code = exc.code
        return code, stdout.getvalue(), stderr.getvalue()

    def selectors(self, plan, layer):
        return [item['selector'] for item in plan['selectors'] if item['layer'] == layer]


class SelectionTests(AreaFixture):
    def test_diamond_expansion_deduplicates_files_and_preserves_every_edge(self):
        shared = 'tests/test_shared.py'
        self.area('alpha', expands=[('beta', 'admission contract'), ('gamma', 'reset contract')])
        self.area('beta', {'python': [shared]}, [('delta', 'receipt contract')])
        self.area('gamma', {'python': [shared]}, [('delta', 'projection contract')])
        self.area('delta', {'python': ['tests/test_delta.py']})
        first = self.plan(['alpha', 'gamma', 'alpha'], ['python', 'python'])
        second = self.plan(['gamma', 'alpha'], ['python'])
        self.assertEqual(first, second)
        self.assertEqual(first['requested_areas'], ['alpha', 'gamma'])
        self.assertEqual(set(first['expanded_areas']), {'alpha', 'beta', 'gamma', 'delta'})
        self.assertEqual(self.selectors(first, 'python'), ['tests/test_delta.py', shared])
        item = next(item for item in first['selectors'] if item['selector'] == shared)
        self.assertEqual(item['areas'], ['beta', 'gamma'])
        self.assertEqual(first['expansions'], [
            {'from': 'alpha', 'to': 'beta', 'reason': 'admission contract'},
            {'from': 'alpha', 'to': 'gamma', 'reason': 'reset contract'},
            {'from': 'beta', 'to': 'delta', 'reason': 'receipt contract'},
            {'from': 'gamma', 'to': 'delta', 'reason': 'projection contract'},
        ])
        self.assertEqual(len(first['commands']), 1)

    def test_expansion_is_directional(self):
        self.area('core', expands=[('leaf', 'shared admission')])
        self.area('leaf', {'python': ['tests/test_leaf.py']})
        self.assertEqual(self.plan(['leaf'])['expanded_areas'], ['leaf'])
        self.assertEqual(self.plan(['leaf'])['expansions'], [])

    def test_default_layers_explicit_replacement_and_omissions(self):
        self.area('leaf', {
            'python': ['tests/test_leaf.py'], 'node': ['tests/leaf.test.cjs'],
            'browser': ['tests/browser/leaf.spec.cjs'],
            'media': ['tests/integration/test_leaf.py'], 'container': ['smoke'],
        })
        default = self.plan(['leaf'])
        self.assertEqual(default['layers'], ['python', 'node'])
        self.assertEqual(set(default['omitted_layers']), {'browser', 'media', 'container'})
        explicit = self.plan(['leaf'], ['media', 'browser', 'media'])
        self.assertEqual(explicit['layers'], ['browser', 'media'])
        self.assertEqual([command['layer'] for command in explicit['commands']], ['browser', 'media'])
        self.assertEqual(self.selectors(explicit, 'python'), [])

    def test_filtering_occurs_after_union_and_expansion(self):
        self.area('python-only', {'python': ['tests/test_leaf.py']})
        self.area('node-only', {'node': ['tests/leaf.test.cjs']})
        self.area('shared', expands=[('python-only', 'server consumer'), ('node-only', 'client consumer')])
        self.assertEqual(self.plan(['shared'], ['node'])['layers'], ['node'])
        self.assertEqual(self.plan(['python-only', 'node-only'], ['node'])['layers'], ['node'])
        self.assertEqual(self.plan(['python-only'])['layers'], ['python', 'node'])
        with self.assertRaisesRegex(runner.MapError, 'node'):
            self.plan(['python-only'], ['node'])
        with self.assertRaisesRegex(runner.MapError, 'node'):
            self.plan(['python-only'], ['python', 'node'])

    def test_empty_and_unknown_selections_launch_nothing(self):
        self.area('browser-only', {'browser': ['tests/browser/leaf.spec.cjs']})
        self.save()
        invalid = [[], ['missing'], ['browser-only'], ['browser-only', '--layer', 'unknown'],
                   ['--dry-run'], ['--json'], ['--all-areas', 'browser-only'],
                   ['--list', 'browser-only'], ['--check', '--layer', 'python'],
                   ['--list', '--dry-run'], ['--check', '--list'],
                   ['browser-only', '--layer', 'python']]
        with mock.patch.object(runner.subprocess, 'Popen') as launch, \
                mock.patch.object(runner.subprocess, 'run') as probe:
            for argv in invalid:
                with self.subTest(argv=argv):
                    code, _, stderr = self.cli(argv)
                    self.assertEqual(code, 2, stderr)
                    self.assertTrue(stderr)
            launch.assert_not_called()
            probe.assert_not_called()

    def test_all_areas_and_reordered_inputs_have_identical_plans(self):
        self.area('beta', {'python': ['tests/test_beta.py']})
        self.area('alpha', {'node': ['tests/alpha.test.cjs']})
        self.assertEqual(self.plan([], all_areas=True), self.plan(['beta', 'alpha']))
        self.assertEqual(self.plan(['beta', 'alpha'], ['node', 'python']),
                         self.plan(['alpha', 'beta'], ['python', 'node']))
        self.save()
        first = self.cli(['beta', '--layer', 'python', 'alpha', '--layer', 'node',
                          '--dry-run', '--json'])
        second = self.cli(['--layer', 'node', 'alpha', 'beta', '--layer', 'python',
                           '--dry-run', '--json'])
        self.assertEqual(first[0], 0, first[2])
        self.assertEqual(second[0], 0, second[2])
        self.assertEqual(json.loads(first[1]), json.loads(second[1]))

    def test_json_and_human_plans_do_not_preflight_or_execute(self):
        self.area('leaf', {'python': ['tests/test_leaf.py'], 'container': ['dependency-lock']})
        self.save()
        with mock.patch.object(runner, 'preflight', side_effect=AssertionError('preflight')), \
                mock.patch.object(runner, 'execute_plan', side_effect=AssertionError('execute')), \
                mock.patch.object(runner.subprocess, 'Popen', side_effect=AssertionError('process')), \
                mock.patch.object(socket, 'socket', side_effect=AssertionError('network')):
            code, output, stderr = self.cli(['leaf', '--dry-run', '--json'])
            self.assertEqual(code, 0, stderr)
            parsed = json.loads(output)
            self.assertEqual(parsed['schema_version'], 1)
            self.assertEqual(self.selectors(parsed, 'python'), ['tests/test_leaf.py'])
            code, output, stderr = self.cli(['leaf', '--dry-run'])
            self.assertEqual(code, 0, stderr)
            for term in ('leaf', 'tests/test_leaf.py', 'completion', 'container'):
                self.assertIn(term, output)


class MapValidationTests(AreaFixture):
    def setUp(self):
        super().setUp()
        self.area('leaf', {'python': ['tests/test_leaf.py']})

    def test_schema_rejects_unknown_keys_bad_types_and_malformed_fields(self):
        cases = [
            ('schema-version', lambda d: d.update(schema_version=2)),
            ('boolean-version', lambda d: d.update(schema_version=True)),
            ('root-key', lambda d: d.update(extra=[])),
            ('empty-areas', lambda d: d.update(areas={})),
            ('areas-type', lambda d: d.update(areas=[])),
            ('area-id', lambda d: d['areas'].update({'Bad_ID': d['areas'].pop('leaf')})),
            ('area-key', lambda d: d['areas']['leaf'].update(extra=True)),
            ('summary', lambda d: d['areas']['leaf'].update(summary=' ')),
            ('hints', lambda d: d['areas']['leaf'].update(source_hints=[])),
            ('scope', lambda d: d['areas']['leaf']['source_hints'][0].update(scope='')),
            ('hint-key', lambda d: d['areas']['leaf']['source_hints'][0].update(extra=1)),
            ('layer-key', lambda d: d['areas']['leaf']['tests'].update(unknown=[])),
            ('missing-layer', lambda d: d['areas']['leaf']['tests'].pop('node')),
            ('selector-type', lambda d: d['areas']['leaf']['tests'].update(python='tests/test_leaf.py')),
            ('duplicate-selector', lambda d: d['areas']['leaf']['tests']['python'].append('tests/test_leaf.py')),
            ('empty-area', lambda d: d['areas']['leaf']['tests'].update(python=[])),
            ('unknown-edge', lambda d: d['areas']['leaf']['expands_to'].append({'area': 'missing', 'reason': 'shared'})),
            ('empty-reason', lambda d: d['areas']['leaf']['expands_to'].append({'area': 'leaf', 'reason': ''})),
            ('unknown-container', lambda d: d['areas']['leaf']['tests'].update(container=['shell command'])),
        ]
        for name, mutate in cases:
            with self.subTest(name=name):
                data = copy.deepcopy(self.map)
                mutate(data)
                self.save(data)
                with mock.patch.object(runner.subprocess, 'Popen') as launch:
                    code, _, stderr = self.cli(['leaf', '--dry-run'])
                self.assertEqual(code, 2, stderr)
                self.assertTrue(stderr)
                launch.assert_not_called()

    def test_duplicate_json_keys_are_rejected_at_every_level(self):
        valid = json.dumps(self.map)
        for text in ('{"schema_version":1,' + valid[1:],
                     valid.replace('"summary":', '"summary":"first", "summary":'),
                     valid.replace('"python":', '"python":[], "python":')):
            self.write('tests/areas.json', text)
            with self.subTest(text=text):
                code, _, stderr = self.cli(['leaf', '--dry-run'])
                self.assertEqual(code, 2)
                self.assertIn('duplicate', stderr.lower())

    def test_cycles_self_edges_and_duplicate_edges_name_the_path(self):
        self.area('other', {'node': ['tests/other.test.cjs']})
        cases = [
            [('leaf', 'self contract')],
            [('other', 'first contract'), ('other', 'second contract')],
        ]
        for edges in cases:
            with self.subTest(edges=edges):
                data = copy.deepcopy(self.map)
                data['areas']['leaf']['expands_to'] = [{'area': a, 'reason': r} for a, r in edges]
                with self.assertRaisesRegex(runner.MapError, 'leaf|other'):
                    runner.validate_map(data, self.root)
        self.map['areas']['leaf']['expands_to'] = [{'area': 'other', 'reason': 'first'}]
        self.map['areas']['other']['expands_to'] = [{'area': 'leaf', 'reason': 'second'}]
        with self.assertRaisesRegex(runner.MapError, 'leaf.*other.*leaf|other.*leaf.*other'):
            runner.validate_map(self.map, self.root)

    def test_rejects_unsafe_missing_and_wrong_layer_paths(self):
        bad_paths = [
            '/tmp/test_escape.py', '../test_escape.py', 'tests/../test_escape.py',
            'tests//test_leaf.py', './tests/test_leaf.py', 'tests\\test_leaf.py',
            'tests/test_missing.py', 'tests/test_leaf.py/child', 'tests/*.py',
            'tests/not_a_test.py', 'tests/support/test_hidden.py',
            'tests/integration/test_media.py', 'tests/bad-name/test_leaf.py',
        ]
        self.write('tests/not_a_test.py')
        self.write('tests/support/test_hidden.py')
        self.write('tests/integration/test_media.py')
        self.write('tests/bad-name/test_leaf.py')
        for path in bad_paths:
            with self.subTest(path=path):
                data = copy.deepcopy(self.map)
                data['areas']['leaf']['tests']['python'] = [path]
                with self.assertRaises(runner.MapError):
                    runner.validate_map(data, self.root)
        for layer, path in [('browser', 'tests/leaf.spec.cjs'),
                            ('node', 'tests/browser/leaf.spec.cjs'),
                            ('media', 'tests/test_leaf.py')]:
            self.write(path)
            data = copy.deepcopy(self.map)
            data['areas']['leaf']['tests'][layer] = [path]
            with self.subTest(layer=layer), self.assertRaises(runner.MapError):
                runner.validate_map(data, self.root)

    def test_rejects_missing_source_and_symlinks_escaping_repository(self):
        for path in ('missing.py', '../vdl.py', '/tmp/vdl.py'):
            data = copy.deepcopy(self.map)
            data['areas']['leaf']['source_hints'][0]['path'] = path
            with self.subTest(path=path), self.assertRaises(runner.MapError):
                runner.validate_map(data, self.root)
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / 'test_external.py'
            target.write_text('', encoding='utf-8')
            (self.root / 'tests/test_external.py').symlink_to(target)
            self.map['areas']['leaf']['tests']['python'] = ['tests/test_external.py']
            with self.assertRaises(runner.MapError):
                runner.validate_map(self.map, self.root)

    def test_python_paths_require_importable_unambiguous_module_names(self):
        for path in ('tests/test_has.dot.py', 'tests/class/test_leaf.py',
                     'tests/1nested/test_leaf.py'):
            self.write(path)
            data = copy.deepcopy(self.map)
            data['areas']['leaf']['tests']['python'] = [path]
            with self.subTest(path=path), self.assertRaises(runner.MapError):
                runner.validate_map(data, self.root)
        self.write('tests/nested/__init__.py')
        self.map['areas']['leaf']['tests']['python'] = ['tests/nested/test_leaf.py']
        self.write('tests/nested/test_leaf.py')
        self.assertIn('tests.nested.test_leaf', self.plan(['leaf'])['commands'][0]['argv'])

    def test_check_catches_nested_orphans_and_unassigned_fixed_checks(self):
        self.map['areas']['leaf']['tests']['container'] = list(CHECKS)
        runner.validate_map(self.map, self.root, check_inventory=True)
        paths = ['tests/nested/test_new.py', 'tests/nested/new.test.cjs',
                 'tests/browser/nested/new.spec.cjs', 'tests/nested/new.spec.cjs',
                 'tests/integration/nested/test_new.py']
        for path in paths:
            file = self.write(path)
            with self.subTest(path=path), self.assertRaisesRegex(runner.MapError, 'new'):
                runner.validate_map(self.map, self.root, check_inventory=True)
            file.unlink()
        for check in CHECKS:
            self.map['areas']['leaf']['tests']['container'].remove(check)
            with self.subTest(check=check), self.assertRaisesRegex(runner.MapError, check):
                runner.validate_map(self.map, self.root, check_inventory=True)
            self.map['areas']['leaf']['tests']['container'].append(check)

    def test_inventory_exclusions_are_explicit_and_do_not_hide_new_directories(self):
        self.map['areas']['leaf']['tests']['container'] = list(CHECKS)
        excluded = ['support', 'fixtures', 'node_modules', '__pycache__', 'test-results',
                    'playwright-report']
        for directory in excluded:
            self.write(f'tests/{directory}/test_generated.py')
            self.write(f'tests/browser/{directory}/generated.spec.cjs')
        runner.validate_map(self.map, self.root, check_inventory=True)
        self.write('tests/new_feature/test_unmapped.py')
        with self.assertRaisesRegex(runner.MapError, 'test_unmapped'):
            runner.validate_map(self.map, self.root, check_inventory=True)

    def test_deleted_or_moved_references_fail(self):
        (self.root / 'tests/test_leaf.py').rename(self.root / 'tests/test_moved.py')
        with self.assertRaisesRegex(runner.MapError, 'test_leaf'):
            runner.validate_map(self.map, self.root, check_inventory=True)

    def test_list_and_check_have_no_process_network_or_application_side_effects(self):
        self.map['areas']['leaf']['tests']['container'] = list(CHECKS)
        self.save()
        before = sorted(path.relative_to(self.root).as_posix() for path in self.root.rglob('*'))
        with mock.patch.object(runner.subprocess, 'Popen', side_effect=AssertionError('process')), \
                mock.patch.object(runner.subprocess, 'run', side_effect=AssertionError('process')), \
                mock.patch.object(socket, 'socket', side_effect=AssertionError('network')):
            for argv in (['--list'], ['--check']):
                code, _, stderr = self.cli(argv)
                self.assertEqual(code, 0, stderr)
        after = sorted(path.relative_to(self.root).as_posix() for path in self.root.rglob('*'))
        self.assertEqual(before, after)


class AdapterPlanTests(AreaFixture):
    def test_python_node_and_media_argv_batch_only_selected_files(self):
        self.area('leaf', {'python': ['tests/test_beta.py', 'tests/test_alpha.py'],
                           'node': ['tests/beta.test.cjs', 'tests/alpha.test.cjs'],
                           'media': ['tests/integration/test_media.py']})
        with mock.patch.dict(os.environ, {'VDL_PYTHON': '/native python/bin/python'}):
            plan = self.plan(['leaf'], ['media', 'node', 'python'])
        python, node, media = plan['commands']
        self.assertEqual(python['argv'], ['/native python/bin/python', '-m', 'unittest',
                                        'tests.test_alpha', 'tests.test_beta', '-v'])
        self.assertEqual(node['argv'], ['node', '--test', 'tests/alpha.test.cjs', 'tests/beta.test.cjs'])
        self.assertEqual(node['env']['VDL_PYTHON'], '/native python/bin/python')
        self.assertEqual(media['argv'], ['/native python/bin/python', '-m', 'unittest',
                                       'tests.integration.test_media', '-v'])
        self.assertEqual(media['env']['VDL_RUN_MEDIA'], '1')
        self.assertEqual(media['env']['VDL_REQUIRE_MEDIA_TOOLS'], '1')
        for command in plan['commands']:
            self.assertEqual(command['cwd'], '.')
            self.assertNotIn('coverage', ' '.join(command['argv']))
            self.assertNotIn('discover', command['argv'])

    def test_unset_python_uses_current_interpreter_for_parity(self):
        self.area('leaf', {'python': ['tests/test_leaf.py'], 'node': ['tests/leaf.test.cjs']})
        with mock.patch.dict(os.environ, {}, clear=True):
            plan = self.plan(['leaf'])
        self.assertEqual(plan['commands'][0]['argv'][0], sys.executable)
        self.assertEqual(plan['commands'][1]['env']['VDL_PYTHON'], sys.executable)

    def test_browser_regex_matches_only_exact_selected_filenames(self):
        selected = 'tests/browser/nested/rename+[draft].spec.cjs'
        self.area('leaf', {'browser': [selected]})
        self.write('tests/browser/nested/rename+[draft].spec.cjs.extra.spec.cjs')
        with mock.patch.dict(os.environ, {'VDL_PYTHON': '/native python/bin/python',
                                         'VDL_TEST_BROWSER': 'firefox',
                                         'PLAYWRIGHT_CLI': '/tools/playwright'}):
            plan = self.plan(['leaf'], ['browser'])
        command = plan['commands'][0]
        self.assertEqual(command['argv'][:2], ['/native python/bin/python', 'tests/browser/run.py'])
        self.assertEqual(command['env']['VDL_PYTHON'], '/native python/bin/python')
        self.assertEqual(len(command['argv']), 3)
        pattern = command['argv'][2]
        exact = str(self.root / selected)
        self.assertIsNotNone(re.search(pattern, exact))
        for other in (exact + '.extra.spec.cjs', exact.replace('rename+', 'renameee'),
                      exact.replace('nested/', 'other/nested/')):
            self.assertIsNone(re.search(pattern, other), other)

    def test_fixed_container_commands_are_stable_and_expose_network_and_image_requirements(self):
        self.area('leaf', {'container': list(reversed(CHECKS))})
        with mock.patch.dict(os.environ, {'VDL_PYTHON': '/native/python', 'VDL_IMAGE': 'vdl:review'}):
            plan = self.plan(['leaf'], ['container'])
        self.assertEqual([c['argv'] for c in plan['commands']], [
            ['/native/python', 'tests/container/check-companion-states.py'],
            ['tests/container/check-lock.sh'],
            ['/native/python', 'tests/container/check-preview-maintenance.py', '--image', 'vdl:review'],
            ['tests/container/smoke.sh', '--build'],
        ])
        plan_text = json.dumps(plan).lower()
        self.assertIn('network', plan_text)
        self.assertIn('current', plan_text)
        self.assertIn('image', plan_text)


class RepositoryMapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = runner.load_map(ROOT / 'tests/areas.json', ROOT)

    def plan(self, area, layer=None):
        return runner.build_plan(self.data, ROOT, [area], layers=[layer] if layer else None)

    def test_repository_inventory_has_no_orphans(self):
        runner.validate_map(self.data, ROOT, check_inventory=True)
        self.assertIn('tests/test_area_runner.py',
                      self.data['areas']['test-tooling']['tests']['python'])

    def test_rename_exact_plans_and_no_reverse_expansion(self):
        expected = {
            'python': ['tests/test_rename.py', 'tests/test_rename_mutations.py'],
            'node': ['tests/rename-client.test.cjs'],
            'browser': ['tests/browser/rename-feedback.spec.cjs'],
        }
        for layer, selectors in expected.items():
            with self.subTest(layer=layer):
                plan = self.plan('rename', layer)
                self.assertEqual([item['selector'] for item in plan['selectors']], selectors)
                self.assertEqual(plan['expanded_areas'], ['rename'])
                self.assertEqual(plan['expansions'], [])
        with mock.patch.dict(os.environ, {'VDL_PYTHON': '/native/python'}):
            self.assertEqual(self.plan('rename', 'python')['commands'][0]['argv'],
                             ['/native/python', '-m', 'unittest', 'tests.test_rename',
                              'tests.test_rename_mutations', '-v'])
        self.assertEqual(self.plan('rename', 'node')['commands'][0]['argv'],
                         ['node', '--test', 'tests/rename-client.test.cjs'])

    def test_mutation_core_contains_each_implemented_adapter_and_coordinator(self):
        expected = {'tags', 'favorites', 'rename', 'preferences', 'playlists',
                    'download-commands', 'download-submissions', 'uploads',
                    'entry-removal', 'bulk-clear', 'visibility', 'extension-pairing'}
        plan = self.plan('mutation-core')
        self.assertTrue(expected.issubset(set(plan['expanded_areas'])))
        self.assertTrue(expected.issubset({edge['to'] for edge in plan['expansions']
                                         if edge['from'] == 'mutation-core'}))
        self.assertIn('tests/mutations-client.test.cjs',
                      [item['selector'] for item in plan['selectors']])
        for edge in plan['expansions']:
            self.assertTrue(edge['reason'].strip())

    def test_shared_profiles_preserve_reviewed_consumer_sets(self):
        expected = {
            'authentication': {'visibility', 'extension-pairing', 'extension-companion',
                               'history', 'playlists', 'playback', 'uploads',
                               'entry-removal', 'bulk-clear', 'library-storage'},
            'database': {'download-submissions', 'download-commands', 'download-lifecycle',
                         'uploads', 'ingest', 'history', 'tags', 'favorites', 'rename',
                         'visibility', 'entry-removal', 'bulk-clear', 'playlists',
                         'playback', 'library-rotation', 'library-storage', 'asset-queue',
                         'thumbnails', 'hover-previews', 'preview-maintenance',
                         'preferences', 'authentication', 'extension-pairing'},
            'file-ownership': {'rename', 'entry-removal', 'bulk-clear', 'uploads', 'ingest',
                               'playback', 'hover-previews', 'preview-maintenance', 'library-storage'},
            'playback-core': {'playback', 'crossfade', 'shuffle-clips', 'skip-video-edges',
                              'playlists', 'library-rotation', 'duration-filter'},
            'asset-protocol': {'asset-queue', 'thumbnails', 'hover-previews',
                              'preview-maintenance', 'live-refresh'},
            'client-state-core': {'tags', 'favorites', 'rename', 'preferences', 'playlists',
                                  'download-commands', 'download-submissions', 'uploads',
                                  'entry-removal', 'bulk-clear', 'visibility',
                                  'extension-pairing', 'live-refresh'},
            'test-support': {'download-lifecycle', 'rename', 'playback', 'history', 'uploads',
                             'asset-queue', 'authentication', 'live-refresh', 'preferences',
                             'extension-companion', 'preview-maintenance'},
        }
        for profile, consumers in expected.items():
            with self.subTest(profile=profile):
                plan = self.plan(profile)
                self.assertTrue(consumers.issubset(set(plan['expanded_areas'])),
                                f'{profile} missing {consumers - set(plan["expanded_areas"])}')


class ExecutionTests(AreaFixture):
    def setUp(self):
        super().setUp()
        self.area('leaf', {'python': ['tests/test_leaf.py'], 'node': ['tests/leaf.test.cjs'],
                           'browser': ['tests/browser/leaf.spec.cjs'],
                           'media': ['tests/integration/test_leaf.py'], 'container': ['smoke']})

    def execute(self, plan):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = runner.execute_plan(plan, self.root)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_success_runs_each_layer_once_with_exact_argv_and_environment(self):
        with mock.patch.dict(os.environ, {'VDL_PYTHON': '/native python/bin/python',
                                         'VDL_TEST_BROWSER': 'firefox',
                                         'PLAYWRIGHT_CLI': '/tools/playwright',
                                         'UNRELATED_SECRET': 'do-not-print'}):
            plan = self.plan(['leaf'], list(LAYERS))
            children = [mock.Mock(**{'wait.return_value': 0}) for _ in plan['commands']]
            with mock.patch.object(runner, 'preflight') as preflight, \
                    mock.patch.object(runner.subprocess, 'Popen', side_effect=children) as launch:
                code, output, stderr = self.execute(plan)
            preflight.assert_called_once_with(plan, self.root)
        self.assertEqual(code, 0, stderr)
        self.assertEqual(launch.call_count, len(plan['commands']))
        self.assertEqual(output.count(': passed;'), len(plan['commands']))
        self.assertNotIn('do-not-print', output + stderr)
        for call, command in zip(launch.call_args_list, plan['commands']):
            self.assertEqual(call.args, (command['argv'],))
            self.assertEqual(call.kwargs['cwd'], self.root)
            self.assertNotIn('shell', call.kwargs)
            for key, value in command['env'].items():
                self.assertEqual(call.kwargs['env'][key], value)
            self.assertEqual(call.kwargs['env']['VDL_PYTHON'], '/native python/bin/python')
        browser_env = launch.call_args_list[2].kwargs['env']
        self.assertEqual(browser_env['VDL_TEST_BROWSER'], 'firefox')
        self.assertEqual(browser_env['PLAYWRIGHT_CLI'], '/tools/playwright')

    def test_child_failure_stops_later_layers_and_reports_exit_codes(self):
        plan = self.plan(['leaf'])
        child = mock.Mock(**{'wait.return_value': 17})
        with mock.patch.object(runner, 'preflight'), \
                mock.patch.object(runner.subprocess, 'Popen', return_value=child) as launch:
            code, output, _ = self.execute(plan)
        self.assertEqual(code, 1)
        launch.assert_called_once()
        self.assertIn('python: failed; exit=17;', output)
        self.assertIn('node: not_run;', output)
        self.assertIn('elapsed=', output)

    def test_missing_prerequisite_prevents_all_test_processes(self):
        plan = self.plan(['leaf'])
        with mock.patch.object(runner, 'preflight', side_effect=runner.PrerequisiteError('Install requirements.txt')), \
                mock.patch.object(runner.subprocess, 'Popen') as launch:
            code, output, stderr = self.execute(plan)
        self.assertEqual(code, 1)
        launch.assert_not_called()
        self.assertIn('Install requirements.txt', stderr)
        self.assertEqual(output.count(': not_run;'), 2)

    def test_preflight_interruption_preserves_nonzero_and_starts_no_tests(self):
        with mock.patch.object(runner, 'preflight', side_effect=KeyboardInterrupt), \
                mock.patch.object(runner.subprocess, 'Popen') as launch:
            code, output, _ = self.execute(self.plan(['leaf']))
        self.assertNotEqual(code, 0)
        launch.assert_not_called()
        self.assertEqual(output.count(': not_run;'), 2)

    def test_runtime_launch_error_is_visible_and_stops_later_layers(self):
        with mock.patch.object(runner, 'preflight'), \
                mock.patch.object(runner.subprocess, 'Popen', side_effect=FileNotFoundError('native Python removed')):
            code, output, stderr = self.execute(self.plan(['leaf']))
        self.assertEqual(code, 1)
        self.assertIn('native Python removed', stderr)
        self.assertIn('python: failed;', output)
        self.assertIn('node: not_run;', output)

    def test_interruption_signals_active_child_and_retains_cleanup(self):
        child = mock.Mock()
        child.wait.side_effect = [KeyboardInterrupt, 130]
        with mock.patch.object(runner, 'preflight'), \
                mock.patch.object(runner.subprocess, 'Popen', return_value=child) as launch, \
                mock.patch.object(runner, '_signal_child') as signal_child, \
                mock.patch.object(runner, '_wait_group', return_value=True):
            code, output, _ = self.execute(self.plan(['leaf']))
        self.assertNotEqual(code, 0)
        launch.assert_called_once()
        signal_child.assert_called_once_with(child, runner.signal.SIGINT)
        self.assertGreaterEqual(child.wait.call_count, 2)
        self.assertIn('python: inconclusive;', output)
        self.assertIn('node: not_run;', output)

    def test_interruption_escalates_when_descendants_outlive_the_leader(self):
        child = mock.Mock()
        child.wait.side_effect = [KeyboardInterrupt, 0, 0, 0]
        with mock.patch.object(runner, 'preflight'), \
                mock.patch.object(runner.subprocess, 'Popen', return_value=child), \
                mock.patch.object(runner, '_signal_child') as signal_child, \
                mock.patch.object(runner, '_wait_group', side_effect=[False, False, True]) as wait_group:
            code, output, _ = self.execute(self.plan(['leaf']))
        self.assertNotEqual(code, 0)
        self.assertEqual(signal_child.call_args_list, [
            mock.call(child, runner.signal.SIGINT),
            mock.call(child, runner.signal.SIGTERM),
            mock.call(child, runner.signal.SIGKILL),
        ])
        self.assertGreaterEqual(wait_group.call_count, 2)
        self.assertIn('node: not_run;', output)


class PreflightTests(AreaFixture):
    def setUp(self):
        super().setUp()
        self.area('leaf', {'python': ['tests/test_leaf.py'], 'node': ['tests/leaf.test.cjs'],
                           'browser': ['tests/browser/leaf.spec.cjs'],
                           'media': ['tests/integration/test_leaf.py'], 'container': list(CHECKS)})
        self.write('package.json', json.dumps({'devDependencies': {'yaml': '2.9.1', 'web-ext': '10.8.0'}}))

    def test_all_layers_are_preflighted_before_first_test_starts(self):
        plan = self.plan(['leaf'], ['python', 'node'])
        self.save()
        events = []

        def probe(argv, **kwargs):
            events.append(('probe', argv))
            if argv[0] == 'node':
                return subprocess.CompletedProcess(argv, 1)
            return subprocess.CompletedProcess(argv, 0)

        with mock.patch.object(runner.shutil, 'which', side_effect=lambda tool: str(tool)), \
                mock.patch.object(runner.subprocess, 'run', side_effect=probe), \
                mock.patch.object(runner.subprocess, 'Popen') as launch, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = runner.execute_plan(plan, self.root)
        self.assertEqual(code, 1)
        launch.assert_not_called()
        self.assertEqual(len(events), 2)

    def test_missing_native_python_never_uses_container_fallback_or_installs(self):
        plan = self.plan(['leaf'], ['browser'])
        with mock.patch.object(runner.shutil, 'which', return_value=None), \
                mock.patch.object(runner.subprocess, 'run') as probe, \
                mock.patch.object(runner.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(runner.PrerequisiteError, 'VDL_PYTHON|Python'):
                runner.preflight(plan, self.root)
        probe.assert_not_called()
        launch.assert_not_called()

    def test_missing_packages_fail_without_importing_the_application(self):
        plan = self.plan(['leaf'], ['python'])
        with mock.patch.object(runner.shutil, 'which', return_value='/native/python'), \
                mock.patch.object(runner.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)) as probe:
            with self.assertRaisesRegex(runner.PrerequisiteError, 'requirements.txt'):
                runner.preflight(plan, self.root)
        argv = probe.call_args.args[0]
        self.assertEqual(argv[-1], 'import flask, yt_dlp')
        self.assertNotIn('import vdl', ' '.join(argv))
        self.assertNotIn('pip', argv)
        self.assertNotIn('shell', probe.call_args.kwargs)

    def test_missing_node_root_tooling_and_browser_are_actionable(self):
        for layer, failure, expected in [
            ('node', 'tool', 'Node'), ('node', 'probe', 'npm ci'),
            ('browser', 'tool', 'browser'), ('browser', 'probe', 'playwright'),
        ]:
            plan = self.plan(['leaf'], [layer])

            def tool(name):
                if failure == 'tool' and ((layer == 'node' and name == 'node')
                                          or (layer == 'browser' and 'playwright' in str(name))):
                    return None
                return str(name)

            def probe(argv, **kwargs):
                return subprocess.CompletedProcess(argv, 1 if failure == 'probe' and argv[0] == 'node' else 0)

            with self.subTest(layer=layer, failure=failure), \
                    mock.patch.object(runner.shutil, 'which', side_effect=tool), \
                    mock.patch.object(runner.subprocess, 'run', side_effect=probe):
                with self.assertRaisesRegex(runner.PrerequisiteError, expected):
                    runner.preflight(plan, self.root)

    def test_browser_probe_resolves_selected_browser_without_launch_or_install(self):
        with mock.patch.dict(os.environ, {'VDL_TEST_BROWSER': 'firefox', 'PLAYWRIGHT_CLI': '/custom/playwright'}):
            plan = self.plan(['leaf'], ['browser'])
            with mock.patch.object(runner.shutil, 'which', side_effect=lambda name: str(name)), \
                    mock.patch.object(runner.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as probe:
                runner.preflight(plan, self.root)
        argv = probe.call_args.args[0]
        self.assertEqual(argv[-1], 'firefox')
        self.assertIn('executablePath', argv[2])
        self.assertNotIn('launch(', argv[2])
        self.assertNotIn('install', argv)
        self.assertEqual(probe.call_args.kwargs['cwd'], self.root / 'tests/browser')
        self.assertEqual(probe.call_args.kwargs['env']['PLAYWRIGHT_CLI'], '/custom/playwright')

    def test_missing_ffmpeg_and_ffprobe_fail_before_media_execution(self):
        for missing in ('ffmpeg', 'ffprobe'):
            with self.subTest(missing=missing), \
                    mock.patch.object(runner.shutil, 'which', side_effect=lambda name: None if name == missing else str(name)), \
                    mock.patch.object(runner.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
                with self.assertRaisesRegex(runner.PrerequisiteError, missing):
                    runner.preflight(self.plan(['leaf'], ['media']), self.root)

    def test_container_preflight_preserves_engine_image_and_lock_interpreter(self):
        with mock.patch.dict(os.environ, {'CONTAINER_ENGINE': '/tools/podman',
                                         'VDL_IMAGE': 'vdl:review', 'VDL_LOCK_PYTHON': '/lock/python'}):
            plan = self.plan(['leaf'], ['container'])
            with mock.patch.object(runner.shutil, 'which', side_effect=lambda name: str(name)), \
                    mock.patch.object(runner.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as probe:
                runner.preflight(plan, self.root)
        commands = [call.args[0] for call in probe.call_args_list]
        self.assertIn(['/tools/podman', 'info'], commands)
        self.assertIn(['/tools/podman', 'image', 'inspect', 'vdl:review'], commands)
        self.assertIn(['/lock/python', '-m', 'pip', '--version'], commands)
        self.assertFalse(any('build' in command or 'pull' in command for command in commands))

    def test_probe_runtime_error_and_timeout_become_prerequisite_failures(self):
        for error in (FileNotFoundError('missing interpreter'),
                      subprocess.TimeoutExpired(['python'], 30)):
            with self.subTest(error=error), \
                    mock.patch.object(runner.shutil, 'which', return_value='/native/python'), \
                    mock.patch.object(runner.subprocess, 'run', side_effect=error):
                with self.assertRaises(runner.PrerequisiteError):
                    runner.preflight(self.plan(['leaf'], ['python']), self.root)


class IsolatedSelectionTests(unittest.TestCase):
    def test_cli_planning_listing_and_checking_need_only_the_standard_library(self):
        with tempfile.TemporaryDirectory(prefix='vdl isolated caller ') as unrelated_cwd:
            for args in (['--list'], ['--check'], ['rename', '--dry-run', '--json']):
                with self.subTest(args=args):
                    result = subprocess.run(
                        [sys.executable, '-I', '-S', '-B', str(ROOT / 'tests/run-area.py'), *args],
                        cwd=unrelated_cwd, env={'PATH': ''}, capture_output=True, text=True,
                        timeout=20,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue(result.stdout)
                    self.assertEqual(list(Path(unrelated_cwd).iterdir()), [])
                    if '--json' in args:
                        plan = json.loads(result.stdout)
                        self.assertEqual(plan['requested_areas'], ['rename'])
                        self.assertEqual(plan['layers'], ['python', 'node'])


class ChildCleanupTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'posix', 'process groups are a POSIX contract')
    def test_signal_reaches_the_child_process_group(self):
        child = mock.Mock(pid=123456)
        with mock.patch.object(runner.os, 'killpg') as signal_group:
            runner._signal_child(child, runner.signal.SIGINT)
        signal_group.assert_called_once_with(123456, runner.signal.SIGINT)
        child.send_signal.assert_not_called()

    def test_child_that_exits_before_interrupt_is_reaped(self):
        child = mock.Mock()
        with mock.patch.object(runner, '_signal_child', side_effect=ProcessLookupError):
            runner._stop_child(child)
        child.wait.assert_called_once_with()

    @unittest.skipUnless(os.name == 'posix', 'process groups are a POSIX contract')
    def test_group_liveness_does_not_depend_on_leader_exit_status(self):
        child = mock.Mock(pid=123456)
        child.poll.return_value = 0
        with mock.patch.object(runner.os, 'killpg') as probe_group:
            self.assertTrue(runner._group_alive(child))
        probe_group.assert_called_once_with(123456, 0)
        with mock.patch.object(runner.os, 'killpg', side_effect=ProcessLookupError):
            self.assertFalse(runner._group_alive(child))

    def test_group_wait_times_out_when_descendant_survives(self):
        child = mock.Mock()
        with mock.patch.object(runner, '_group_alive', return_value=True), \
                mock.patch.object(runner.time, 'monotonic', side_effect=[0.0, 0.0, 11.0]), \
                mock.patch.object(runner.time, 'sleep'):
            self.assertFalse(runner._wait_group(child, 10))
        with mock.patch.object(runner, '_group_alive', return_value=False):
            self.assertTrue(runner._wait_group(child, 10))


if __name__ == '__main__':
    unittest.main()
