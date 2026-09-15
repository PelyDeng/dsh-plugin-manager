import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlogError, invariant, readJSON } from './settings.mjs'
import { digest } from './store.mjs'
import { normalizeSearch,searchContext,searchLocalTime } from './search.mjs'
import {normalizeReport} from './reports.mjs'

const requestSignal = signal => signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000)
export class BlogClient {
  constructor(config, transport = fetch) { this.config = config; this.fetch = transport }
  async call(action, args = {}, signal) {
    let response
    try {
      response = await this.fetch(`${this.config.url}/action/dsh-blog-bridge`, {
        method: 'POST', redirect: 'error', signal: requestSignal(signal),
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}` },
        body: JSON.stringify({ ...args, protocolVersion: 1, action }),
      })
    } catch { throw new BlogError(502, ['save','delete','manage-write'].includes(action) ? '操作结果待核对，请查询回执，勿重复执行' : '博客连接失败，请检查配置或稍后重试') }
    const data = await readJSON(response)
    if (!response.ok || data.ok !== true) {
      const messages = { 'invalid-hierarchy':'分类层级存在循环，请先修复分类父子关系再统计', 'report-too-large':'统计范围过大，请按日期、分类或标签缩小范围；未返回部分结果，不能据此报告全站总数', 'default-category':'请先将其他分类设为默认分类，再删除当前分类', conflict: '博客原文或保存草稿已变化，请重新导入比较', unauthorized: '博客账号鉴权失败', forbidden: '博客账号权限不足', invalid: '博客请求字段无效', missing: '博客文章不存在', incompatible: 'Typecho 扩展未就绪', busy: '博客正在备份或编辑，请稍后重试' }
      throw new BlogError(response.status >= 400 && response.status < 600 ? response.status : 502, messages[data.code] ?? 'Typecho 扩展请求失败')
    }
    return data.data
  }
  async report(kind,input={},signal) {
    const request=normalizeReport(kind,input)
    let result
    try { result=await this.call('report',request,signal) } catch(error) {
      if(error.status===400&&error.message==='博客请求字段无效')throw new BlogError(503,'此查询需要支持 reports=1 的 DshBlogBridge，请先更新博客桥接器；不要回退为逐页拉取后手工统计')
      throw error
    }
    invariant(result?.reportVersion===1&&result.report===kind&&result.complete===true,'博客桥接器尚不支持可靠汇总，请更新 DshBlogBridge；不要用分页结果推算总数',503)
    const saved=result.totals?.savedDraftVersions
    const savedNote=Number.isSafeInteger(saved)&&saved>=0?`本次统计计入保存稿版本 ${saved} 个。`:'本次未返回有效的 savedDraftVersions，是否计入保存稿版本无法确认，不能将缺失按 0 解释。'
    const countScopeNote=`totals 只统计当前筛选范围，articleCount 按 rootCid 去重，versionCount 是匹配的版本数。${savedNote}hasSavedDraft 和 articlesWithSavedDraft 标记文章有保存稿或独立草稿，不代表该稿件版本已计入 totals。complete=true 表示汇总计算完整，不表示已读取全部明细；明细是否还有下一页以 hasMore 为准。`
    return {...result,filters:request.filters,timeZone:request.timeZone,clock:searchContext(),countScopeNote}
  }
  async list(query = '', page = 1, signal, status = 'all') {
    invariant(typeof query === 'string' && query.length <= 200 && Number.isSafeInteger(page) && page > 0 && page <= 10000 && ['all','published','draft'].includes(status), '检索参数无效')
    const result=await this.call('list', {query,page,status,pageSize:30}, signal)
    invariant(status==='all'||result.status===status,'状态筛选需要 DshBlogBridge 0.3.1 或更新版本，请更新博客桥接扩展',503)
    return result
  }
  async get(cid, signal) { invariant(Number.isSafeInteger(cid) && cid > 0, '文章 ID 无效'); return this.call('get', { cid }, signal) }
  async search(input={},signal) {
    const {filters,timeZone,start,end}=normalizeSearch(input)
    const result=await this.call('search',{...filters,start:start===null?null:start/1000,end:end===null?null:end/1000},signal)
    // Older search bridges always paginate by 30 and omit pageSize.
    const pageSize=Object.hasOwn(result,'pageSize')?result.pageSize:30
    invariant(Number.isSafeInteger(pageSize)&&pageSize>=1&&pageSize<=100,'博客返回了无效分页大小',502)
    const items=result.items.map(item=>{const row={...item,localTime:{created:searchLocalTime(item.created*1000),modified:searchLocalTime(item.modified*1000)}};if(!item.url)return row;const url=new URL(item.url,this.config.url);invariant(['https:','http:'].includes(url.protocol),'博客返回了无效文章链接',502);return {...row,url:url.href}})
    return {...result,items,pageSize,filters:{...filters,pageSize},...(pageSize!==filters.pageSize?{pageSizeNote:`当前桥接器实际每页返回至多 ${pageSize} 条；续页使用此 pageSize，并依据 hasMore 判断是否结束。`}:{}),timeZone,clock:searchContext(),dateNote:'localTime是上海时间，其他时间戳保留原值。created是Typecho设定的文章时间，不是首次创建或首次发布的证据；modified是该版本最近修改时间。'}
  }
}

export function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png','png']
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg','jpg']
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())) return ['image/gif','gif']
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return ['image/webp','webp']
  throw new BlogError(400, '仅支持 PNG、JPEG、WebP、GIF 图片')
}
export class ImageClient {
  constructor(config, cachePath, transport = fetch) { this.config = config; this.path = cachePath; this.fetch = transport; this.refreshing = null }
  async token(refresh = false) {
    if (this.config.token) return this.config.token
    const revision = digest([this.config.url, this.config.username, this.config.password])
    if (!refresh) {
      try { const c = JSON.parse(await readFile(this.path, 'utf8')); if (c.revision === revision && c.token) return c.token } catch {}
    }
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const r = await this.fetch(`${this.config.url}/api/v1/tokens`, { method: 'POST', redirect: 'error', signal: requestSignal(), headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email: this.config.username, password: this.config.password }) })
      invariant(r.status !== 403, '图床 API 未启用，请在图床后台开启', 503)
      const data = await readJSON(r, 65536)
      invariant(r.ok && data.status === true && typeof data.data?.token === 'string', '图床登录失败，请检查配置账号密码', 502)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temp = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify({ revision, token: data.data.token }), { mode: 0o600 }); await rename(temp, this.path)
      return data.data.token
    })()
    try { return await this.refreshing } finally { this.refreshing = null }
  }
  async upload(bytes) {
    invariant(bytes.length > 0 && bytes.length <= this.config.maxBytes, '图片超过上传大小限制', 413)
    const [mime, extension] = imageType(bytes)
    for (let attempt = 0; attempt < 2; attempt++) {
      const form = new FormData(); form.set('file', new Blob([bytes], { type: mime }), `blog-${randomUUID()}.${extension}`); form.set('strategy_id', String(this.config.strategyId))
      const token = await this.token(attempt === 1)
      const r = await this.fetch(`${this.config.url}/api/v1/upload`, { method: 'POST', redirect: 'error', signal: requestSignal(), headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, body: form })
      if (r.status === 401 && !this.config.token && attempt === 0) continue
      invariant(r.status !== 403, '图床 API 未启用或当前账号无权上传', 503)
      const data = await readJSON(r, 65536)
      invariant(r.ok && data.status === true, '图床上传失败，请检查策略与账号权限', 502)
      const url = new URL(data.data?.links?.url)
      invariant(url.protocol === 'https:' && !url.username && !url.password && url.origin === new URL(this.config.url).origin, '图床返回了非预期图片地址', 502)
      return { key: data.data.key, url: url.href, mime, size: bytes.length, strategyId: this.config.strategyId }
    }
    throw new BlogError(502, '图床 Token 已失效')
  }
}

export class BackupClient {
  constructor(config, access, transport = fetch) { this.config = config; this.access = access; this.fetch = transport }
  assert(actor) { this.access.assert(actor); invariant(actor.namespace === 'user' && this.config.allowedUserIds.includes(actor.userId), '没有备份管理权限', 403) }
  async call(actor, action, input = {}) {
    this.assert(actor); invariant(this.config.url && this.config.token, '备份执行器尚未配置', 503)
    invariant(['status','run','schedule','verify','restore-prepare','restore-confirm'].includes(action), '备份操作无效')
    const r = await this.fetch(`${this.config.url}/${action}`, { method: 'POST', redirect: 'error', signal: requestSignal(), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.token}` }, body: JSON.stringify({ ...input, actor: { userId: actor.userId, sessionId: actor.sessionId } }) })
    const data = await readJSON(r, 512000); this.assert(actor)
    invariant(r.ok, '备份执行器请求失败，请查看任务记录', 502); return data
  }
}
