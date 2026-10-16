#!/usr/bin/env python3
"""Validate, resolve, and stage VDL's Mozilla-signed extension release."""

import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib import error, parse, request

try:
    from scripts.verify_companion_xpi import (CHECKSUM, EXTENSION_ID, PACKAGE,
                                              ROOT, SOURCE, verify)
except ModuleNotFoundError:
    from verify_companion_xpi import (CHECKSUM, EXTENSION_ID, PACKAGE, ROOT,
                                      SOURCE, verify)


API_ROOT = 'https://addons.mozilla.org/api/v5/'
XPI_NAME = 'vdl-companion-firefox.xpi'
ARTIFACT_FILES = {XPI_NAME, XPI_NAME + '.sha256', 'extension-metadata.json'}
ALLOWED_DOWNLOAD_HOSTS = {'addons.mozilla.org', 'addons.cdn.mozilla.net'}


class ReleaseError(Exception):
    pass


def extension_identity():
    manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8'))
    gecko = manifest.get('browser_specific_settings', {}).get('gecko', {})
    version = manifest.get('version')
    if gecko.get('id') != EXTENSION_ID:
        raise ReleaseError('The extension ID changed from the fixed VDL ID')
    if not isinstance(version, str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,3}', version):
        raise ReleaseError('The extension version is invalid for Firefox')
    backend = (ROOT / 'vdl.py').read_text(encoding='utf-8')
    match = re.search(r"^COMPANION_PACKAGE_VERSION = '([^']+)'$", backend, re.M)
    if not match or match.group(1) != version:
        raise ReleaseError('COMPANION_PACKAGE_VERSION must equal the manifest version')
    return version


def source_digest():
    digest = hashlib.sha256()
    for path in sorted(SOURCE.rglob('*'), key=lambda item: item.relative_to(SOURCE).as_posix().encode()):
        if path.is_symlink():
            raise ReleaseError('Extension source contains a symbolic link')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ReleaseError('Extension source contains a non-regular file')
        name = path.relative_to(SOURCE).as_posix().encode('utf-8')
        body = path.read_bytes()
        digest.update(len(name).to_bytes(4, 'big') + name)
        digest.update(len(body).to_bytes(8, 'big') + body)
    return digest.hexdigest()


def check_source_version_change(base_ref):
    if not base_ref or not re.fullmatch(r'[0-9a-f]{40}', base_ref) or base_ref == '0' * 40:
        return
    changed = subprocess.run(
        ['git', 'diff', '--name-only', base_ref + '...HEAD', '--', 'browser-extension/src'],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout.strip()
    if not changed:
        return
    previous = subprocess.run(
        ['git', 'show', base_ref + ':browser-extension/src/manifest.json'],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    old_version = json.loads(previous)['version']
    current_version = extension_identity()
    version_key = lambda value: tuple(int(part) for part in value.split('.')) + (0,) * (4 - len(value.split('.')))
    if version_key(current_version) <= version_key(old_version):
        raise ReleaseError('Packaged extension source changed without a higher manifest version')


def validate(base_ref=None, built_dir=None):
    extension_identity()
    source_digest()
    verify(SOURCE, PACKAGE, CHECKSUM, require_identity=True)
    if built_dir is not None:
        candidates = list(Path(built_dir).glob('*.zip'))
        if len(candidates) != 1:
            raise ReleaseError('Fresh web-ext build must contain exactly one ZIP')
        candidate = candidates[0]
        with tempfile.TemporaryDirectory() as temp:
            checksum = Path(temp) / 'checksum.sha256'
            checksum.write_text(
                hashlib.sha256(candidate.read_bytes()).hexdigest()
                + f'  {candidate.name}\n', encoding='ascii',
            )
            verify(SOURCE, candidate, checksum, require_identity=True)
    check_source_version_change(base_ref)


def jwt_token(issuer, secret):
    now = int(time.time())
    encode = lambda data: base64.urlsafe_b64encode(
        json.dumps(data, separators=(',', ':')).encode('utf-8')
    ).rstrip(b'=').decode('ascii')
    head = encode({'alg': 'HS256', 'typ': 'JWT'})
    body = encode({'iss': issuer, 'jti': os.urandom(16).hex(),
                   'iat': now, 'exp': now + 240})
    content = f'{head}.{body}'
    signature = base64.urlsafe_b64encode(
        hmac.new(secret.encode('utf-8'), content.encode('ascii'), hashlib.sha256).digest()
    ).rstrip(b'=').decode('ascii')
    return f'{content}.{signature}'


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ReleaseError('AMO API unexpectedly redirected an authenticated request')


def lookup_version(version, issuer, secret):
    path = ('addons/addon/' + parse.quote(EXTENSION_ID, safe='')
            + '/versions/v' + parse.quote(version, safe='') + '/')
    url = API_ROOT + path
    req = request.Request(url, headers={
        'Authorization': 'JWT ' + jwt_token(issuer, secret),
        'Accept': 'application/json',
    })
    try:
        with request.build_opener(NoRedirect()).open(req, timeout=30) as response:
            if response.url != url:
                raise ReleaseError('AMO API changed the exact-version lookup URL')
            value = json.load(response)
    except error.HTTPError as exc:
        if exc.code == 404:
            return None
        if exc.code in (401, 403):
            raise ReleaseError('AMO credentials are invalid or do not own the add-on') from exc
        if exc.code == 429 or exc.code >= 500:
            raise ReleaseError(f'AMO is temporarily unavailable (HTTP {exc.code})') from exc
        raise ReleaseError(f'AMO lookup failed (HTTP {exc.code})') from exc
    except (error.URLError, TimeoutError) as exc:
        raise ReleaseError('AMO lookup could not complete') from exc
    if not isinstance(value, dict) or value.get('version') != version:
        raise ReleaseError('AMO returned malformed or mismatched version metadata')
    return value


def approved_file(value):
    if value.get('channel') != 'unlisted':
        raise ReleaseError('The existing AMO version is not unlisted')
    file = value.get('file')
    if not isinstance(file, dict):
        raise ReleaseError('AMO version has no file metadata')
    if value.get('is_disabled') or file.get('status') == 'disabled':
        raise ReleaseError('The AMO version was rejected or disabled')
    if file.get('status') == 'unreviewed':
        raise ReleaseError('AMO review is pending; rerun the failed workflow after approval')
    if file.get('status') != 'public' or file.get('is_mozilla_signed_extension') is not True:
        raise ReleaseError('AMO has not approved and Mozilla-signed this version')
    expected = file.get('hash')
    if not isinstance(expected, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', expected):
        raise ReleaseError('AMO did not provide a SHA-256 signed-file hash')
    url = file.get('url')
    if not isinstance(url, str) or not allowed_download_url(url):
        raise ReleaseError('AMO returned an unapproved signed-file URL')
    if not isinstance(file.get('id'), int) or file['id'] < 1:
        raise ReleaseError('AMO returned an invalid file ID')
    return file


def allowed_download_url(url):
    parsed = parse.urlsplit(url)
    return (parsed.scheme == 'https' and parsed.hostname in ALLOWED_DOWNLOAD_HOSTS
            and parsed.port in (None, 443) and not parsed.username and not parsed.password)


class MozillaRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_download_url(newurl):
            raise ReleaseError('Signed-file download redirected outside Mozilla')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_signed_file(file):
    opener = request.build_opener(MozillaRedirect())
    try:
        with opener.open(file['url'], timeout=60) as response:
            if not allowed_download_url(response.url):
                raise ReleaseError('Signed-file download left Mozilla')
            data = response.read(30 * 1024 * 1024 + 1)
    except (error.HTTPError, error.URLError, TimeoutError) as exc:
        raise ReleaseError('Signed-file download failed') from exc
    if len(data) > 30 * 1024 * 1024:
        raise ReleaseError('Signed XPI exceeds the release size limit')
    if hashlib.sha256(data).hexdigest() != file['hash'][7:]:
        raise ReleaseError('Downloaded XPI does not match AMO SHA-256')
    return data


def artifact_name(commit, version):
    return f'companion-{commit}-{version}'


def sign(output, repository, commit, issuer, secret):
    if not issuer or not secret:
        raise ReleaseError('AMO environment credentials are missing')
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(r'[^/]+/[^/]+', repository):
        raise ReleaseError('Trusted repository or commit context is invalid')
    version = extension_identity()
    value = lookup_version(version, issuer, secret)
    if value is None:
        signing_dir = output.parent / 'web-ext-signed'
        signing_dir.mkdir(parents=True, exist_ok=True)
        command = [str(ROOT / 'node_modules/.bin/web-ext'), 'sign',
                   '--channel=unlisted', '--source-dir=' + str(SOURCE),
                   '--artifacts-dir=' + str(signing_dir),
                   '--approval-timeout=1800000', '--no-input']
        # web-ext reads the same step-scoped environment credentials. Its
        # result is only a hint; AMO metadata and a fresh download are final.
        # AMO error bodies can echo submitted data. Keep web-ext output out of
        # logs and report only the independently queried review state.
        result = subprocess.run(command, cwd=ROOT, check=False,
                                capture_output=True, text=True)
        candidates = list(signing_dir.glob('*.xpi'))
        if len(candidates) > 1:
            raise ReleaseError('web-ext produced multiple signed XPI candidates')
        value = lookup_version(version, issuer, secret)
        if value is None:
            raise ReleaseError('AMO has no version after submission; inspect validation')
        if result.returncode != 0 and value.get('file', {}).get('status') != 'public':
            approved_file(value)
            raise ReleaseError('web-ext signing failed; inspect AMO validation')
    file = approved_file(value)
    data = download_signed_file(file)
    output.mkdir(parents=True, exist_ok=False)
    package = output / XPI_NAME
    checksum = output / (XPI_NAME + '.sha256')
    package.write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    checksum.write_text(f'{digest}  {XPI_NAME}\n', encoding='ascii')
    verify(SOURCE, package, checksum, require_signed=True, require_identity=True)
    metadata = {
        'schema': 1, 'repository': repository, 'source_commit': commit,
        'extension_id': EXTENSION_ID, 'extension_version': version,
        'channel': 'unlisted', 'source_sha256': source_digest(),
        'xpi_sha256': digest, 'amo_file_id': file['id'],
        'amo_file_url': file['url'],
    }
    (output / 'extension-metadata.json').write_text(
        json.dumps(metadata, sort_keys=True, indent=2) + '\n', encoding='utf-8')
    return artifact_name(commit, version)


def stage(artifact, repository, commit):
    if {path.name for path in artifact.iterdir()} != ARTIFACT_FILES:
        raise ReleaseError('Signing artifact has missing or unexpected files')
    if any(path.is_symlink() or not path.is_file() for path in artifact.iterdir()):
        raise ReleaseError('Signing artifact contains a non-regular file')
    version = extension_identity()
    metadata = json.loads((artifact / 'extension-metadata.json').read_text(encoding='utf-8'))
    expected = {'schema': 1, 'repository': repository, 'source_commit': commit,
                'extension_id': EXTENSION_ID, 'extension_version': version,
                'channel': 'unlisted', 'source_sha256': source_digest()}
    if not isinstance(metadata, dict) or any(metadata.get(k) != v for k, v in expected.items()):
        raise ReleaseError('Signing artifact does not match the checked-out source and commit')
    package = artifact / XPI_NAME
    checksum = artifact / (XPI_NAME + '.sha256')
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    if metadata.get('xpi_sha256') != digest:
        raise ReleaseError('Signing artifact hash differs from its metadata')
    if not isinstance(metadata.get('amo_file_id'), int) or not allowed_download_url(
            str(metadata.get('amo_file_url'))):
        raise ReleaseError('Signing artifact has invalid AMO provenance')
    verify(SOURCE, package, checksum, require_signed=True, require_identity=True)
    shutil.copyfile(package, PACKAGE)
    shutil.copyfile(checksum, CHECKSUM)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    validation = commands.add_parser('validate')
    validation.add_argument('--base-ref')
    validation.add_argument('--built-dir', type=Path)
    signing = commands.add_parser('sign')
    signing.add_argument('--output', type=Path, required=True)
    staging = commands.add_parser('stage')
    staging.add_argument('--artifact', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'validate':
            validate(args.base_ref, args.built_dir)
        elif args.command == 'sign':
            name = sign(args.output, os.environ['GITHUB_REPOSITORY'],
                        os.environ['GITHUB_SHA'], os.environ.get('WEB_EXT_API_KEY'),
                        os.environ.get('WEB_EXT_API_SECRET'))
            print(f'Verified signing artifact: {name}')
        else:
            stage(args.artifact, os.environ['GITHUB_REPOSITORY'],
                  os.environ['GITHUB_SHA'])
    except (ReleaseError, OSError, ValueError, KeyError) as exc:
        print(f'Extension release failed: {exc}', file=sys.stderr)
        if args.command == 'sign' and os.environ.get('GITHUB_STEP_SUMMARY'):
            try:
                version = json.loads((SOURCE / 'manifest.json').read_text())['version']
                with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a', encoding='utf-8') as summary:
                    summary.write(
                        f'### Firefox companion signing blocked\n\n'
                        f'Add-on `{EXTENSION_ID}`, version `{version}`. {exc} '
                        'After Mozilla approves a pending version, rerun the failed workflow.\n'
                    )
            except (OSError, ValueError, KeyError):
                pass
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
