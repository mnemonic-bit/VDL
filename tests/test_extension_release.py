import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile
from urllib import error

from scripts import extension_release as release


class ExtensionReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'browser-extension' / 'src'
        self.source.mkdir(parents=True)
        self.dist = self.root / 'browser-extension' / 'dist'
        self.dist.mkdir()
        self.package = self.dist / release.XPI_NAME
        self.checksum = self.dist / (release.XPI_NAME + '.sha256')
        self.manifest = {
            'version': '1.2.3',
            'browser_specific_settings': {
                'gecko': {'id': release.EXTENSION_ID},
            },
        }
        (self.source / 'manifest.json').write_text(json.dumps(self.manifest))
        (self.source / 'background.js').write_text('console.log("fixture");\n')
        (self.root / 'vdl.py').write_text("COMPANION_PACKAGE_VERSION = '1.2.3'\n")
        self.patches = [
            mock.patch.object(release, 'ROOT', self.root),
            mock.patch.object(release, 'SOURCE', self.source),
            mock.patch.object(release, 'PACKAGE', self.package),
            mock.patch.object(release, 'CHECKSUM', self.checksum),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def signed_bytes(self):
        path = self.root / 'fixture.xpi'
        with zipfile.ZipFile(path, 'w') as archive:
            for source_file in self.source.rglob('*'):
                if source_file.is_file():
                    archive.write(source_file, source_file.relative_to(self.source))
            for name in ('META-INF/manifest.mf', 'META-INF/mozilla.sf',
                         'META-INF/mozilla.rsa'):
                archive.writestr(name, 'signature')
        return path.read_bytes()

    def amo_version(self, data, *, status='public', channel='unlisted'):
        return {
            'version': '1.2.3', 'channel': channel,
            'file': {
                'id': 17, 'status': status,
                'is_mozilla_signed_extension': True,
                'hash': 'sha256:' + hashlib.sha256(data).hexdigest(),
                'url': 'https://addons.mozilla.org/firefox/downloads/file/17/xpi',
            },
        }

    def test_identity_and_source_change_require_version_bump(self):
        self.assertEqual(release.extension_identity(), '1.2.3')
        (self.root / 'vdl.py').write_text("COMPANION_PACKAGE_VERSION = '1.2.2'\n")
        with self.assertRaisesRegex(release.ReleaseError, 'must equal'):
            release.extension_identity()
        (self.root / 'vdl.py').write_text("COMPANION_PACKAGE_VERSION = '1.2.3'\n")
        with mock.patch.object(release.subprocess, 'run', side_effect=[
            mock.Mock(stdout='browser-extension/src/background.js\n'),
            mock.Mock(stdout=json.dumps(self.manifest)),
        ]):
            with self.assertRaisesRegex(release.ReleaseError, 'higher manifest version'):
                release.check_source_version_change('a' * 40)

    def test_approved_existing_version_is_verified_and_staged(self):
        data = self.signed_bytes()
        amo = self.amo_version(data)
        output = self.root / 'artifact'
        with mock.patch.object(release, 'lookup_version', return_value=amo), \
                mock.patch.object(release, 'download_signed_file', return_value=data), \
                mock.patch.object(release.subprocess, 'run') as subprocess_run:
            name = release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
        self.assertEqual(name, 'companion-' + 'a' * 40 + '-1.2.3')
        subprocess_run.assert_not_called()
        metadata = json.loads((output / 'extension-metadata.json').read_text())
        self.assertEqual(metadata['source_sha256'], release.source_digest())
        self.assertNotIn('secret', json.dumps(metadata))
        release.stage(output, 'owner/repo', 'a' * 40)
        self.assertEqual(self.package.read_bytes(), data)

    def test_absent_version_submits_once_then_uses_amo_file(self):
        data = self.signed_bytes()
        output = self.root / 'artifact'
        with mock.patch.object(release, 'lookup_version', side_effect=[
                None, self.amo_version(data)]) as lookup, \
                mock.patch.object(release, 'download_signed_file', return_value=data), \
                mock.patch.object(release.subprocess, 'run',
                                  return_value=mock.Mock(returncode=0)) as submit:
            release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
        self.assertEqual(lookup.call_count, 2)
        submit.assert_called_once()

    def test_pending_or_wrong_channel_never_publishes(self):
        data = self.signed_bytes()
        with mock.patch.object(release, 'lookup_version',
                               return_value=self.amo_version(data, status='unreviewed')):
            with self.assertRaisesRegex(release.ReleaseError, 'pending'):
                release.sign(self.root / 'pending', 'owner/repo', 'a' * 40,
                             'issuer', 'secret')
        with mock.patch.object(release, 'lookup_version',
                               return_value=self.amo_version(data, channel='listed')):
            with self.assertRaisesRegex(release.ReleaseError, 'not unlisted'):
                release.sign(self.root / 'listed', 'owner/repo', 'a' * 40,
                             'issuer', 'secret')

    def test_stage_rejects_tampered_artifact(self):
        data = self.signed_bytes()
        output = self.root / 'artifact'
        with mock.patch.object(release, 'lookup_version', return_value=self.amo_version(data)), \
                mock.patch.object(release, 'download_signed_file', return_value=data):
            release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
        metadata_path = output / 'extension-metadata.json'
        metadata = json.loads(metadata_path.read_text())
        metadata['source_commit'] = 'b' * 40
        metadata_path.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(release.ReleaseError, 'checked-out'):
            release.stage(output, 'owner/repo', 'a' * 40)
        metadata['source_commit'] = 'a' * 40
        metadata_path.write_text(json.dumps(metadata))
        (output / release.XPI_NAME).write_bytes(b'tampered')
        with self.assertRaisesRegex(release.ReleaseError, 'hash differs'):
            release.stage(output, 'owner/repo', 'a' * 40)

    def test_download_url_rejects_non_mozilla_origins(self):
        self.assertTrue(release.allowed_download_url(
            'https://addons.mozilla.org/firefox/downloads/file/17/xpi'))
        for url in ('http://addons.mozilla.org/file',
                    'https://addons.mozilla.org.evil.example/file',
                    'https://addons.mozilla.org:444/file'):
            self.assertFalse(release.allowed_download_url(url))

    def test_exact_lookup_only_treats_404_as_absent(self):
        for status in (404, 401, 429):
            with self.subTest(status=status):
                response_error = error.HTTPError(
                    'https://addons.mozilla.org/api/v5/', status, 'fixture',
                    {}, io.BytesIO(b'private details'),
                )
                opener = mock.Mock()
                opener.open.side_effect = response_error
                with mock.patch.object(release.request, 'build_opener',
                                       return_value=opener):
                    if status == 404:
                        self.assertIsNone(release.lookup_version(
                            '1.2.3', 'issuer', 'secret'))
                    else:
                        with self.assertRaises(release.ReleaseError):
                            release.lookup_version('1.2.3', 'issuer', 'secret')

    def test_authenticated_lookup_rejects_redirects(self):
        with self.assertRaisesRegex(release.ReleaseError, 'redirected'):
            release.NoRedirect().redirect_request(
                None, None, 302, 'Found', {}, 'https://example.invalid/')
        with self.assertRaisesRegex(release.ReleaseError, 'outside Mozilla'):
            release.MozillaRedirect().redirect_request(
                None, None, 302, 'Found', {}, 'https://example.invalid/xpi')

    def test_download_rejects_amo_hash_mismatch(self):
        file = self.amo_version(b'expected')['file']
        response = mock.Mock()
        response.url = file['url']
        response.read.return_value = b'different bytes'
        opener = mock.Mock()
        opener.open.return_value.__enter__ = mock.Mock(return_value=response)
        opener.open.return_value.__exit__ = mock.Mock(return_value=False)
        with mock.patch.object(release.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(release.ReleaseError, 'SHA-256'):
                release.download_signed_file(file)
        self.assertEqual(opener.open.call_args.args[0], file['url'])


if __name__ == '__main__':
    unittest.main()
