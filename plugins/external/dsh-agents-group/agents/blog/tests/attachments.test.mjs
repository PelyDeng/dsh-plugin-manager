import test from 'node:test'
import assert from 'node:assert/strict'
import { BlogStore } from '../src/store.mjs'
import { BlogAttachments } from '../src/attachments.mjs'
import { parseDocument } from '../runtime/parse-document.mjs'
import { pdf,docx,zipStored } from './document-fixtures.mjs'

const actor={namespace:'test',userId:'one',sessionId:'one'},other={...actor,userId:'two'}
async function fixture(t,provider={}) {
  const store=new BlogStore(':memory:');await store.init()
  const draft=await store.create('test:one'),files=new Map(),cleanups=[]
  let authorized=true
  const access={assert(a){assert.equal(authorized,true);assert.ok(a?.sessionId)}}
  const attachments={async saveFileStream({data,name}){const b=[];for await(const c of data)b.push(c);files.set(name,Buffer.concat(b));return {attachmentId:name,name,bytes:files.get(name).length}},async *readFileStream(ref){yield files.get(ref.name)},...provider}
  const ctx={effect(f){cleanups.push(f())},on(){return()=>{}},get(){return attachments},attachments}
  const service=new BlogAttachments(ctx,access,store)
  t.after(async()=>{await service.close();for(const f of cleanups)await f?.();store.close()})
  return {service,store,draft,files,revoke(){authorized=false}}
}
test('raw UTF-8 file is stored verbatim; extracted text is frozen with owner/version/range',async t=>{
  const {service,draft,files}=await fixture(t),bytes=Buffer.from('唯一标记: 橙海-739\n第二行\n第三行')
  const a=await service.upload(actor,draft.id,'资料.md',async()=>bytes)
  assert.equal(a.status,'ready');assert.equal(a.parsedUnits,3);assert.deepEqual(files.get('资料.md'),bytes)
  assert.equal(a.original,undefined)
  const frozen=await service.freeze(actor,draft.id,[{id:a.id,version:1,range:{from:1,to:2}}])
  assert.match(frozen[0].units[0].text,/橙海-739/);assert.equal(frozen[0].units.length,2)
  await assert.rejects(service.freeze(actor,draft.id,[{id:a.id,version:2}]),/版本/)
  await assert.rejects(service.content(other,draft.id,a.id),/无权/)
  await assert.rejects(service.original(other,draft.id,a.id),/无权/)
  await service.remove(actor,draft.id,a.id)
  await assert.rejects(service.freeze(actor,draft.id,[{id:a.id,version:1}]),/移除/)
  assert.match(frozen[0].units[0].text,/橙海-739/)
})
test('cancelled image normalization cannot resurrect removed metadata',async t=>{
  let release,entered
  const waiting=new Promise(r=>{entered=r})
  const {service,draft}=await fixture(t,{async saveImage(){entered();return new Promise(r=>{release=r})}})
  const pending=service.upload(actor,draft.id,'x.png',async()=>Buffer.from('image'))
  await waiting
  const a=(await service.list(actor,draft.id))[0];await service.remove(actor,draft.id,a.id)
  release({attachmentId:'normalized'})
  await assert.rejects(pending)
  assert.equal((await service.list(actor,draft.id)).length,0)
})
test('failed formats and expansion/context limits are explicit',async t=>{
  const {service,draft}=await fixture(t)
  await assert.rejects(service.upload(actor,draft.id,'bad.exe',async()=>Buffer.from('x')),/支持/)
  await assert.rejects(parseDocument(Buffer.from('fake pdf'),'pdf'),/不是 PDF/)
  await assert.rejects(parseDocument(Buffer.from([255,0]),'text'),/UTF-8/)
  await assert.rejects(parseDocument(Buffer.from('{broken'),'json'),/JSON/)
  const a=await service.upload(actor,draft.id,'long.txt',async()=>Buffer.from(('x'.repeat(1000)+'\n').repeat(250)))
  assert.equal(a.partial,true);assert.equal(a.selected,false)
  await assert.rejects(service.freeze(actor,draft.id,[{id:a.id,version:1}]),/明确选择/)
  await assert.rejects(service.freeze(actor,draft.id,[{id:a.id,version:1,range:{from:1,to:150}}]),/100000/)
  assert.equal((await service.freeze(actor,draft.id,[{id:a.id,version:1,range:{from:1,to:10}}]))[0].units.length,10)
})
test('real PDF and DOCX text including table content is extracted in workers',async t=>{
  const {service,draft}=await fixture(t)
  for(const [name,bytes,marker] of [['source.pdf',pdf(),'PDF-MARKER-739'],['source.docx',docx(),'DOCX-MARKER-281']]) {
    const a=await service.upload(actor,draft.id,name,async()=>bytes)
    assert.equal(a.status,'ready')
    const content=await service.content(actor,draft.id,a.id)
    assert.ok(content.units.map(u=>u.text).join('\n').includes(marker));if(name.endsWith('docx'))assert.match(content.units.map(u=>u.text).join('\n'),/表格答案：42/)
  }
  await assert.rejects(parseDocument(pdf(''),'pdf'),/OCR/)
  await assert.rejects(parseDocument(zipStored({'word/document.xml':'x','word/vbaProject.bin':'x'}),'docx'),/宏/)
})
