import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import vdl


class VersionLoadingTest(unittest.TestCase):
    def test_valid_prerelease_and_build_version_is_accepted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            version_path = Path(temp_dir, 'VERSION')
            version_path.write_text('2.0.0-rc.1+build.184\n', encoding='utf-8')

            self.assertEqual(
                vdl._load_app_version(version_path),
                '2.0.0-rc.1+build.184',
            )

    def test_missing_empty_and_malformed_versions_fail_clearly(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            version_path = Path(temp_dir, 'VERSION')
            cases = (
                ('missing', None),
                ('empty', ''),
                ('malformed', '1.2'),
                ('leading zero', '01.2.3'),
                ('leading whitespace', ' 1.2.3'),
            )
            for label, contents in cases:
                with self.subTest(label=label):
                    if version_path.exists():
                        version_path.unlink()
                    if contents is not None:
                        version_path.write_text(contents, encoding='utf-8')

                    with self.assertRaisesRegex(RuntimeError, 'VERSION'):
                        vdl._load_app_version(version_path)

    def test_default_path_is_relative_to_module_not_working_directory(self):
        with tempfile.TemporaryDirectory() as module_dir, tempfile.TemporaryDirectory() as cwd:
            fake_module = Path(module_dir, 'vdl.py')
            Path(module_dir, 'VERSION').write_text('3.4.5\n', encoding='utf-8')

            with mock.patch.object(vdl, '__file__', str(fake_module)):
                previous_cwd = os.getcwd()
                try:
                    os.chdir(cwd)
                    self.assertEqual(vdl._load_app_version(), '3.4.5')
                finally:
                    os.chdir(previous_cwd)


class VersionEndpointTest(unittest.TestCase):
    def setUp(self):
        self.client = vdl.app.test_client()

    def test_health_exposes_cached_application_version(self):
        with mock.patch.object(Path, 'read_text', side_effect=AssertionError('unexpected read')):
            response = self.client.get('/api/health')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            'ok': True,
            'version': '0.1.0',
        })
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_page_embeds_ui_version_and_versions_static_assets(self):
        response = self.client.get('/')
        page = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertIn('data-ui-version="0.1.0"', page)
        self.assertIn('UI v0.1.0', page)
        self.assertIn('API checking…', page)
        self.assertIn('/static/styles.css?v=0.1.0', page)
        self.assertIn('/static/app.js?v=0.1.0', page)


if __name__ == '__main__':
    unittest.main()
