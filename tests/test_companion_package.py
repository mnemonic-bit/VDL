import hashlib
from pathlib import Path
import tempfile
import unittest
import warnings
import zipfile

from scripts.verify_companion_xpi import verify


class CompanionPackageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = root / 'src'
        self.source.mkdir()
        (self.source / 'manifest.json').write_bytes(b'{"version":"1.0"}')
        self.package = root / 'companion.xpi'
        self.checksum = root / 'companion.xpi.sha256'

    def make_package(self, members):
        with zipfile.ZipFile(self.package, 'w') as archive:
            for name, body in members:
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore', UserWarning)
                    archive.writestr(name, body)
        digest = hashlib.sha256(self.package.read_bytes()).hexdigest()
        self.checksum.write_text(f'{digest}  companion.xpi\n', encoding='ascii')

    def check(self, *, require_signed=False):
        return verify(self.source, self.package, self.checksum,
                      require_signed=require_signed)

    def test_unsigned_development_package_matches_source(self):
        self.make_package([('manifest.json', b'{"version":"1.0"}')])
        self.assertFalse(self.check())
        with self.assertRaisesRegex(ValueError, 'lacks Mozilla signature'):
            self.check(require_signed=True)

    def test_signed_package_rejects_changed_payload_even_with_valid_checksum(self):
        members = [('manifest.json', b'{"version":"2.0"}'),
                   ('META-INF/manifest.mf', b'manifest'),
                   ('META-INF/mozilla.sf', b'signature'),
                   ('META-INF/mozilla.rsa', b'certificate')]
        self.make_package(members)
        with self.assertRaisesRegex(ValueError, 'payload differs'):
            self.check(require_signed=True)
        members[0] = ('manifest.json', b'{"version":"1.0"}')
        self.make_package(members)
        self.assertTrue(self.check(require_signed=True))

    def test_extra_or_duplicate_archive_members_are_rejected(self):
        self.make_package([('manifest.json', b'{"version":"1.0"}'),
                           ('unexpected.js', b'payload')])
        with self.assertRaisesRegex(ValueError, 'file list'):
            self.check()
        self.make_package([('manifest.json', b'{"version":"1.0"}'),
                           ('manifest.json', b'{"version":"1.0"}')])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.check()
        self.make_package([('manifest.json', b'{"version":"1.0"}'),
                           ('META-INF/extra', b'payload')])
        with self.assertRaisesRegex(ValueError, 'signature metadata'):
            self.check()

    def test_checksum_mismatch_is_rejected(self):
        self.make_package([('manifest.json', b'{"version":"1.0"}')])
        self.checksum.write_text('0' * 64 + '  companion.xpi\n', encoding='ascii')
        with self.assertRaisesRegex(ValueError, 'checksum does not match'):
            self.check()

    def test_source_symlink_is_rejected(self):
        self.make_package([('manifest.json', b'{"version":"1.0"}')])
        (self.source / 'linked.json').symlink_to(self.source / 'manifest.json')
        with self.assertRaisesRegex(ValueError, 'symbolic link'):
            self.check()

    def test_unsafe_member_paths_and_case_collisions_are_rejected(self):
        for name in ('../manifest.json', '/manifest.json',
                     'folder\\manifest.json', 'C:/manifest.json',
                     'folder//manifest.json', 'folder/./manifest.json'):
            with self.subTest(name=name):
                self.make_package([(name, b'{}')])
                with self.assertRaisesRegex(ValueError, 'unsafe archive path'):
                    self.check()
        self.make_package([
            ('manifest.json', b'{"version":"1.0"}'),
            ('MANIFEST.JSON', b'{"version":"1.0"}'),
        ])
        with self.assertRaisesRegex(ValueError, 'case-colliding'):
            self.check()

    def test_extra_signature_metadata_is_allowed_when_signature_trio_exists(self):
        self.make_package([
            ('manifest.json', b'{"version":"1.0"}'),
            ('META-INF/manifest.mf', b'manifest'),
            ('META-INF/mozilla.sf', b'signature'),
            ('META-INF/mozilla.rsa', b'certificate'),
            ('META-INF/cose.sig', b'additional Mozilla metadata'),
        ])
        self.assertTrue(self.check(require_signed=True))


if __name__ == '__main__':
    unittest.main()
