#!/usr/bin/env python3
"""Verify that the bundled XPI contains exactly the reviewed extension source."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'browser-extension' / 'src'
PACKAGE = ROOT / 'browser-extension' / 'dist' / 'vdl-companion-firefox.xpi'
CHECKSUM = PACKAGE.with_suffix('.xpi.sha256')
SIGNATURE_FILES = {
    'meta-inf/manifest.mf',
    'meta-inf/mozilla.sf',
    'meta-inf/mozilla.rsa',
}
EXTENSION_ID = '{9f743f7e-c0b3-4b99-9e58-6434d3c883d4}'
UNSIGNED_RELEASE_HELP = """To obtain and bundle a signed XPI:
  1. From the repository root, run:
     npx --yes web-ext@latest build --source-dir browser-extension/src --artifacts-dir /tmp/vdl-extension
  2. Open https://addons.mozilla.org/en-US/developers/ and choose
     Submit a New Add-on > On your own. Upload the ZIP from /tmp/vdl-extension.
     When Mozilla finishes signing, download the signed XPI from My Add-ons.
  3. Replace browser-extension/dist/vdl-companion-firefox.xpi with that XPI.
  4. From the repository root, run:
     cd browser-extension/dist
     sha256sum vdl-companion-firefox.xpi > vdl-companion-firefox.xpi.sha256
     cd ../..
     python3 scripts/verify_companion_xpi.py --require-signed
See browser-extension/README.md for release and Firefox testing details."""


def _safe_member_name(name):
    parts = name.split('/')
    return (bool(name) and not name.startswith('/') and not name.endswith('/')
            and '\\' not in name and '\x00' not in name
            and all(part not in ('', '.', '..') for part in parts)
            and not re.match(r'^[A-Za-z]:', name))


def verify(source=SOURCE, package=PACKAGE, checksum=CHECKSUM, *, require_signed=False,
           require_identity=False):
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Extension source must be a real directory')
    expected_line = checksum.read_text(encoding='ascii')
    expected_match = re.fullmatch(
        rf'([0-9a-f]{{64}})  {re.escape(package.name)}\n', expected_line
    )
    if not expected_match:
        raise ValueError('XPI checksum file is malformed')
    if hashlib.sha256(package.read_bytes()).hexdigest() != expected_match.group(1):
        raise ValueError('XPI checksum does not match the package')

    source_files = {}
    for path in source.rglob('*'):
        if path.is_symlink():
            raise ValueError('Extension source contains a symbolic link')
        if path.is_dir():
            continue
        if not path.is_file() or not stat.S_ISREG(path.stat().st_mode):
            raise ValueError('Extension source contains a non-regular file')
        name = path.relative_to(source).as_posix()
        if not _safe_member_name(name):
            raise ValueError('Extension source contains an unsafe path')
        source_files[name] = path.read_bytes()
    if len({name.casefold() for name in source_files}) != len(source_files):
        raise ValueError('Extension source contains case-colliding paths')
    with zipfile.ZipFile(package) as archive:
        all_entries = archive.infolist()
        if any(not _safe_member_name(
                entry.filename[:-1] if entry.is_dir() else entry.filename)
               for entry in all_entries):
            raise ValueError('XPI contains an unsafe archive path')
        all_names = [entry.filename for entry in all_entries]
        if len(all_names) != len(set(all_names)):
            raise ValueError('XPI contains duplicate archive members')
        if len({name.casefold() for name in all_names}) != len(all_names):
            raise ValueError('XPI contains case-colliding archive members')
        entries = [entry for entry in all_entries if not entry.is_dir()]
        if sum(entry.file_size for entry in entries) > 60 * 1024 * 1024:
            raise ValueError('XPI expands beyond the release size limit')
        if any(entry.flag_bits & 1 for entry in entries):
            raise ValueError('XPI contains an encrypted archive member')
        if any((entry.create_system == 3 and
                stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG))
               for entry in entries):
            raise ValueError('XPI contains a non-regular archive member')
        names = [entry.filename for entry in entries]
        payload = {name for name in names if not name.lower().startswith('meta-inf/')}
        if payload != set(source_files):
            raise ValueError('XPI payload does not match the source file list')
        for name in payload:
            if archive.getinfo(name).file_size != len(source_files[name]):
                raise ValueError(f'XPI payload differs from source: {name}')
            if archive.read(name) != source_files[name]:
                raise ValueError(f'XPI payload differs from source: {name}')
        signature = {name.lower() for name in names if name.lower().startswith('meta-inf/')}
        if any(entry.file_size > 1024 * 1024 for entry in entries
               if entry.filename.lower().startswith('meta-inf/')):
            raise ValueError('XPI signature metadata exceeds the size limit')
        if signature and not SIGNATURE_FILES.issubset(signature):
            raise ValueError('XPI contains unexpected or incomplete signature metadata')
        if require_signed and not SIGNATURE_FILES.issubset(signature):
            raise ValueError('XPI lacks Mozilla signature metadata')
        if archive.testzip() is not None:
            raise ValueError('XPI contains a corrupt archive member')
        if require_identity:
            source_manifest = json.loads(source_files['manifest.json'])
            package_manifest = json.loads(archive.read('manifest.json'))
            for manifest in (source_manifest, package_manifest):
                gecko = manifest.get('browser_specific_settings', {}).get('gecko', {})
                if gecko.get('id') != EXTENSION_ID:
                    raise ValueError('XPI manifest add-on ID does not match VDL')
                if not re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,3}',
                                    str(manifest.get('version', ''))):
                    raise ValueError('XPI manifest has an invalid Firefox version')
    return bool(SIGNATURE_FILES.issubset(signature))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-signed', action='store_true',
                        help='reject development XPIs without Mozilla signature metadata')
    args = parser.parse_args()
    try:
        signed = verify(require_signed=args.require_signed)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(f'Companion XPI verification failed: {error}', file=sys.stderr)
        if args.require_signed:
            if str(error) == 'XPI lacks Mozilla signature metadata':
                print(UNSIGNED_RELEASE_HELP, file=sys.stderr)
            else:
                print('See browser-extension/README.md for the release process.',
                      file=sys.stderr)
        return 1
    print(f'Companion XPI matches source and checksum ({"signed" if signed else "unsigned"})')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
