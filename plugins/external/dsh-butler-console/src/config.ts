import Schema from '@deepseek-ai/schemastery'

/** 牛马大总管的部署配置。字段名与 `cordis.patch.yml`、管理器生成的 patch 保持一致。 */
export interface Config {
  accessMode: 'standalone' | 'authenticated'
  publicOrigin: string
  authRecheckMs: number
  reasoningEffort: string
  routePrefix: string
  /** 单个子任务的最长执行时间，超时按失败处理并中止子 Agent。 */
  subtaskTimeoutMs: number
  /**
   * 等用户回话的最长时间。
   *
   * 没人回话的等待不能永远挂着：它一直占着「等你回话」的计数，也一直占着那位成员，
   * 而用户下次进来看到的是一条不知道自己还要不要回的任务。到点按超时收尾，材料保留，
   * 重新描述目标就能继续。默认 10 分钟，与游戏侧 `butler_timeouts.awaiting_ms` 对齐。
   */
  waitingTimeoutMs: number
  /** 一次牛马大总管回答的最长时间。 */
  turnTimeoutMs: number
  /** 单条用户消息字符数上限。 */
  maxMessageChars: number
  /** 单个子任务摘要写回页面的字符数上限。 */
  maxResultChars: number
  /** 一次计划里允许的子任务数量上限。 */
  maxSubtasks: number
  /** 请求体上限。 */
  maxRequestBodyBytes: number
  /** 成员头像大小上限。 */
  maxAvatarBytes: number
  /** 单个附件大小上限。 */
  maxAttachmentBytes: number
  /** 一条消息最多带几个附件（也是"待发附件"最多攒几个：攒了发不出去没有意义）。 */
  maxAttachmentsPerMessage: number
  /** 一次解析最多收多少字符（落库的那一份）。 */
  attachmentParseChars: number
  /** 附件正文进提示词与派单简报时的字符上限（总预算，按文件数分摊）。 */
  attachmentBriefChars: number
  /**
   * 读图用哪条模型路由，写成 `provider/model`。
   *
   * 留空表示**自动挑**：在官方模型目录里找第一个声明支持图片的模型。挑不到就是这个部署读不了
   * 图——页面会如实说明，而不是把图片当成没有内容。
   */
  visionModel: string
  /** 抓取 URL 的超时。对方不响应时不能让一个上传请求挂在那里。 */
  attachmentFetchTimeoutMs: number
  /** goal 充实中继轮的预算。超时回落原目标，不阻塞派单。 */
  goalRelayTimeoutMs: number
  /** 同时保留的牛马大总管会话数。 */
  maxActiveConversations: number
  /** 运行历史每页条数上限。 */
  maxHistoryPageSize: number
  /** 任务记录侧栏每页条数（0.12.4 管理分页）。 */
  conversationsPageSize: number
  /**
   * 每个会话最多保留的事件条数。
   *
   * 事件日志是「关掉页面再打开还能接上」和「两个入口同时观察同一轮」的依据，所以它必须
   * 活到一轮结束之后。逐字增量很密（一次长回答可能上千条），窗口太小会让晚来的观察者
   * 频繁收到「请重取快照」，太大则白白占内存。
   */
  maxConversationEvents: number
  /**
   * 写请求的幂等记录保留多久。
   *
   * 挡的是网络重试和连点两次这类秒级重复，所以按时间清理就够。记录与任务同库落盘
   * （`butler_requests` 表），进程重启后仍能识别同一次提交。
   */
  idempotencyTtlMs: number
}

/** Cordis 配置 schema。默认值与设计文档第 2 节的能力范围一致。 */
export const Config: Schema<Config> = Schema.object({
  accessMode: Schema.union(['standalone', 'authenticated']).default('authenticated'),
  publicOrigin: Schema.string().default(''),
  authRecheckMs: Schema.natural().min(100).max(30000).default(1000),
  reasoningEffort: Schema.string().pattern(/^(?:off|low|high|max)$/).default('low'),
  routePrefix: Schema.string().pattern(/^\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/).default('/butler'),
  subtaskTimeoutMs: Schema.natural().min(1000).max(1800000).default(300000),
  waitingTimeoutMs: Schema.natural().min(60000).max(86400000).default(600000),
  turnTimeoutMs: Schema.natural().min(1000).max(3600000).default(600000),
  maxMessageChars: Schema.natural().min(1).max(32000).default(8000),
  maxResultChars: Schema.natural().min(100).max(64000).default(8000),
  maxSubtasks: Schema.natural().min(1).max(20).default(6),
  maxRequestBodyBytes: Schema.natural().min(1024).max(1048576).default(65536),
  maxAvatarBytes: Schema.natural().min(4096).max(2097152).default(262144),
  maxAttachmentBytes: Schema.natural().min(4096).max(67108864).default(16777216),
  maxAttachmentsPerMessage: Schema.natural().min(1).max(20).default(5),
  attachmentParseChars: Schema.natural().min(1000).max(1000000).default(120000),
  attachmentBriefChars: Schema.natural().min(200).max(200000).default(20000),
  // 空串是合法取值（表示自动挑），所以这里不加 pattern：加了会把默认值本身判成非法。
  visionModel: Schema.string().default(''),
  attachmentFetchTimeoutMs: Schema.natural().min(1000).max(120000).default(15000),
  goalRelayTimeoutMs: Schema.natural().min(5000).max(120000).default(45000),
  maxActiveConversations: Schema.natural().min(1).max(500).default(32),
  maxHistoryPageSize: Schema.natural().min(1).max(100).default(30),
  conversationsPageSize: Schema.natural().min(5).max(50).default(10),
  maxConversationEvents: Schema.natural().min(50).max(20000).default(2000),
  idempotencyTtlMs: Schema.natural().min(1000).max(86400000).default(600000),
})
