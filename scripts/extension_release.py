#!/usr/bin/env python3
"""Validate, resolve, and stage VDL's signed or unsigned extension release."""

import argparse
import base64
import errno
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
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


FALLBACK_REASONS = {
    'missing_credentials': 'AMO credentials are not configured.',
    'incomplete_credentials': 'AMO credential configuration is incomplete.',
    'amo_authentication': 'Check AMO credential validity and add-on ownership.',
    'amo_unavailable': 'AMO is temporarily unavailable.',
    'pending_review': 'The exact extension version is awaiting Mozilla review.',
    'signed_download_unavailable': 'The approved signed download is temporarily unavailable.',
}


class SigningUnavailable(ReleaseError):
    """Only these classified availability states permit unsigned publication."""

    def __init__(self, reason):
        if reason not in FALLBACK_REASONS:
            raise ReleaseError('Unknown signing resolution reason')
        self.reason = reason
        super().__init__(FALLBACK_REASONS[reason])


def transport_failure(exc, *, downloading=False):
    reason = exc.reason if isinstance(exc, error.URLError) else exc
    # urllib wraps certificate failures and ordinary connection failures alike.
    # Only known availability errors may cross the unsigned fallback boundary.
    if isinstance(reason, ssl.SSLError):
        raise ReleaseError('AMO TLS validation failed') from exc
    if isinstance(reason, (TimeoutError, ConnectionError, socket.gaierror)) or (
            isinstance(reason, OSError) and reason.errno in {
                errno.ECONNREFUSED, errno.ECONNRESET, errno.ECONNABORTED,
                errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ETIMEDOUT,
            }):
        raise SigningUnavailable(
            'signed_download_unavailable' if downloading else 'amo_unavailable') from exc
    raise ReleaseError('Unclassified AMO transport failure') from exc


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
    verify(SOURCE, PACKAGE, CHECKSUM, require_identity=True, expected_signed=False)
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
            verify(SOURCE, candidate, checksum, require_identity=True, expected_signed=False)
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
            raise SigningUnavailable('amo_authentication') from exc
        if exc.code in (408, 429) or 500 <= exc.code <= 599:
            raise SigningUnavailable('amo_unavailable') from exc
        raise ReleaseError(f'AMO lookup failed (HTTP {exc.code})') from exc
    except (error.URLError, OSError) as exc:
        transport_failure(exc)
    if not isinstance(value, dict) or value.get('version') != version:
        raise ReleaseError('AMO returned malformed or mismatched version metadata')
    return value


def approved_file(value):
    if not isinstance(value, dict) or value.get('version') != extension_identity():
        raise ReleaseError('AMO returned mismatched version metadata')
    if value.get('channel') != 'unlisted':
        raise ReleaseError('The existing AMO version is not unlisted')
    file = value.get('file')
    if not isinstance(file, dict):
        raise ReleaseError('AMO version has no file metadata')
    for metadata, keys in ((value, ('is_disabled', 'valid')),
                           (file, ('valid', 'is_mozilla_signed_extension'))):
        if any(key in metadata and type(metadata[key]) is not bool for key in keys):
            raise ReleaseError('AMO returned malformed status metadata')
    if value.get('is_disabled') or file.get('status') in ('disabled', 'rejected'):
        raise ReleaseError('The AMO version was rejected or disabled')
    if value.get('valid') is False or file.get('valid') is False:
        raise ReleaseError('AMO reports failed extension validation')
    for metadata in (value, file):
        validation = metadata.get('validation')
        if validation is not None and (not isinstance(validation, dict)
                                       or validation.get('errors', 0) != 0):
            raise ReleaseError('AMO reports invalid extension validation metadata')
    if 'guid' in value and value['guid'] != EXTENSION_ID:
        raise ReleaseError('AMO returned a mismatched add-on ID')
    pending = file.get('status') == 'unreviewed'
    expected = file.get('hash')
    if (expected is not None or not pending) and (
            not isinstance(expected, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', expected)):
        raise ReleaseError('AMO did not provide a SHA-256 signed-file hash')
    url = file.get('url')
    if (url is not None or not pending) and (
            not isinstance(url, str) or not allowed_download_url(url)):
        raise ReleaseError('AMO returned an unapproved signed-file URL')
    if type(file.get('id')) is not int or file['id'] < 1:
        raise ReleaseError('AMO returned an invalid file ID')
    # Review can precede creation of a downloadable signed file. Validate any
    # provided provenance, but do not require signed-only fields until approval.
    if pending:
        raise SigningUnavailable('pending_review')
    if file.get('status') != 'public' or file.get('is_mozilla_signed_extension') is not True:
        raise ReleaseError('AMO has not approved and Mozilla-signed this version')
    return file


def allowed_download_url(url):
    try:
        parsed = parse.urlsplit(url)
        return (parsed.scheme == 'https' and parsed.hostname in ALLOWED_DOWNLOAD_HOSTS
                and parsed.port in (None, 443) and not parsed.username and not parsed.password
                and not parsed.fragment and not any(ord(c) <= 32 or ord(c) == 127 for c in url)
                and '\\' not in url)
    except ValueError:
        return False


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
    except error.HTTPError as exc:
        if exc.code in (408, 429) or 500 <= exc.code <= 599:
            raise SigningUnavailable('signed_download_unavailable') from exc
        raise ReleaseError('Signed-file download returned an unexpected HTTP status') from exc
    except (error.URLError, OSError) as exc:
        transport_failure(exc, downloading=True)
    if len(data) > 30 * 1024 * 1024:
        raise ReleaseError('Signed XPI exceeds the release size limit')
    if hashlib.sha256(data).hexdigest() != file['hash'][7:]:
        raise ReleaseError('Downloaded XPI does not match AMO SHA-256')
    return data


def artifact_name(commit, version):
    return f'companion-{commit}-{version}'


def resolve_signed(version, output, issuer, secret):
    value = lookup_version(version, issuer, secret)
    if value is None:
        signing_dir = output.parent / 'web-ext-signed'
        signing_dir.mkdir(parents=True, exist_ok=False)
        command = [str(ROOT / 'node_modules/.bin/web-ext'), 'sign',
                   '--channel=unlisted', '--source-dir=' + str(SOURCE),
                   '--artifacts-dir=' + str(signing_dir),
                   '--approval-timeout=1800000', '--no-input']
        # Signing output and raw AMO errors may contain credentials. The
        # independent lookup supplies the authoritative state, never stderr.
        result = subprocess.run(command, cwd=ROOT, check=False,
                                capture_output=True, text=True, timeout=1920)
        if result.returncode < 0:
            raise ReleaseError('Signing process was terminated')
        if len(list(signing_dir.glob('*.xpi'))) > 1:
            raise ReleaseError('web-ext produced multiple signed XPI candidates')
        value = lookup_version(version, issuer, secret)
        if value is None:
            raise ReleaseError('AMO has no version after submission; inspect validation')
    file = approved_file(value)
    return download_signed_file(file), file


def write_summary(metadata):
    signed = metadata['signed']
    reason = metadata['resolution_reason']
    explanation = ('The exact version is approved and Mozilla-signed.' if signed
                   else FALLBACK_REASONS[reason])
    if reason in ('missing_credentials', 'incomplete_credentials'):
        explanation += (
            ' Configure both AMO_JWT_ISSUER and AMO_JWT_SECRET in the '
            '`amo-signing` environment; see [setup documentation]('
            'https://github.com/' + metadata['repository']
            + '/blob/' + metadata['source_commit'] + '/.github/REPOSITORY_SETTINGS.md).')
    if not signed:
        explanation += (
            ' The app remains usable; normal Firefox extension installation requires '
            'a Mozilla-signed package. A later application release/commit can resolve '
            'this same extension version again; existing immutable tags are retained.')
    message = (
        'Publishing with the ' + ('signed' if signed else 'unsigned')
        + ' Firefox companion. ' + explanation)
    print(('::warning::' if not signed and os.environ.get('GITHUB_ACTIONS') == 'true' else '') + message)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a', encoding='utf-8') as summary:
            summary.write(
                f"### Firefox companion resolution\n\n{message}\n\n"
                f"Add-on `{metadata['extension_id']}`, version `{metadata['extension_version']}`. "
                f"Source commit `{metadata['source_commit']}`. Reason `{reason}`.\n")


def sign(output, repository, commit, issuer, secret):
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ReleaseError('Trusted repository or commit context is invalid')
    # Even a signed success must first establish a trustworthy fallback package.
    validate()
    version = extension_identity()
    file = None
    reason = 'approved'
    try:
        if not issuer or not secret:
            raise SigningUnavailable(
                'incomplete_credentials' if issuer or secret else 'missing_credentials')
        data, file = resolve_signed(version, output, issuer, secret)
    except SigningUnavailable as exc:
        reason = exc.reason
        data = PACKAGE.read_bytes()
    signed = file is not None
    output.mkdir(parents=True, exist_ok=False)
    package = output / XPI_NAME
    checksum = output / (XPI_NAME + '.sha256')
    package.write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    checksum.write_text(f'{digest}  {XPI_NAME}\n', encoding='ascii')
    verify(SOURCE, package, checksum, require_identity=True, expected_signed=signed)
    metadata = {
        'schema': 2, 'repository': repository, 'source_commit': commit,
        'extension_id': EXTENSION_ID, 'extension_version': version,
        'source_sha256': source_digest(), 'xpi_sha256': digest,
        'signed': signed, 'resolution_reason': reason,
    }
    if signed:
        metadata.update(channel='unlisted', amo_file_id=file['id'],
                        amo_file_url=file['url'], amo_sha256=file['hash'][7:])
    (output / 'extension-metadata.json').write_text(
        json.dumps(metadata, sort_keys=True, indent=2) + '\n', encoding='utf-8')
    write_summary(metadata)
    return artifact_name(commit, version)


def stage(artifact, repository, commit):
    if {path.name for path in artifact.iterdir()} != ARTIFACT_FILES:
        raise ReleaseError('Extension artifact has missing or unexpected files')
    if any(path.is_symlink() or not path.is_file() for path in artifact.iterdir()):
        raise ReleaseError('Extension artifact contains a non-regular file')
    version = extension_identity()
    metadata = json.loads((artifact / 'extension-metadata.json').read_text(encoding='utf-8'))
    expected = {'schema': 2, 'repository': repository, 'source_commit': commit,
                'extension_id': EXTENSION_ID, 'extension_version': version,
                'source_sha256': source_digest()}
    if not isinstance(metadata, dict) or any(metadata.get(k) != v for k, v in expected.items()):
        raise ReleaseError('Extension artifact does not match the checked-out source and commit')
    signed = metadata.get('signed')
    if type(signed) is not bool or type(metadata['schema']) is not int:
        raise ReleaseError('Extension artifact has invalid signature-state metadata')
    fields = set(expected) | {'signed', 'resolution_reason', 'xpi_sha256'}
    if signed:
        fields |= {'channel', 'amo_file_id', 'amo_file_url', 'amo_sha256'}
        if (metadata.get('resolution_reason') != 'approved'
                or metadata.get('channel') != 'unlisted'
                or type(metadata.get('amo_file_id')) is not int
                or metadata['amo_file_id'] < 1
                or not isinstance(metadata.get('amo_file_url'), str)
                or not allowed_download_url(metadata['amo_file_url'])):
            raise ReleaseError('Extension artifact has invalid AMO provenance')
    elif metadata.get('resolution_reason') not in FALLBACK_REASONS:
        raise ReleaseError('Extension artifact has an unknown unsigned resolution reason')
    if set(metadata) != fields:
        raise ReleaseError('Extension artifact has missing or unexpected metadata fields')
    package = artifact / XPI_NAME
    checksum = artifact / (XPI_NAME + '.sha256')
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    if metadata.get('xpi_sha256') != digest:
        raise ReleaseError('Extension artifact hash differs from its metadata')
    if signed and metadata['amo_sha256'] != digest:
        raise ReleaseError('Extension artifact hash differs from AMO provenance')
    verify(SOURCE, package, checksum, require_identity=True, expected_signed=signed)
    shutil.copyfile(package, PACKAGE)
    shutil.copyfile(checksum, CHECKSUM)
    # The publisher passes these independently verified expectations into both
    # architecture checks, including the exact bytes selected in this run.
    if os.environ.get('GITHUB_OUTPUT'):
        with Path(os.environ['GITHUB_OUTPUT']).open('a', encoding='utf-8') as outputs:
            outputs.write(f'signed={str(signed).lower()}\nxpi_sha256={digest}\n')
    return metadata


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
            print(f'Verified extension artifact: {name}')
        else:
            stage(args.artifact, os.environ['GITHUB_REPOSITORY'],
                  os.environ['GITHUB_SHA'])
    except Exception as exc:
        # Never print raw transport exceptions, signing output or AMO bodies.
        detail = str(exc) if isinstance(exc, ReleaseError) else 'Validation, integrity, transport or tooling failure.'
        message = 'Extension resolution/staging blocked: ' + detail + ' Investigate before publication.'
        print(message, file=sys.stderr)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            try:
                with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a', encoding='utf-8') as summary:
                    summary.write(message + '\n')
            except OSError:
                pass
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
