#!/usr/bin/env python3
"""Fixed server-side backup service; not a model tool or general shell gateway."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request
import urllib.parse
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from archive import checksum, pack, unpack, within

UTC8 = datetime.timezone(datetime.timedelta(hours=8))
IDENT = re.compile(r'^[A-Za-z0-9_]+$')
BACKUP_ID = re.compile(r'^\d{8}T\d{6}-[a-f0-9]{8}$')


def read(path, default=None):
    try:
        with open(str(path), encoding='utf-8') as stream: return json.load(stream)
    except FileNotFoundError:
        if default is not None: return default
        raise


def write(path, value):
    path = pathlib.Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.' + secrets.token_hex(6))
    descriptor = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False); stream.flush(); os.fsync(stream.fileno())
    os.replace(str(temp), str(path))


def run(command, stdin=None, stdout=None, timeout=180):
    result = subprocess.run(command, input=stdin, stdout=stdout if stdout is not None else subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode: raise RuntimeError('fixed service command failed: ' + pathlib.Path(command[0]).name)
    return result.stdout


def load_config(path):
    path = pathlib.Path(path).resolve(); c = read(path)
    if c.get('schemaVersion') != 1: raise ValueError('unsupported backup configuration')
    for field in ['pluginConfig', 'stateRoot', 'backupRoot', 'restoreRoot', 'blogRoot', 'imageRoot', 'pluginData', 'attachmentRoot', 'minioData', 'phpBinary']:
        p = pathlib.Path(c[field])
        if not p.is_absolute() or p == pathlib.Path('/'): raise ValueError('absolute scoped path required: ' + field)
        c[field] = str(p.resolve())
    for field in ['mysqlContainer', 'minioContainer', 'dshContainer', 'phpUnit']:
        if not re.match(r'^[A-Za-z0-9_.-]+$', c[field]): raise ValueError('invalid service identifier')
    if not re.match(r'^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$', c['bucket']): raise ValueError('invalid bucket')
    if not isinstance(c['strategyId'], int) or c['strategyId'] < 1: raise ValueError('invalid strategy')
    if not isinstance(c['port'], int) or not 1024 <= c['port'] <= 65535: raise ValueError('invalid port')
    origin=urllib.parse.urlsplit(c['dshOrigin'])
    if origin.scheme!='http' or origin.hostname not in ['127.0.0.1','::1'] or origin.username or origin.password or origin.path:raise ValueError('DSH authorization callback must be a loopback origin')
    sources = [c[k] for k in ['blogRoot','imageRoot','pluginData','attachmentRoot','minioData']]
    for field in ['stateRoot','backupRoot','restoreRoot']:
        if any(within(c[field], source) or within(source,c[field]) for source in sources): raise ValueError('backup and source roots must be separate')
        pathlib.Path(c[field]).mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(c[field],0o700)
    c['_path'] = str(path)
    return c


class Executor:
    def __init__(self, config):
        self.c = config; self.state = pathlib.Path(config['stateRoot']); self.backups = pathlib.Path(config['backupRoot'])
    @contextlib.contextmanager
    def lock(self):
        with open(str(self.state / 'operation.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
    def mysql(self, sql=None, database=None, dump=None, target=None):
        args = ['mysqldump', '-uroot', '--lock-all-tables', '--no-tablespaces', '--hex-blob', '--skip-add-locks', '--default-character-set=utf8mb4'] if dump else ['mysql', '-uroot', '--batch', '--raw', '--skip-column-names', '--default-character-set=utf8mb4']
        name = dump or database
        if name:
            if not IDENT.match(name): raise ValueError('invalid database identifier')
            args.append(name)
        command = ['docker','exec','-i',self.c['mysqlContainer'],'sh','-c',
                   'export MYSQL_PWD="$(cat "$MYSQL_ROOT_PASSWORD_FILE")"; exec "$@"','sh'] + args
        return run(command, stdin=sql.encode() if isinstance(sql,str) else sql, stdout=target, timeout=600)
    def databases(self):
        php = self.c['phpBinary']
        blog = run([php,'-r',"require $argv[1].'/config.inc.php';echo json_encode(['database'=>Typecho\\Db::get()->getConfig(Typecho\\Db::WRITE)->database,'prefix'=>Typecho\\Db::get()->getPrefix()]);",self.c['blogRoot']])
        image = run([php,'-r',"require $argv[1].'/vendor/autoload.php';$app=require $argv[1].'/bootstrap/app.php';$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();echo json_encode(['database'=>config('database.connections.mysql.database')]);",self.c['imageRoot']])
        result = {'blog':json.loads(blog.decode()),'image':json.loads(image.decode())}
        for v in result.values():
            if not IDENT.match(v['database']): raise ValueError('invalid source database')
            name=v['database']
            unsupported=self.mysql("SELECT (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='"+name+"')+(SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='"+name+"');").decode().strip()
            if unsupported!='0':raise ValueError('stored routines or events require an explicitly validated restore policy')
        return result
    def service_active(self, kind, name):
        if kind == 'systemd': return subprocess.call(['systemctl','is-active','--quiet',name]) == 0
        return run(['docker','inspect',name,'--format','{{.State.Running}}']).decode().strip() == 'true'
    def stop_writers(self):
        services = [('systemd',self.c['phpUnit']),('docker',self.c['dshContainer']),('docker',self.c['minioContainer'])]
        active = [{'kind':k,'name':n} for k,n in services if self.service_active(k,n)]
        write(self.state/'stopped.json',{'services':active,'at':time.time()})
        for service in active:
            command = ['systemctl','stop',service['name']] if service['kind']=='systemd' else ['docker','stop','--time','45',service['name']]
            run(command,timeout=90)
            if self.service_active(service['kind'],service['name']): raise RuntimeError('writer did not stop')
        write(self.state/'stop-evidence.json',{'services':active,'verifiedStoppedAt':time.time()})
    def recover(self):
        journal=read(self.state/'restore-journal.json',{})
        if journal and not journal.get('committed'):
            if journal.get('imageChanged'):
                self.restore_images(journal['imageDatabase'],journal['rollbackImageDatabase'])
            for entry in reversed(journal.get('swaps',[])):
                target,old,new=map(pathlib.Path,[entry['target'],entry['old'],entry['new']])
                if old.exists():
                    if target.exists():os.rename(str(target),str(new)+'.failed')
                    os.rename(str(old),str(target))
            journal['committed']=True;journal['rolledBack']=True;write(self.state/'restore-journal.json',journal)
        record=read(self.state/'stopped.json',{'services':[]}); failed=[]
        allowed={self.c['phpUnit'],self.c['dshContainer'],self.c['minioContainer']}
        for service in reversed(record['services']):
            if service['name'] not in allowed: raise ValueError('unexpected recovery service')
            try:
                run(['systemctl','start',service['name']] if service['kind']=='systemd' else ['docker','start',service['name']],timeout=120)
                if not self.service_active(service['kind'],service['name']): raise RuntimeError('restart incomplete')
            except Exception: failed.append(service['name'])
        if failed: raise RuntimeError('service restart incomplete')
        write(self.state/'stopped.json',{'services':[]})
    def authorize_restore(self,actor):
        token=read(self.c['pluginConfig'])['backup']['token']
        data=json.dumps({'actor':actor}).encode()
        request=urllib.request.Request(self.c['dshOrigin']+'/blog/backup-authorize',data=data,headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
        deadline=time.monotonic()+60
        while True:
            try:
                with urllib.request.urlopen(request,timeout=10) as response:
                    if response.status!=200 or json.loads(response.read(4096).decode()).get('ok') is not True:raise ValueError('restore authorization expired')
                return
            except urllib.error.HTTPError as error:
                if error.code not in [502,503,504] or time.monotonic()>=deadline:raise
            except (urllib.error.URLError,TimeoutError):
                if time.monotonic()>=deadline:raise
            time.sleep(1)
    def attachments(self, stage):
        source=pathlib.Path(self.c['attachmentRoot']); target=stage/'attachment-files';target.mkdir(mode=0o700)
        database=pathlib.Path(self.c['pluginData'])/'blog.sqlite'
        db=sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True)
        paths=set()
        try:
            for row in db.execute('SELECT data FROM attachments'):
                a=json.loads(row[0])
                for key in ['original','image']:
                    ref=a.get(key)
                    if not ref: continue
                    match=re.match(r'^sha256:([a-f0-9]{64})$',ref['attachmentId'])
                    if not match: raise ValueError('unsupported official attachment layout')
                    digest=match.group(1)
                    if key=='original':
                        name=ref['name']
                        if pathlib.Path(name).name!=name or '\\' in name: raise ValueError('invalid attachment reference')
                        paths.add(pathlib.Path('files')/digest[:2]/digest/name)
                        paths.add(pathlib.Path('file-objects')/digest[:2]/digest)
                    else: paths.add(pathlib.Path('objects')/digest[:2]/digest)
            for relative in paths:
                if not within(source/relative,source): raise ValueError('attachment outside provider root')
                destination=target/relative;destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                shutil.copy2(str(source/relative),str(destination))
        finally: db.close()
        return target,len(paths)
    def perform_backup(self, rotate=True):
        databases=self.databases()
        backup_id=datetime.datetime.now(UTC8).strftime('%Y%m%dT%H%M%S')+'-'+secrets.token_hex(4)
        destination=self.backups/backup_id;destination.mkdir(mode=0o700)
        state={'id':backup_id,'operation':'backup','status':'running','startedAt':time.time()};write(self.state/'current.json',state)
        manifest={'schemaVersion':1,'id':backup_id,'status':'writing','createdAt':time.time(),'databases':databases,'bucket':self.c['bucket'],'strategyId':self.c['strategyId'],'consistency':'PHP, DSH and MinIO verified stopped; mysqldump lock-all-tables','components':{}}
        try:
            self.stop_writers()
            for key,info in databases.items():
                path=destination/(key+'.sql')
                with open(str(path),'wb') as output:self.mysql(dump=info['database'],target=output)
                os.chmod(str(path),0o600);manifest['components'][path.name]={'bytes':path.stat().st_size,'sha256':checksum(path)}
            sources={'blog-site':self.c['blogRoot'],'image-site':self.c['imageRoot'],'plugin-data':self.c['pluginData'],'plugin-config':self.c['pluginConfig'],
                     'minio-bucket':str(pathlib.Path(self.c['minioData'])/self.c['bucket']),
                     'minio-bucket-metadata':str(pathlib.Path(self.c['minioData'])/'.minio.sys/buckets'/self.c['bucket']),
                     'minio-format':str(pathlib.Path(self.c['minioData'])/'.minio.sys/format.json')}
            attachment_stage=destination/'staging';attachment_stage.mkdir(mode=0o700)
            sources['attachment-files'],manifest['attachmentFiles']=self.attachments(attachment_stage)
            for index,path in enumerate(self.c.get('nginxFiles',[])): sources['nginx-'+str(index)]=path
            for name,source in sources.items():manifest['components'][name+'.tar.gz']=pack(source,destination/(name+'.tar.gz'))
            manifest['minioImage']=run(['docker','inspect',self.c['minioContainer'],'--format','{{.Config.Image}}']).decode().strip()
            shutil.rmtree(str(attachment_stage))
            manifest['status']='complete';write(destination/'manifest.json',manifest)
            self.verify(backup_id)
            state.update(status='succeeded',finishedAt=time.time());write(self.state/'current.json',state);write(self.state/'last.json',state)
        except Exception as error:
            manifest['status']='failed';write(destination/'manifest.json',manifest)
            state.update(status='failed',message='备份未完成，已保留旧备份；检查服务恢复状态',errorType=type(error).__name__,finishedAt=time.time());write(self.state/'current.json',state);write(self.state/'last.json',state)
            raise
        finally:
            try:self.recover()
            except Exception:
                state.update(status='failed',message='备份数据已保留，但相关服务尚未恢复，请检查运维状态',finishedAt=time.time());write(self.state/'current.json',state);write(self.state/'last.json',state);raise
        if rotate:self.rotate()
        return backup_id
    def verify(self, backup_id):
        if not isinstance(backup_id,str) or not BACKUP_ID.match(backup_id): raise ValueError('invalid backup id')
        directory=self.backups/backup_id
        if not within(directory,self.backups) or directory.is_symlink():raise ValueError('invalid backup directory')
        manifest=read(directory/'manifest.json')
        if manifest.get('schemaVersion')!=1 or manifest.get('id')!=backup_id or manifest.get('status')!='complete':raise ValueError('backup not complete')
        required={'blog.sql','image.sql','blog-site.tar.gz','image-site.tar.gz','plugin-data.tar.gz','plugin-config.tar.gz','minio-bucket.tar.gz','minio-bucket-metadata.tar.gz','minio-format.tar.gz','attachment-files.tar.gz'}
        if not required.issubset(manifest['components']):raise ValueError('backup components missing')
        for name,record in manifest['components'].items():
            if not re.match(r'^[a-z0-9-]+\.(sql|tar\.gz)$',name):raise ValueError('invalid component name')
            path=directory/name
            if path.is_symlink() or path.stat().st_size!=record['bytes'] or checksum(path)!=record['sha256']:raise ValueError('backup checksum mismatch')
        return manifest
    def list_backups(self):
        items=[]
        for path in self.backups.iterdir():
            if not path.is_dir() or path.is_symlink() or not BACKUP_ID.match(path.name):continue
            try:
                m=read(path/'manifest.json');items.append({'id':path.name,'status':m['status'],'createdAt':m['createdAt']})
            except (ValueError,KeyError,FileNotFoundError):continue
        return sorted(items,key=lambda x:x['createdAt'],reverse=True)
    def schedule(self):return read(self.state/'schedule.json',{'enabled':True,'time':'03:00','daily':7,'weekly':4})
    def set_schedule(self, data):
        if not isinstance(data.get('enabled'),bool) or not re.match(r'^([01]\d|2[0-3]):[0-5]\d$',data.get('time','')):raise ValueError('invalid schedule')
        for key,limit in [('daily',90),('weekly',52)]:
            if type(data.get(key)) is not int or not 1<=data[key]<=limit:raise ValueError('invalid retention')
        schedule={k:data[k] for k in ['enabled','time','daily','weekly']}
        folder=pathlib.Path('/etc/systemd/system/dsh-blog-backup.timer.d');folder.mkdir(parents=True,exist_ok=True)
        (folder/'schedule.conf').write_text('[Timer]\nOnCalendar=\nOnCalendar=*-*-* '+schedule['time']+':00 Asia/Shanghai\nPersistent=true\n',encoding='utf-8')
        run(['systemctl','daemon-reload']);run(['systemctl','enable' if schedule['enabled'] else 'disable','--now','dsh-blog-backup.timer'])
        if schedule['enabled']:run(['systemctl','restart','dsh-blog-backup.timer'])
        write(self.state/'schedule.json',schedule);return schedule
    def rotate(self):
        schedule=self.schedule();items=[b for b in self.list_backups() if b['status']=='complete'];keep=set();weeks=set();days=set()
        for item in items:
            date=datetime.datetime.fromtimestamp(item['createdAt'],UTC8);day=date.date().isoformat();week=date.strftime('%G-%V')
            if day not in days and len(days)<schedule['daily']:days.add(day);keep.add(item['id'])
            if week not in weeks and len(weeks)<schedule['weekly']:weeks.add(week);keep.add(item['id'])
        for item in items:
            if item['id'] not in keep:
                self.verify(item['id'])
                target=(self.backups/item['id']).resolve()
                if target.parent!=self.backups.resolve():raise ValueError('retention boundary violation')
                shutil.rmtree(str(target))
    def isolate(self, backup_id):
        manifest=self.verify(backup_id);restore_id='restore-'+backup_id+'-'+secrets.token_hex(4)
        target=pathlib.Path(self.c['restoreRoot'])/restore_id;target.mkdir(mode=0o700)
        for name in manifest['components']:
            if name.endswith('.tar.gz'):unpack(self.backups/backup_id/name,target/name[:-7])
        databases={}
        for key in ['blog','image']:
            name='dsh_restore_'+key+'_'+secrets.token_hex(6)
            self.mysql('CREATE DATABASE `'+name+'` CHARACTER SET utf8mb4;')
            with open(str(self.backups/backup_id/(key+'.sql')),'rb') as stream:self.mysql(sql=stream.read(),database=name)
            databases[key]=name
        # Isolated output deliberately has no running web service. Its config must not connect to production.
        for relative in ['blog-site/data/config.inc.php','image-site/data/.env','plugin-config/data']:
            path=target/relative
            if path.exists():os.rename(str(path),str(path)+'.restore-original')
        report={'id':restore_id,'backupId':backup_id,'status':'succeeded','mode':'isolated','databases':databases,'path':str(target),'at':time.time(),'note':'配置已隔离，未启动站点；不会连接生产数据库'}
        write(target/'restore.json',report);return report
    def restore_images(self,current,restored,validate=True):
        if not IDENT.match(current) or not IDENT.match(restored):raise ValueError('invalid restore database')
        a,b='`'+current+'`','`'+restored+'`';strategy=str(self.c['strategyId'])
        # Preserve every other strategy. References must already identify the same owner/group/album.
        if validate:
            checks=[
                'SELECT COUNT(*) FROM '+b+'.images i LEFT JOIN '+a+'.users u ON i.user_id=u.id LEFT JOIN '+b+'.users old ON i.user_id=old.id WHERE i.strategy_id='+strategy+' AND i.user_id IS NOT NULL AND (u.id IS NULL OR NOT (u.email <=> old.email));',
                'SELECT COUNT(*) FROM '+b+'.images i LEFT JOIN '+a+'.albums r ON i.album_id=r.id WHERE i.strategy_id='+strategy+' AND i.album_id IS NOT NULL AND r.id IS NULL;',
                'SELECT COUNT(*) FROM '+b+'.images i LEFT JOIN '+a+'.groups r ON i.group_id=r.id WHERE i.strategy_id='+strategy+' AND i.group_id IS NOT NULL AND r.id IS NULL;',
                'SELECT COUNT(*) FROM '+b+'.images i JOIN '+a+'.images live ON (i.id=live.id OR i.`key`=live.`key`) WHERE i.strategy_id='+strategy+' AND NOT (live.strategy_id <=> '+strategy+');',
                'SELECT COUNT(*) FROM '+a+'.strategies live JOIN '+b+'.strategies old ON live.id=old.id WHERE live.id='+strategy+' AND live.`key`=old.`key` AND live.configs=old.configs;'
            ]
            values=[int(v) for v in self.mysql('\n'.join(checks)).decode().split()]
            if values != [0,0,0,0,1]:raise ValueError('image restore references or strategy changed; unrelated data protected')
        columns=self.mysql('SHOW COLUMNS FROM '+a+'.images;').decode().splitlines()
        names=[row.split('\t')[0] for row in columns]
        other=[row.split('\t')[0] for row in self.mysql('SHOW COLUMNS FROM '+b+'.images;').decode().splitlines()]
        if names!=other or not all(IDENT.match(n) for n in names):raise ValueError('image schemas differ')
        fields=','.join('`'+n+'`' for n in names)
        self.mysql('START TRANSACTION; DELETE FROM '+a+'.images WHERE strategy_id='+strategy+'; INSERT INTO '+a+'.images ('+fields+') SELECT '+fields+' FROM '+b+'.images WHERE strategy_id='+strategy+'; COMMIT;')
    def stage_swap(self, source, target, restore_id):
        source,target=pathlib.Path(source),pathlib.Path(target)
        if not target.is_absolute() or target==pathlib.Path('/') or target.is_symlink():raise ValueError('unsafe live target')
        new=target.parent/('.'+target.name+'.'+restore_id+'.new');old=target.parent/('.'+target.name+'.'+restore_id+'.before')
        if new.exists() or old.exists():raise ValueError('restore staging already exists')
        if source.is_dir():shutil.copytree(str(source),str(new),symlinks=True)
        else:shutil.copy2(str(source),str(new))
        if source.is_file():
            if checksum(source)!=checksum(new):raise ValueError('staged file differs')
        else:
            for folder,dirs,files in os.walk(str(source),followlinks=False):
                for name in files:
                    original=pathlib.Path(folder)/name;copy=new/original.relative_to(source)
                    if original.is_symlink():
                        if os.readlink(str(original))!=os.readlink(str(copy)):raise ValueError('staged link differs')
                    elif checksum(original)!=checksum(copy):raise ValueError('staged file differs')
        # shutil.copytree does not preserve ownership; copy each entry's uid/gid.
        if hasattr(os,'chown'):
            entries=[source]
            if source.is_dir():
                for folder,dirs,files in os.walk(str(source),followlinks=False):entries.extend(pathlib.Path(folder)/n for n in dirs+files)
            for original in entries:
                copy=new if original==source else new/original.relative_to(source);stat=original.lstat();os.lchown(str(copy),stat.st_uid,stat.st_gid)
        return {'target':str(target),'new':str(new),'old':str(old)}
    def production_restore(self, backup_id, actor):
        m=self.verify(backup_id)
        if m['bucket']!=self.c['bucket'] or m['strategyId']!=self.c['strategyId']:raise ValueError('restore storage scope differs')
        restored=self.isolate(backup_id);target=pathlib.Path(restored['path']);restore_id=restored['id']
        # A fresh complete backup protects current databases and files before the first live mutation.
        safeguard=self.perform_backup(rotate=False);before=self.isolate(safeguard);databases=self.databases()
        self.authorize_restore(actor)
        self.stop_writers()
        journal={'id':restore_id,'committed':False,'imageChanged':False,'swaps':[],'imageDatabase':databases['image']['database'],'rollbackImageDatabase':before['databases']['image']}
        write(self.state/'restore-journal.json',journal)
        try:
            # Switch the restored blog to a new scoped database, retaining the previous database intact.
            db_user='dsh_restore_'+secrets.token_hex(6);password=secrets.token_hex(24);blog_database=restored['databases']['blog']
            self.mysql("CREATE USER '"+db_user+"'@'%' IDENTIFIED BY '"+password+"'; GRANT ALL ON `"+blog_database+"`.* TO '"+db_user+"'@'%';")
            original=target/'blog-site/data/config.inc.php.restore-original';config=target/'blog-site/data/config.inc.php'
            os.rename(str(original),str(target/'blog-site/data/config.restore-original.inc.php'))
            encoded=__import__('base64').b64encode(json.dumps({'user':db_user,'password':password,'database':blog_database}).encode()).decode()
            config.write_text("<?php\nrequire __DIR__.'/config.restore-original.inc.php';\n$c=\\Typecho\\Db::get()->getConfig(\\Typecho\\Db::WRITE)->toArray();\n$c=array_merge($c,json_decode(base64_decode('"+encoded+"'),true));\n$db=new \\Typecho\\Db('Pdo_Mysql',\\Typecho\\Db::get()->getPrefix());\n$db->addServer($c,\\Typecho\\Db::READ|\\Typecho\\Db::WRITE);\\Typecho\\Db::set($db);\n",encoding='utf-8')
            previous=pathlib.Path(self.c['blogRoot'])/'config.inc.php';os.chmod(str(config),previous.stat().st_mode & 0o777);os.chown(str(config),previous.stat().st_uid,previous.stat().st_gid)
            mappings=[(target/'blog-site/data',self.c['blogRoot']),(target/'plugin-data/data',self.c['pluginData']),
                      (target/'minio-bucket/data',pathlib.Path(self.c['minioData'])/self.c['bucket']),
                      (target/'minio-bucket-metadata/data',pathlib.Path(self.c['minioData'])/'.minio.sys/buckets'/self.c['bucket'])]
            saved=read(target/'plugin-config/data.restore-original');current=read(self.c['pluginConfig']);current['blog']=saved['blog']
            config_stage=target/'runtime-config.json';write(config_stage,current)
            current_stat=pathlib.Path(self.c['pluginConfig']).stat();os.chmod(str(config_stage),current_stat.st_mode & 0o777);os.chown(str(config_stage),current_stat.st_uid,current_stat.st_gid)
            mappings.append((config_stage,self.c['pluginConfig']))
            for source,destination in mappings:journal['swaps'].append(self.stage_swap(source,destination,restore_id))
            write(self.state/'restore-journal.json',journal)
            # Immutable official objects can be added without overwriting unrelated objects or references.
            source=target/'attachment-files/data';provider=pathlib.Path(self.c['attachmentRoot'])
            for folder,dirs,files in os.walk(str(source),followlinks=False):
                for filename in files:
                    item=pathlib.Path(folder)/filename;dest=provider/item.relative_to(source)
                    if not within(dest,provider):raise ValueError('attachment restore path escaped')
                    if dest.exists():
                        if checksum(dest)!=checksum(item):raise ValueError('attachment digest collision')
                    else:
                        # Restore newly added objects with the provider's owner, not the root executor's.
                        owner=provider.stat();missing=[];parent=dest.parent
                        while not parent.exists():missing.append(parent);parent=parent.parent
                        for directory in reversed(missing):
                            directory.mkdir(mode=0o700);os.chown(str(directory),owner.st_uid,owner.st_gid)
                        shutil.copy2(str(item),str(dest));os.chown(str(dest),owner.st_uid,owner.st_gid)
            journal['imageChanged']=True;write(self.state/'restore-journal.json',journal)
            self.restore_images(databases['image']['database'],restored['databases']['image'])
            for entry in journal['swaps']:
                if pathlib.Path(entry['target']).exists():os.rename(entry['target'],entry['old'])
                os.rename(entry['new'],entry['target'])
            journal['committed']=True;write(self.state/'restore-journal.json',journal)
            return {'id':restore_id,'backupId':backup_id,'safeguardBackupId':safeguard,'mode':'production','status':'succeeded','at':time.time(),'note':'博客与 pelyblog 图片已恢复；原目录与原数据库完整保留'}
        finally:self.recover()
    def status(self):
        next_run=run(['systemctl','show','dsh-blog-backup.timer','--property=NextElapseUSecRealtime','--value']).decode().strip()
        return {'schedule':self.schedule(),'nextRun':next_run,'current':read(self.state/'current.json',{}),'last':read(self.state/'last.json',{}),'backups':self.list_backups(),'recoveryPending':bool(read(self.state/'stopped.json',{'services':[]})['services'])}


def serve(executor):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            try:
                config=read(executor.c['pluginConfig']);token=config['backup']['token']
                supplied=self.headers.get('Authorization','')
                if not isinstance(token,str) or len(token)<32 or not hmac.compare_digest(supplied,'Bearer '+token):self.reply(403,{'error':'forbidden'});return
                size=int(self.headers.get('Content-Length','0'))
                if size<1 or size>16384:raise ValueError('invalid request size')
                self.connection.settimeout(10);data=json.loads(self.rfile.read(size).decode('utf-8'))
                actor=data.get('actor',{})
                if actor.get('userId') not in config['backup']['allowedUserIds'] or not isinstance(actor.get('sessionId'),str):self.reply(403,{'error':'forbidden'});return
                if self.path=='/status':result=executor.status()
                elif self.path=='/run':
                    with executor.lock():run(['systemctl','start','--no-block','dsh-blog-backup-run.service'])
                    result={'status':'accepted'}
                elif self.path=='/schedule':
                    with executor.lock():result=executor.set_schedule(data)
                elif self.path=='/verify':
                    m=executor.verify(data.get('id'));result={'id':m['id'],'status':'verified','components':len(m['components'])}
                elif self.path=='/restore-prepare':
                    backup_id=data.get('id');executor.verify(backup_id)
                    # Interactive confirmations are scoped and single-use; the web app rechecks auth before dispatch.
                    confirmation={'id':secrets.token_hex(16),'nonce':secrets.token_hex(24),'actor':actor,'backupId':backup_id,'mode':data.get('mode','isolated'),'expiresAt':time.time()+600}
                    if confirmation['mode'] not in ['isolated','production']:raise ValueError('invalid restore mode')
                    write(executor.state/('confirm-'+confirmation['id']+'.json'),confirmation)
                    result={k:confirmation[k] for k in ['id','nonce','backupId','mode','expiresAt']}
                elif self.path=='/restore-confirm':
                    confirmation_id=data.get('id','')
                    if not re.match(r'^[a-f0-9]{32}$',confirmation_id):raise ValueError('invalid confirmation')
                    with executor.lock():
                        path=executor.state/('confirm-'+confirmation_id+'.json');confirmation=read(path)
                        if confirmation.get('used') or confirmation['actor']!=actor or confirmation['expiresAt']<=time.time() or not hmac.compare_digest(confirmation['nonce'],str(data.get('nonce',''))) or data.get('backupId')!=confirmation['backupId']:raise ValueError('confirmation expired')
                        confirmation['used']=True;write(path,confirmation);write(executor.state/'restore-request.json',confirmation)
                        run(['systemctl','start','--no-block','dsh-blog-backup-restore.service'])
                    result={'status':'accepted'}
                else:self.reply(404,{'error':'unknown operation'});return
                self.reply(200,result)
            except BlockingIOError:self.reply(409,{'error':'备份或恢复正在运行'})
            except Exception:self.reply(400,{'error':'操作未完成，请检查参数、备份或服务状态'})
        def reply(self,status,data):
            body=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
    HTTPServer(('127.0.0.1',executor.c['port']),Handler).serve_forever()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('action',choices=['serve','run','recover','restore','verify']);parser.add_argument('--id');args=parser.parse_args()
    executor=Executor(load_config(args.config))
    if args.action=='serve':serve(executor)
    elif args.action=='recover':
        try:
            with executor.lock():executor.recover()
        except BlockingIOError:pass
    elif args.action=='verify':executor.verify(args.id);print('verified')
    elif args.action=='run':
        with executor.lock():executor.recover();executor.perform_backup()
    elif args.action=='restore':
        with executor.lock():
            executor.recover()
            request=read(executor.state/'restore-request.json')
            if not request.get('used') or request.get('executed'):raise ValueError('invalid restore request')
            request['executed']=True;write(executor.state/'restore-request.json',request)
            write(executor.state/'current.json',{'operation':'restore','status':'running','backupId':request['backupId']})
            try:
                executor.authorize_restore(request['actor'])
                result=executor.production_restore(request['backupId'],request['actor']) if request['mode']=='production' else executor.isolate(request['backupId'])
                write(executor.state/'current.json',result);write(executor.state/'last.json',result)
            except Exception as error:
                result={'operation':'restore','status':'failed','backupId':request['backupId'],'message':'恢复未完成；已请求恢复原服务，请查看运维记录','errorType':type(error).__name__}
                write(executor.state/'current.json',result);write(executor.state/'last.json',result);raise


if __name__=='__main__':main()
