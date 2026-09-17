import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { BlogStore } from '../src/store.ts'
import { BlogAttachments } from '../src/attachments.ts'
import { parseDocument } from '../runtime/parse-document.mjs'
import { pdf,docx,zipStored } from './document-fixtures.ts'

const actor={namespace:'test',userId:'one',sessionId:'one'},other={...actor,userId:'two'}

/**
 * 假宿主的附件服务面（`ctx.attachments`）：本夹具真的会跑到的两个方法。
 *
 * `saveImage` 只有在用例自己用 `provider` 覆盖时才出现（`{async saveImage(){…}}`），
 * 所以并入之后按 `Partial` 声明——不用 `Record<string, any>`：这个袋子按字段取值，
 * 而"多出来一个未声明的面"在真实现里就是 `undefined`（调用点会报 `is not a function`）。
 */
interface AttachmentProvider {
  saveFileStream(input: { data: AsyncIterable<Uint8Array>; name: string }): Promise<{ attachmentId: string; name: string; bytes: number }>
  readFileStream(ref: { name: string }): AsyncGenerator<Uint8Array>
  saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<{ attachmentId: string }>
}

/**
 * 读回原文件：夹具只放得进**已经上传过**的那一个，取不到就是**用例缺陷**
 * ⇒ 如实抛（而不是静默 `yield undefined`：那会让"读不到原文件"看起来像"读到了空内容"）。
 */
async function* readFixtureFile(files: Map<string, Buffer>, name: string): AsyncGenerator<Uint8Array> {
  const bytes = files.get(name)
  if (bytes === undefined) throw new Error(`夹具里没有名为 ${name} 的原文件`)
  yield bytes
}

/** 夹具用的身份字面量（`namespace` 是夹具自己的口径，与 `OwnerActor` 的开放索引一致）。 */
interface FixtureActor { namespace: string; userId: string; sessionId: string }

/** `BlogAttachments.freeze()` 交回的冻结单元（`public()`/`freeze()` 拼出来的那一层）。 */
interface FrozenUnit { text: string }
interface FrozenAttachment { units: FrozenUnit[] }

/** `freeze()` 一次选择：资料 id + 版本，可选已解析范围。 */
interface FrozenSelection { id: string; version: number; range?: { from: number; to: number } }

/**
 * 附件服务在本文件用到的面。
 *
 * ⚠️ 这一层是**类型边界**，不是替身：`BlogAttachments` 的 `src` 侧还没补齐参数声明
 * （`freeze(selections=[])` 被推成 `never[]`，`content()` 的返回是 `any`），而用例要按
 * **字段**读它们（`a.status` / `frozen[0].units`）。接口只声明本文件真正读到的字段，
 * 而不是 `Record<string, any>` —— 袋子一旦开放，"写错字段名"就再也不会报错。
 */
interface FrozenContent { units: FrozenUnit[] }
interface PublicAttachment { id: string; status: string; parsedUnits?: number; partial?: boolean; selected?: boolean; original?: unknown }
interface AttachmentsService {
  upload(actor: FixtureActor, draftId: string, name: string, read: (signal?: AbortSignal) => Promise<Buffer>): Promise<PublicAttachment>
  freeze(actor: FixtureActor, draftId: string, selections?: FrozenSelection[]): Promise<FrozenAttachment[]>
  list(actor: FixtureActor, draftId: string): Promise<PublicAttachment[]>
  remove(actor: FixtureActor, draftId: string, id: string): Promise<unknown>
  content(actor: FixtureActor, draftId: string, id: string): Promise<FrozenContent>
  original(actor: FixtureActor, draftId: string, id: string): Promise<unknown>
  close(): Promise<void>
}

/** 构造出的服务按上面那份面读（见 `AttachmentsService` 的说明：这一处是**夹具边界**）。 */
const attachmentsService = (service: unknown): AttachmentsService => service as AttachmentsService

async function fixture(t: TestContext,provider: Partial<AttachmentProvider>={}) {
  const store=new BlogStore(':memory:');await store.init()
  const draft=await store.create('test:one'),files=new Map<string,Buffer>(),cleanups:(() => unknown)[]=[]
  let authorized=true
  const access={assert(a:FixtureActor){assert.equal(authorized,true);assert.ok(a?.sessionId)}}
  const attachments={async saveFileStream({data,name}:{data:AsyncIterable<Uint8Array>;name:string}){const b:Uint8Array[]=[];for await(const c of data)b.push(c);files.set(name,Buffer.concat(b));return {attachmentId:name,name,bytes:files.get(name)?.length??0}},readFileStream(ref:{name:string}){return readFixtureFile(files,ref.name)},...provider}
  const ctx={effect(f:() => unknown){cleanups.push(f)},on(){return()=>{}},get(){return attachments},attachments}
  const service=attachmentsService(new BlogAttachments(ctx,access,store))
  t.after(async()=>{await service.close();for(const f of cleanups)await f?.();store.close()})
  return {service,store,draft,files,revoke(){authorized=false}}
}
test('raw UTF-8 file is stored verbatim; extracted text is frozen with owner/version/range',async t=>{
  const {service,draft,files}=await fixture(t),bytes=Buffer.from('唯一标记: 橙海-739\n第二行\n第三行')
  const a=await service.upload(actor,draft.id,'资料.md',async()=>bytes)
  assert.equal(a.status,'ready');assert.equal(a.parsedUnits,3);assert.deepEqual(files.get('资料.md'),bytes)
  assert.equal(a.original,undefined)
  const frozen=await service.freeze(actor,draft.id,[{id:a.id,version:1,range:{from:1,to:2}}])
  assert.match(frozen[0]!.units[0]!.text,/橙海-739/);assert.equal(frozen[0]!.units.length,2)
  await assert.rejects(service.freeze(actor,draft.id,[{id:a.id,version:2}]),/版本/)
  await assert.rejects(service.content(other,draft.id,a.id),/无权/)
  await assert.rejects(service.original(other,draft.id,a.id),/无权/)
  await service.remove(actor,draft.id,a.id)
  await assert.rejects(service.freeze(actor,draft.id,[{id:a.id,version:1}]),/移除/)
  assert.match(frozen[0]!.units[0]!.text,/橙海-739/)
})
test('cancelled image normalization cannot resurrect removed metadata',async t=>{
  let release:((value:{attachmentId:string}) => void)|undefined,entered:(() => void)|undefined
  const waiting=new Promise<void>(r=>{entered=r})
  const {service,draft}=await fixture(t,{async saveImage(){entered?.();return new Promise(r=>{release=r})}})
  const pending=service.upload(actor,draft.id,'x.png',async()=>Buffer.from('image'))
  await waiting
  const a=(await service.list(actor,draft.id))[0]!;await service.remove(actor,draft.id,a.id)
  release?.({attachmentId:'normalized'})
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
  assert.equal((await service.freeze(actor,draft.id,[{id:a.id,version:1,range:{from:1,to:10}}]))[0]!.units.length,10)
})
test('real PDF and DOCX text including table content is extracted in workers',async t=>{
  const {service,draft}=await fixture(t)
  const inputs:[name:string,bytes:Buffer,marker:string][]=[['source.pdf',pdf(),'PDF-MARKER-739'],['source.docx',docx(),'DOCX-MARKER-281']]
  for(const [name,bytes,marker] of inputs) {
    const a=await service.upload(actor,draft.id,name,async()=>bytes)
    assert.equal(a.status,'ready')
    const content=await service.content(actor,draft.id,a.id)
    assert.ok(content.units.map(u=>u.text).join('\n').includes(marker));if(name.endsWith('docx'))assert.match(content.units.map(u=>u.text).join('\n'),/表格答案：42/)
  }
  await assert.rejects(parseDocument(pdf(''),'pdf'),/OCR/)
  await assert.rejects(parseDocument(zipStored({'word/document.xml':'x','word/vbaProject.bin':'x'}),'docx'),/宏/)
})
