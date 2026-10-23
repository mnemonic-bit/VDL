import hashlib
import io
import json
import errno
import socket
import ssl
import subprocess
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
        self.unsigned_bytes = self.make_unsigned()

    def make_unsigned(self):
        with zipfile.ZipFile(self.package, 'w') as archive:
            for source_file in self.source.rglob('*'):
                if source_file.is_file():
                    archive.write(source_file, source_file.relative_to(self.source))
        data = self.package.read_bytes()
        self.checksum.write_text(hashlib.sha256(data).hexdigest()
                                 + f'  {release.XPI_NAME}\n')
        return data

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

    def test_pending_falls_back_without_submission_but_wrong_channel_blocks(self):
        data = self.signed_bytes()
        with mock.patch.object(release, 'lookup_version',
                               return_value=self.amo_version(data, status='unreviewed')), \
                mock.patch.object(release.subprocess, 'run') as submit:
            output = self.root / 'pending'
            release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
            self.assertEqual((output / release.XPI_NAME).read_bytes(), self.unsigned_bytes)
            self.assertEqual(release.stage(output, 'owner/repo', 'a' * 40)['resolution_reason'],
                             'pending_review')
            submit.assert_not_called()
        with mock.patch.object(release, 'lookup_version',
                               return_value=self.amo_version(data, channel='listed')):
            with self.assertRaisesRegex(release.ReleaseError, 'not unlisted'):
                release.sign(self.root / 'listed', 'owner/repo', 'a' * 40,
                             'issuer', 'secret')

    def test_pending_version_without_a_signed_download_still_resolves_unsigned(self):
        value = self.amo_version(b'', status='unreviewed')
        value['file'].update(url=None, hash=None, is_mozilla_signed_extension=False)
        with mock.patch.object(release, 'lookup_version', return_value=value), \
                mock.patch.object(release.subprocess, 'run') as submit:
            output = self.root / 'pending'
            release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
            self.assertEqual(release.stage(output, 'owner/repo', 'a' * 40)['resolution_reason'],
                             'pending_review')
            submit.assert_not_called()

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

    def metadata(self, output):
        return json.loads((output / 'extension-metadata.json').read_text())

    def test_missing_and_partial_credentials_never_contact_amo(self):
        for index, credentials in enumerate(((None, None), ('', ''), ('issuer', ''), ('', 'secret'))):
            with self.subTest(credentials=index), \
                    mock.patch.object(release, 'lookup_version') as lookup, \
                    mock.patch.object(release.subprocess, 'run') as submit:
                output = self.root / str(index)
                release.sign(output, 'owner/repo', 'a' * 40, *credentials)
                metadata = release.stage(output, 'owner/repo', 'a' * 40)
                self.assertIs(metadata['signed'], False)
                self.assertNotIn('amo_file_id', metadata)
                self.assertEqual(metadata['resolution_reason'],
                                 'missing_credentials' if index < 2 else 'incomplete_credentials')
                self.assertEqual(self.package.read_bytes(), self.unsigned_bytes)
                lookup.assert_not_called()
                submit.assert_not_called()

    def test_lookup_classifies_availability_without_using_error_text(self):
        cases = [
            (error.HTTPError('https://amo', status, 'secret', {}, None),
             'amo_authentication' if status in (401, 403) else 'amo_unavailable')
            for status in (401, 403, 408, 429, 500, 503)
        ] + [(error.URLError(cause), 'amo_unavailable') for cause in (
            TimeoutError('secret'), ConnectionRefusedError('secret'),
            socket.gaierror(-2, 'secret'), OSError(errno.ENETUNREACH, 'secret'),
        )]
        for exc, reason in cases:
            with self.subTest(exc=type(exc), reason=reason):
                opener = mock.Mock()
                opener.open.side_effect = exc
                with mock.patch.object(release.request, 'build_opener', return_value=opener):
                    output = self.root / 'available-artifact'
                    release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
                    self.assertEqual(self.metadata(output)['resolution_reason'], reason)
                    release.stage(output, 'owner/repo', 'a' * 40)
                    for path in output.iterdir():
                        path.unlink()
                    output.rmdir()

    def test_tls_redirect_unknown_transport_and_malformed_response_block(self):
        for exc in (error.URLError(ssl.SSLCertVerificationError('certificate')),
                    ssl.SSLError('TLS'), error.URLError('unclassified'),
                    error.HTTPError('https://amo', 302, 'redirect', {}, None),
                    error.HTTPError('https://amo', 400, 'invalid', {}, None)):
            with self.subTest(exc=type(exc)):
                opener = mock.Mock()
                opener.open.side_effect = exc
                with mock.patch.object(release.request, 'build_opener', return_value=opener):
                    with self.assertRaises(release.ReleaseError) as result:
                        release.sign(self.root / 'blocked', 'owner/repo', 'a' * 40, 'issuer', 'secret')
                    self.assertNotIsInstance(result.exception, release.SigningUnavailable)
                    self.assertFalse((self.root / 'blocked').exists())
        for body in (b'not json', b'[]', b'{"version":"0.0"}'):
            response = mock.Mock(url=release.API_ROOT + 'addons/addon/'
                                 + release.parse.quote(release.EXTENSION_ID, safe='')
                                 + '/versions/v1.2.3/')
            response.read.return_value = body
            opener = mock.Mock()
            opener.open.return_value = mock.MagicMock()
            opener.open.return_value.__enter__.return_value = response
            with mock.patch.object(release.request, 'build_opener', return_value=opener):
                with self.assertRaises((release.ReleaseError, ValueError)):
                    release.sign(self.root / 'blocked', 'owner/repo', 'a' * 40, 'issuer', 'secret')

    def test_download_availability_falls_back_but_tls_and_hash_failures_block(self):
        data = self.signed_bytes()
        for index, exc in enumerate((error.HTTPError('https://amo', 503, 'secret', {}, None),
                                     error.URLError(TimeoutError('secret')),
                                     error.URLError(ssl.SSLCertVerificationError('secret')),
                                     error.HTTPError('https://amo', 404, 'secret', {}, None))):
            opener = mock.Mock()
            opener.open.side_effect = exc
            output = self.root / str(index)
            with mock.patch.object(release, 'lookup_version', return_value=self.amo_version(data)), \
                    mock.patch.object(release.request, 'build_opener', return_value=opener):
                if index < 2:
                    release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
                    self.assertEqual(release.stage(output, 'owner/repo', 'a' * 40)['resolution_reason'],
                                     'signed_download_unavailable')
                else:
                    with self.assertRaises(release.ReleaseError):
                        release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
                    self.assertFalse(output.exists())

    def test_submission_requires_authoritative_result_and_is_bounded(self):
        data = self.signed_bytes()
        pending = self.amo_version(data, status='unreviewed')
        for index, after in enumerate((pending, None, self.amo_version(data, status='disabled'))):
            output = self.root / str(index) / 'artifact'
            output.parent.mkdir()
            with mock.patch.object(release, 'lookup_version', side_effect=[None, after]), \
                    mock.patch.object(release.subprocess, 'run', return_value=mock.Mock(returncode=1)) as submit:
                if index == 0:
                    release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
                    self.assertEqual(self.metadata(output)['resolution_reason'], 'pending_review')
                else:
                    with self.assertRaises(release.ReleaseError):
                        release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
                    self.assertFalse(output.exists())
                self.assertLess(submit.call_args.kwargs['timeout'], 45 * 60)
                submit.assert_called_once()
        with mock.patch.object(release, 'lookup_version', return_value=None), \
                mock.patch.object(release.subprocess, 'run', side_effect=subprocess.TimeoutExpired('web-ext', 1920)):
            with self.assertRaises(subprocess.TimeoutExpired):
                release.sign(self.root / 'timeout', 'owner/repo', 'a' * 40, 'issuer', 'secret')

    def test_metadata_cannot_change_package_state_or_provenance(self):
        output = self.root / 'artifact'
        release.sign(output, 'owner/repo', 'a' * 40, None, None)
        original = self.metadata(output)
        path = output / 'extension-metadata.json'
        changes = [dict(schema=1), dict(signed=0), dict(signed=True),
                   dict(resolution_reason='approved'), dict(amo_file_id=17),
                   dict(extra='field'), dict(extension_version='9.0'),
                   dict(source_sha256='0' * 64), dict(repository='other/repo')]
        for change in changes:
            with self.subTest(change=change):
                path.write_text(json.dumps(original | change))
                with self.assertRaises(release.ReleaseError):
                    release.stage(output, 'owner/repo', 'a' * 40)
        for key in original:
            path.write_text(json.dumps({k: v for k, v in original.items() if k != key}))
            with self.assertRaises(release.ReleaseError):
                release.stage(output, 'owner/repo', 'a' * 40)
        path.write_text(json.dumps(original))
        # Valid signed contents and checksum still cannot masquerade as unsigned.
        data = self.signed_bytes()
        (output / release.XPI_NAME).write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        (output / (release.XPI_NAME + '.sha256')).write_text(f'{digest}  {release.XPI_NAME}\n')
        original['xpi_sha256'] = digest
        path.write_text(json.dumps(original))
        with self.assertRaisesRegex(ValueError, 'signature state'):
            release.stage(output, 'owner/repo', 'a' * 40)

    def test_invalid_unsigned_source_package_blocks_even_with_approved_amo_version(self):
        for index, data in enumerate((b'corrupt', self.signed_bytes())):
            self.package.write_bytes(data)
            self.checksum.write_text(hashlib.sha256(data).hexdigest() + f'  {release.XPI_NAME}\n')
            with mock.patch.object(release, 'lookup_version') as lookup:
                with self.assertRaises((ValueError, zipfile.BadZipFile)):
                    release.sign(self.root / str(index), 'owner/repo', 'a' * 40, 'issuer', 'secret')
                lookup.assert_not_called()

    def test_rejected_invalid_or_malformed_metadata_never_falls_back(self):
        data = self.signed_bytes()
        cases = [
            {'version': '9.0'}, {'channel': 'enterprise'}, {'guid': 'other'},
            {'is_disabled': True}, {'is_disabled': 0}, {'valid': 'false'}, {'valid': False}, {'validation': {'errors': 1}},
            {'file': None}, {'file': {'status': 'disabled'}},
            {'file': {'status': 'rejected'}}, {'file': {'status': 'invalid'}},
            {'file': {'is_mozilla_signed_extension': False}},
            {'file': {'url': 'https://example.invalid/xpi'}},
            {'file': {'url': 'https://addons.mozilla.org:invalid/xpi'}},
            {'file': {'hash': 'sha1:invalid'}}, {'file': {'id': True}},
            {'file': {'status': 'unreviewed', 'url': 'http://addons.mozilla.org/xpi'}},
        ]
        for index, change in enumerate(cases):
            value = self.amo_version(data)
            if isinstance(change.get('file'), dict):
                value['file'].update(change['file'])
            else:
                value.update(change)
            with self.subTest(change=change), \
                    mock.patch.object(release, 'lookup_version', return_value=value), \
                    mock.patch.object(release, 'download_signed_file') as download:
                with self.assertRaises(release.ReleaseError) as result:
                    release.sign(self.root / str(index), 'owner/repo', 'a' * 40, 'issuer', 'secret')
                self.assertNotIsInstance(result.exception, release.SigningUnavailable)
                download.assert_not_called()
                self.assertFalse((self.root / str(index)).exists())

    def test_approved_downloads_must_keep_source_archive_and_signature_integrity(self):
        for index, mode in enumerate(('unsigned', 'modified', 'unsafe', 'corrupt')):
            self.make_unsigned()
            candidate = self.root / 'bad.xpi'
            if mode == 'corrupt':
                candidate.write_bytes(b'broken zip')
            else:
                with zipfile.ZipFile(candidate, 'w') as archive:
                    for path in self.source.rglob('*'):
                        if path.is_file():
                            archive.writestr(path.relative_to(self.source).as_posix(),
                                             b'altered' if mode == 'modified' else path.read_bytes())
                    if mode != 'unsigned':
                        for name in ('manifest.mf', 'mozilla.sf', 'mozilla.rsa'):
                            archive.writestr('META-INF/' + name, 'fixture')
                    if mode == 'unsafe':
                        archive.writestr('../escape', 'fixture')
            data = candidate.read_bytes()
            output = self.root / str(index)
            with self.subTest(mode=mode), \
                    mock.patch.object(release, 'lookup_version', return_value=self.amo_version(data)), \
                    mock.patch.object(release, 'download_signed_file', return_value=data):
                with self.assertRaises((ValueError, zipfile.BadZipFile)):
                    release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
                self.assertFalse((output / 'extension-metadata.json').exists())

    def test_missing_artifact_and_signed_provenance_mismatch_block_staging(self):
        with self.assertRaises(OSError):
            release.stage(self.root / 'absent', 'owner/repo', 'a' * 40)
        data = self.signed_bytes()
        output = self.root / 'artifact'
        with mock.patch.object(release, 'lookup_version', return_value=self.amo_version(data)), \
                mock.patch.object(release, 'download_signed_file', return_value=data):
            release.sign(output, 'owner/repo', 'a' * 40, 'issuer', 'secret')
        original = self.metadata(output)
        path = output / 'extension-metadata.json'
        for change in ({'amo_sha256': '0' * 64}, {'amo_file_id': False},
                       {'amo_file_url': 'http://addons.mozilla.org/xpi'},
                       {'resolution_reason': 'pending_review'}, {'channel': 'listed'},
                       {'signed': False}):
            path.write_text(json.dumps(original | change))
            with self.assertRaises(release.ReleaseError):
                release.stage(output, 'owner/repo', 'a' * 40)

    def test_unknown_and_tooling_errors_produce_no_resolution_artifact_or_secret_log(self):
        for index, exc in enumerate((RuntimeError('credential-bearing secret'),
                                     OSError('credential-bearing secret'),
                                     subprocess.TimeoutExpired('credential-bearing secret', 1))):
            output = self.root / str(index)
            with mock.patch.object(release.sys, 'argv', ['extension_release.py', 'sign', '--output', str(output)]), \
                    mock.patch.dict(release.os.environ, {'GITHUB_REPOSITORY': 'owner/repo',
                                                       'GITHUB_SHA': 'a' * 40,
                                                       'WEB_EXT_API_KEY': 'issuer',
                                                       'WEB_EXT_API_SECRET': 'secret'}), \
                    mock.patch.object(release, 'resolve_signed', side_effect=exc), \
                    mock.patch.object(release.sys, 'stderr', new_callable=io.StringIO) as stderr:
                self.assertEqual(release.main(), 1)
                self.assertNotIn('credential-bearing', stderr.getvalue())
                self.assertFalse(output.exists())

    def test_summary_is_sanitized_and_actionable(self):
        summary = self.root / 'summary.md'
        with mock.patch.dict(release.os.environ, {'GITHUB_STEP_SUMMARY': str(summary)}), \
                mock.patch.object(release, 'lookup_version', side_effect=release.SigningUnavailable('amo_authentication')):
            release.sign(self.root / 'auth', 'owner/repo', 'a' * 40, 'private issuer', 'private secret')
            release.sign(self.root / 'missing', 'owner/repo', 'a' * 40, None, None)
        text = summary.read_text()
        for expected in ('unsigned', '1.2.3', 'a' * 40, 'ownership', 'AMO_JWT_ISSUER',
                         'AMO_JWT_SECRET', 'amo-signing', 'REPOSITORY_SETTINGS.md', 'later application release'):
            self.assertIn(expected, text)
        self.assertNotIn('private secret', text)
        self.assertNotIn('private issuer', text)


if __name__ == '__main__':
    unittest.main()
