import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from executor import Executor,ChatRestoreError,read,write
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
    def test_frozen_chat_attachment_is_backed_up_without_pending_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);e=fixture(root);digest='c'*64
            db=sqlite3.connect(str(root/'pluginData/blog.sqlite'))
            db.execute('CREATE TABLE chat_requests(data TEXT)')
            db.execute('INSERT INTO chat_requests VALUES(?)',(json.dumps({'attachments':[{'original':{'attachmentId':'sha256:'+digest,'name':'history.txt'}}]}),));db.commit();db.close()
            for relative in ['files/'+digest[:2]+'/'+digest+'/history.txt','file-objects/'+digest[:2]+'/'+digest]:
                path=root/'attachmentRoot'/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'frozen-history')
            stage=root/'stage';stage.mkdir();target,count=e.attachments(stage)
            self.assertEqual(count,2);self.assertEqual((target/'files'/digest[:2]/digest/'history.txt').read_bytes(),b'frozen-history')
    def test_old_backup_is_rejected_when_current_chat_exists(self):
        with tempfile.TemporaryDirectory() as directory,patch('executor.run',return_value=b'minio-fixture'):
            root=pathlib.Path(directory);e=fixture(root);backup_id=e.perform_backup()
            db=sqlite3.connect(str(root/'pluginData/blog.sqlite'));db.execute('CREATE TABLE conversations(id TEXT)');db.execute("INSERT INTO conversations VALUES('blog-chat-fixture')");db.commit();db.close()
            with self.assertRaisesRegex(ChatRestoreError,'此备份早于聊天功能'):e.verify(backup_id,for_restore=True)
            with self.assertRaisesRegex(ChatRestoreError,'已有聊天数据'):e.perform_backup()
            self.assertTrue(e.recovered)
    def test_chat_helper_uses_pinned_one_off_image_with_readonly_sources_after_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);e=fixture(root);e.c['dshContainer']='fixture-dsh'
            e.c['chat']={'sessionRoot':str(root/'sessions'),'storageRoot':str(root/'storage'),'cwd':'/data/workspace'}
            (root/'sessions').mkdir();(root/'storage').mkdir()
            e.service_active=lambda kind,name:True
            with self.assertRaisesRegex(RuntimeError,'must be stopped'):e.chat_stage('export',root/'blocked')
            self.assertFalse((root/'blocked').exists())
            e.service_active=lambda kind,name:False;commands=[]
            def command(args,**kwargs):
                commands.append(args)
                return ('sha256:'+'a'*64).encode() if args[1]=='inspect' else b'{"ok":true,"sessions":2}'
            with patch('executor.run',side_effect=command):output,result=e.chat_stage('export',root/'work')
            self.assertEqual(result['sessions'],2);self.assertEqual(commands[1][:3],['docker','run','--rm'])
            self.assertNotIn('exec',commands[1]);self.assertIn('none',commands[1]);self.assertIn('sha256:'+'a'*64,commands[1])
            self.assertEqual(commands[1][commands[1].index('--user')+1],'0:0')
            self.assertTrue(all(v.endswith(',readonly') for v in commands[1] if v.startswith('type=bind') and ',dst=/work' not in v))
            self.assertEqual(read(root/'work/request.json')['config']['cwd'],'/data/workspace')
    def test_failed_chat_swaps_roll_back_existing_new_and_removed_targets(self):
        with tempfile.TemporaryDirectory() as directory,patch('executor.run',return_value=b'true'):
            root=pathlib.Path(directory);e=fixture(root);e.c.update(phpUnit='php-fixture',dshContainer='dsh-fixture')
            old=root/'existing';old.write_text('before');removed=root/'removed';removed.write_text('delete only on commit')
            new=root/'brand-new';last=root/'last';last.write_text('last-before')
            replacement=root/'replacement';replacement.write_text('restored')
            swaps=[e.stage_swap(replacement,old,'fixture'),e.stage_swap(replacement,new,'fixture'),e.stage_swap(None,removed,'fixture'),e.stage_swap(replacement,last,'fixture')]
            journal={'committed':False,'imageChanged':False,'swaps':swaps};write(e.state/'restore-journal.json',journal)
            import os
            rename=os.rename
            def fail(source,dest):
                if str(source)==swaps[-1]['new']:raise OSError('injected after old file was moved')
                rename(source,dest)
            with patch('executor.os.rename',side_effect=fail):
                with self.assertRaises(OSError):e.apply_swaps(swaps)
            Executor.recover(e)
            self.assertEqual(old.read_text(),'before');self.assertEqual(removed.read_text(),'delete only on commit');self.assertEqual(last.read_text(),'last-before')
            self.assertFalse(new.exists());self.assertEqual(pathlib.Path(swaps[1]['new']+'.failed').read_text(),'restored')
            Executor.recover(e)
            self.assertEqual(old.read_text(),'before');self.assertTrue(read(e.state/'restore-journal.json')['rolledBack'])
    def test_safeguard_records_missing_attachment_but_regular_backup_fails(self):
        with tempfile.TemporaryDirectory() as directory,patch('executor.run',return_value=b'minio-fixture'):
            root=pathlib.Path(directory);e=fixture(root);digest='b'*64
            db=sqlite3.connect(str(root/'pluginData/blog.sqlite'));db.execute('INSERT INTO attachments VALUES(?)',(json.dumps({'original':{'attachmentId':'sha256:'+digest,'name':'lost.txt'}}),));db.commit();db.close()
            with self.assertRaises(FileNotFoundError):e.perform_backup()
            backup=e.perform_backup(rotate=False,allow_missing_attachments=True);manifest=e.verify(backup)
            self.assertEqual(len(manifest['missingAttachments']),2)
            self.assertEqual(manifest['attachmentFiles'],0)
            self.assertEqual(e.isolate(backup)['status'],'succeeded')

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
