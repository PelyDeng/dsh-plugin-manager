"""Real Docker/native/filesystem restore; SQL and service lifecycle are isolated substitutes."""
import argparse
import json
import os
import pathlib
import secrets
import subprocess
import tempfile
from executor import Executor,read,write
from test_executor import fixture

DRIVER=r'''
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFile} from 'node:fs/promises'
import {native} from '/helper/chat-state.mjs'
const cfg=JSON.parse(await readFile('/fixture/ids.json','utf8')),sdk=await native(),ctx=new sdk.Context()
const cwd='/data/workspace',header=id=>({version:2,id,createdAt:1000,cwd,isSeeded:false})
const events=[{type:'turn/start',seq:0,time:1001,data:{turn:1}},{type:'turn/end',seq:1,time:1002,data:{turn:1,reason:{kind:'completed'}}}]
const feedback=note=>({session:{createdAt:1000,cwd},items:[{messageId:'fixture-answer',rating:'positive',version:cfg.version,createdAt:1100,updatedAt:1200,note}]})
const db=new DatabaseSync('/fixture/pluginData/blog.sqlite')
db.exec('CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,owner TEXT,data TEXT)')
const put=(id,owner,ready)=>{const c={id,owner,requestId:id,createdAt:900,parent:null,ready,...(ready?{sessionCreatedAt:1000}:{})};db.prepare('INSERT OR REPLACE INTO conversations VALUES(?,?,?)').run(id,owner,JSON.stringify(c))}
await ctx.plugin(sdk.persistence.default,{root:'/fixture/sessions',compression:'zstd'})
await ctx.plugin(sdk.storage.default);await ctx.plugin(sdk.json,{root:'/fixture/storage'});await ctx.plugin(sdk.domain,{backend:'json'})
const domain=await ctx.storageDomain.open(sdk.feedback.messageFeedbackDomainSpec),table=domain.table('sessions')
const log=async id=>{const h=await ctx.sessionPersistence.create(header(id));try{await h.append(events);await h.flush()}finally{await h.close()}}
try{
  if(process.argv[2]==='init'){
    put(cfg.a,'auth:a',true);put(cfg.b,'auth:b',true);put(cfg.pending,'auth:a',false)
    await log(cfg.a);await log(cfg.b);await log(cfg.other)
    await table.put(cfg.a,feedback('backup'));await table.put(cfg.other,feedback('other plugin before backup'))
  }else if(process.argv[2]==='mutate'){
    put(cfg.pending,'auth:a',true);put(cfg.later,'auth:b',true)
    await log(cfg.pending);await log(cfg.later)
    await table.put(cfg.a,feedback('current'));await table.put(cfg.b,feedback('new feedback'))
    await table.put(cfg.pending,feedback('pending became active'));await table.put(cfg.later,feedback('created later'))
    await table.put(cfg.other,feedback('KEEP CURRENT OTHER PLUGIN'))
  }else{
    const restored=process.argv[2]==='restored'
    assert.equal(table.get(cfg.a).items[0].note,restored?'backup':'current')
    assert.equal(table.get(cfg.a).items[0].version,cfg.version)
    assert.equal(table.get(cfg.other).items[0].note,'KEEP CURRENT OTHER PLUGIN')
    assert.equal(!!table.get(cfg.b),!restored);assert.equal(!!table.get(cfg.pending),!restored)
    assert.equal(!!await ctx.sessionPersistence.stat(cfg.pending),!restored)
    assert.equal(!!await ctx.sessionPersistence.stat(cfg.later),!restored)
    assert.equal(!!db.prepare('SELECT id FROM conversations WHERE id=?').get(cfg.later),!restored)
    assert.equal(JSON.parse(db.prepare('SELECT data FROM conversations WHERE id=?').get(cfg.pending).data).ready,!restored)
    // Retained old directories must not become duplicate official sessions during global listing.
    const listed=await ctx.sessionPersistence.list();assert.equal(listed.length,restored?3:5)
    const h=await ctx.sessionPersistence.open(cfg.a,'read');try{assert.deepEqual(await h.read(),events)}finally{await h.close()}
  }
}finally{db.close();await ctx.fiber.dispose()}
'''


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--image',required=True);args=parser.parse_args()
    if not __import__('re').match(r'^sha256:[a-f0-9]{64}$',args.image):raise ValueError('immutable runtime image required')
    helper=pathlib.Path(__file__).resolve().parent/'chat-state.mjs'
    name='blog-backup-fixture-'+secrets.token_hex(8)
    subprocess.check_call(['docker','create','--name',name,'--entrypoint','true',args.image],stdout=subprocess.DEVNULL)
    try:
        with tempfile.TemporaryDirectory(prefix='blog-chat-integration-') as directory:
            root=pathlib.Path(directory);e=fixture(root)
            e.c.update(dshContainer=name,phpUnit='fixture-php')
            e.c['chat']={'sessionRoot':str(root/'sessions'),'storageRoot':str(root/'storage'),'cwd':'/data/workspace'}
            for part in ['sessions','storage']:(root/part).mkdir()
            os.chown(str(root/'sessions'),1000,1000);os.chown(str(root/'storage'),1000,1000)
            write(e.c['pluginConfig'],{'blog':{'origin':'https://fixture.invalid'},'backup':{}})
            e.authorize_restore=lambda actor:None
            e.restore_images=lambda current,restored:None
            e.recover=lambda:Executor.recover(e)
            import uuid
            ids={key:'blog-chat-'+str(uuid.uuid4()) for key in ['a','b','pending','later']}
            ids.update(other='example-'+str(uuid.uuid4()),version=str(uuid.uuid4()));write(root/'ids.json',ids)
            (root/'driver.mjs').write_text(DRIVER,encoding='utf-8')
            def driver(mode):
                subprocess.check_call(['docker','run','--rm','--user','0:0','--network','none','--entrypoint','node',
                    '--mount','type=bind,src='+str(root)+',dst=/fixture',
                    '--mount','type=bind,src='+str(helper)+',dst=/helper/chat-state.mjs,readonly',args.image,'/fixture/driver.mjs',mode])
            driver('init')
            # Only unrelated MinIO image metadata lookup is substituted; helper Docker calls are real.
            from executor import run as real_run
            from unittest.mock import patch
            def command(command,**kwargs):
                if command[:3]==['docker','inspect','fixture-minio']:return b'fixture-minio-image'
                return real_run(command,**kwargs)
            with patch('executor.run',side_effect=command):
                baseline=e.perform_backup(rotate=False)
                assert e.verify(baseline)['chatSessions']==3
                driver('mutate');driver('current')
                feedback_before=(root/'storage/message_feedback.json').read_bytes()
                def fail(swaps):
                    Executor.apply_swaps(e,swaps)
                    raise RuntimeError('injected after all live swaps including feedback')
                e.apply_swaps=fail
                try:e.production_restore(baseline,{})
                except RuntimeError as error:assert 'injected after' in str(error)
                else:raise AssertionError('fault injection did not run')
                assert read(e.state/'restore-journal.json')['rolledBack']
                assert (root/'storage/message_feedback.json').read_bytes()==feedback_before
                driver('current')
                e.apply_swaps=lambda swaps:Executor.apply_swaps(e,swaps)
                result=e.production_restore(baseline,{})
                assert result['status']=='succeeded'
                driver('restored')
                assert (root/'storage/message_feedback.json').stat().st_uid==1000
                for folder in (root/'sessions').iterdir():
                    if folder.name=='.blog-restore':continue
                    for session in folder.iterdir():
                        if session.name in [ids['a'],ids['b']]:assert session.stat().st_uid==1000
                        if session.name==ids['other']:assert session.stat().st_uid==0
                print(json.dumps({'status':'passed','checks':['real stopped-image helper','chat archive and isolated native import','two owners','empty conversation rollback','other plugin feedback retained','global native session listing','failure after all swaps rolls back logs sqlite and feedback','restored service file ownership'],'sql':'substituted','productionServices':'untouched'}))
    finally:subprocess.check_call(['docker','rm',name],stdout=subprocess.DEVNULL)


if __name__=='__main__':main()
