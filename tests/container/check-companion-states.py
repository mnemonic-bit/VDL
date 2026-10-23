#!/usr/bin/env python3
"""Build and smoke-test both package states, using synthetic signature fixtures.

This checks orchestration and package state, not Mozilla signature validity.
Use --platform linux/arm64 on a host with QEMU/binfmt support.
"""

import argparse
import hashlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts import extension_release as release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', default='linux/amd64',
                        choices=('linux/amd64', 'linux/arm64'))
    args = parser.parse_args()
    engine = os.environ.get('CONTAINER_ENGINE') or shutil.which('docker') or shutil.which('podman')
    if not engine:
        parser.error('Docker or Podman is required')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    with tempfile.TemporaryDirectory(prefix='vdl-companion-states-') as temp:
        context = Path(temp) / 'context'
        context.mkdir()
        for name in ('Dockerfile', 'requirements-container.in', 'requirements-container.constraints',
                     'requirements-container.txt', 'vdl.py', 'download_bandwidth.py',
                     'download_history.py', 'docker-entrypoint.sh', 'VERSION'):
            shutil.copyfile(ROOT / name, context / name)
        for name in ('templates', 'static'):
            shutil.copytree(ROOT / name, context / name)
        dist = context / 'browser-extension/dist'
        dist.mkdir(parents=True)
        for signed in (False, True):
            artifact = Path(temp) / ('signed' if signed else 'unsigned')
            if signed:
                body = io.BytesIO(release.PACKAGE.read_bytes())
                with zipfile.ZipFile(body, 'a') as archive:
                    for name in ('manifest.mf', 'mozilla.sf', 'mozilla.rsa'):
                        archive.writestr('META-INF/' + name, 'synthetic test signature')
                data = body.getvalue()
                file = {'id': 17, 'url': 'https://addons.mozilla.org/fixture.xpi',
                        'hash': 'sha256:' + hashlib.sha256(data).hexdigest()}
                with mock.patch.object(release, 'resolve_signed', return_value=(data, file)):
                    release.sign(artifact, 'local/vdl', commit, 'fixture', 'fixture')
            else:
                release.sign(artifact, 'local/vdl', commit, None, None)
            with mock.patch.object(release, 'PACKAGE', dist / release.XPI_NAME), \
                    mock.patch.object(release, 'CHECKSUM', dist / (release.XPI_NAME + '.sha256')):
                metadata = release.stage(artifact, 'local/vdl', commit)
            image = f'localhost/vdl-companion-test:{os.getpid()}-{str(signed).lower()}'
            try:
                subprocess.run([engine, 'build', '--platform', args.platform,
                                '--tag', image, str(context)], check=True, cwd=ROOT)
                env = dict(os.environ, CONTAINER_ENGINE=engine, VDL_IMAGE=image,
                           DOCKER_DEFAULT_PLATFORM=args.platform,
                           VDL_EXPECT_COMPANION_SIGNED=str(signed).lower(),
                           VDL_EXPECT_COMPANION_SHA256=metadata['xpi_sha256'])
                subprocess.run([str(ROOT / 'tests/container/smoke.sh')], check=True, cwd=ROOT, env=env)
            finally:
                subprocess.run([engine, 'image', 'rm', image], check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
