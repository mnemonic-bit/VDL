#!/usr/bin/env python3
"""Verify that the bundled XPI contains exactly the reviewed extension source."""

import argparse
import hashlib
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


def verify(source=SOURCE, package=PACKAGE, checksum=CHECKSUM, *, require_signed=False):
    expected = checksum.read_text(encoding='ascii').strip().split()
    if (len(expected) != 2 or not re.fullmatch(r'[0-9a-f]{64}', expected[0])
            or expected[1].lstrip('*') != package.name):
        raise ValueError('XPI checksum file is malformed')
    if hashlib.sha256(package.read_bytes()).hexdigest() != expected[0]:
        raise ValueError('XPI checksum does not match the package')

    source_files = {}
    for path in source.rglob('*'):
        if path.is_symlink():
            raise ValueError('Extension source contains a symbolic link')
        if path.is_file():
            source_files[path.relative_to(source).as_posix()] = path.read_bytes()
    with zipfile.ZipFile(package) as archive:
        entries = [entry for entry in archive.infolist() if not entry.is_dir()]
        if any(stat.S_ISLNK(entry.external_attr >> 16) for entry in entries):
            raise ValueError('XPI contains a symbolic link')
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError('XPI contains duplicate archive members')
        payload = {name for name in names if not name.lower().startswith('meta-inf/')}
        if payload != set(source_files):
            raise ValueError('XPI payload does not match the source file list')
        for name in payload:
            if archive.read(name) != source_files[name]:
                raise ValueError(f'XPI payload differs from source: {name}')
        signature = {name.lower() for name in names if name.lower().startswith('meta-inf/')}
        if signature and signature != SIGNATURE_FILES:
            raise ValueError('XPI contains unexpected or incomplete signature metadata')
        if require_signed and not SIGNATURE_FILES.issubset(signature):
            raise ValueError('XPI lacks Mozilla signature metadata')
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
