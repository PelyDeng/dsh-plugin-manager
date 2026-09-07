import io
import pathlib
import tarfile
import tempfile
import unittest
from archive import pack, unpack, checksum


class ArchiveTests(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root); source = root / 'site'; source.mkdir()
            (source / 'config.json').write_text('{"marker":"private"}')
            archive = root / 'site.tgz'; record = pack(source, archive)
            self.assertEqual(record['sha256'], checksum(archive))
            restored = unpack(archive, root / 'restore')
            self.assertEqual((restored / 'config.json').read_bytes(), (source / 'config.json').read_bytes())

    def test_traversal_and_links_rejected_before_extraction(self):
        for name, kind in [('data/../../outside', tarfile.REGTYPE), ('data/link', tarfile.SYMTYPE), ('/outside', tarfile.REGTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                root = pathlib.Path(root); archive = root / 'bad.tgz'
                with tarfile.open(str(archive), 'w:gz') as out:
                    item = tarfile.TarInfo(name); item.type = kind; item.linkname = '/etc/passwd'; item.size = 0
                    out.addfile(item, io.BytesIO(b''))
                with self.assertRaises(ValueError): unpack(archive, root / 'restore')
                self.assertFalse((root / 'restore').exists())


if __name__ == '__main__': unittest.main()
