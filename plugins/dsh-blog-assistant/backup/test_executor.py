import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from executor import Executor,read,write
from archive import checksum


class FakeServices(Executor):
    def __init__(self,c):super().__init__(c);self.stopped=False;self.recovered=False;self.sql=[]
    def databases(self):return {'blog':{'database':'fixture_blog','prefix':'typecho_'},'image':{'database':'fixture_image'}}
    def stop_writers(self):self.stopped=True
    def recover(self):self.recovered=True
    def mysql(self,sql=None,database=None,dump=None,target=None):
        if dump:
            if not self.stopped:raise AssertionError('dump started before stop evidence')
            target.write(b'CREATE TABLE sample(id int); INSERT INTO sample VALUES(42);')
        else:self.sql.append((sql,database));return b''


def fixture(root):
    c={key:str(root/key) for key in ['stateRoot','backupRoot','restoreRoot','blogRoot','imageRoot','pluginData','attachmentRoot','minioData']}
    for value in c.values():pathlib.Path(value).mkdir()
    c.update(bucket='pelyblog',strategyId=2,minioContainer='fixture-minio',nginxFiles=[])
    c['pluginConfig']=str(root/'config.json');write(c['pluginConfig'],{'schemaVersion':1})
    (root/'blogRoot/config.inc.php').write_text('<?php echo "fixture";')
    (root/'imageRoot/.env').write_text('DB_DATABASE=fixture_image')
    for part in ['pelyblog','.minio.sys/buckets/pelyblog']:
        folder=root/'minioData'/part;folder.mkdir(parents=True);(folder/'object').write_bytes(b'image-data')
    (root/'minioData/.minio.sys/format.json').write_text('{}')
    db=sqlite3.connect(str(root/'pluginData/blog.sqlite'));db.execute('CREATE TABLE attachments(data TEXT)');db.commit();db.close()
    return FakeServices(c)


class BackupTests(unittest.TestCase):
    def test_global_gtid_dump_rejected_before_restore_database_creation(self):
        with tempfile.TemporaryDirectory() as directory,patch('executor.run',return_value=b'minio-fixture'):
            e=fixture(pathlib.Path(directory));backup_id=e.perform_backup();path=e.backups/backup_id/'blog.sql'
            path.write_bytes(b"SET @@GLOBAL.GTID_PURGED='unsafe-server-state';\n")
            manifest=read(e.backups/backup_id/'manifest.json');manifest['components']['blog.sql']={'bytes':path.stat().st_size,'sha256':checksum(path)};write(e.backups/backup_id/'manifest.json',manifest)
            with self.assertRaises(ValueError):e.isolate(backup_id)
            self.assertEqual(e.sql,[])
    def test_official_attachment_ids_restore_exact_referenced_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);e=fixture(root);digest='a'*64
            references=[pathlib.Path('files')/'aa'/digest/'notes.txt',pathlib.Path('file-objects')/'aa'/digest,pathlib.Path('objects')/'aa'/digest]
            for relative in references:
                path=root/'attachmentRoot'/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'original-content')
            db=sqlite3.connect(str(root/'pluginData/blog.sqlite'));db.execute('INSERT INTO attachments VALUES(?)',(json.dumps({'original':{'attachmentId':'sha256:'+digest,'name':'notes.txt'},'image':{'attachmentId':'sha256:'+digest}}),));db.commit();db.close()
            stage=root/'stage';stage.mkdir();target,count=e.attachments(stage)
            self.assertEqual(count,3)
            for relative in references:self.assertEqual((target/relative).read_bytes(),b'original-content')
    def test_complete_backup_isolated_restore_and_corruption(self):
        with tempfile.TemporaryDirectory() as directory,patch('executor.run',return_value=b'minio-fixture'):
            root=pathlib.Path(directory);e=fixture(root);backup_id=e.perform_backup()
            self.assertTrue(e.stopped and e.recovered)
            manifest=e.verify(backup_id);self.assertEqual(manifest['status'],'complete')
            restored=e.isolate(backup_id);path=pathlib.Path(restored['path'])
            self.assertFalse((path/'blog-site/data/config.inc.php').exists())
            self.assertTrue((path/'blog-site/data/config.inc.php.restore-original').exists())
            self.assertEqual((path/'minio-bucket/data/object').read_bytes(),b'image-data')
            self.assertEqual((root/'blogRoot/config.inc.php').read_text(),'<?php echo "fixture";')
            self.assertTrue(all(not database or database.startswith('dsh_restore_') for sql,database in e.sql))
            component=e.backups/backup_id/'blog.sql';component.write_bytes(b'corrupted')
            with self.assertRaises(ValueError):e.verify(backup_id)
    def test_failure_recovers_services_and_does_not_rotate_old_backups(self):
        with tempfile.TemporaryDirectory() as directory,patch('executor.run',return_value=b'minio-fixture'):
            root=pathlib.Path(directory);e=fixture(root);first=e.perform_backup()
            (root/'minioData/pelyblog/object').unlink();(root/'minioData/pelyblog').rmdir();e.recovered=False
            with self.assertRaises(ValueError):e.perform_backup()
            self.assertTrue(e.recovered);self.assertEqual(read(e.state/'last.json')['status'],'failed');e.verify(first)
    def test_lock_rejects_concurrent_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            e=fixture(pathlib.Path(directory))
            with e.lock():
                with self.assertRaises(BlockingIOError):
                    with e.lock():pass
    def test_unfinished_swap_journal_restores_old_directory(self):
        with tempfile.TemporaryDirectory() as directory,patch('executor.run',return_value=b'true'):
            root=pathlib.Path(directory);e=fixture(root);e.c.update(phpUnit='php-fixture',dshContainer='dsh-fixture')
            live=root/'live';old=root/'old';new=root/'new';live.mkdir();old.mkdir();(live/'value').write_text('restored');(old/'value').write_text('original')
            write(e.state/'restore-journal.json',{'committed':False,'imageChanged':False,'swaps':[{'target':str(live),'old':str(old),'new':str(new)}]})
            Executor.recover(e)
            self.assertEqual((live/'value').read_text(),'original');self.assertEqual((root/'new.failed/value').read_text(),'restored')
            self.assertTrue(read(e.state/'restore-journal.json')['rolledBack'])


if __name__=='__main__':unittest.main()
