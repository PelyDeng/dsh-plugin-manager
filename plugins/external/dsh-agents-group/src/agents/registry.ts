/**
 * 群组内的 Agent 清单。
 *
 * 这是一份**静态清单**，不是运行时扫描目录：构建产物要可树摇、类型要可检查、
 * 装载顺序要确定，动态扫描在打包后不可靠。
 *
 * 新增一个 Agent：这里加一条清单，**还要**在 `src/index.ts` 的 `loadAgent` 与
 * `errorHandlerOf` 两个 switch 各加一个 case（漏加 loadAgent 时成员会静默缺席——
 * 条目在、页面在，就是永远不被装载）。牛马大总管（dsh-butler-console）那边不用改。
 */

/** 一个 Agent 的静态身份。路径与权限由 id 推导，避免手写不一致。 */
export interface AgentManifest {
  /** 运行时目录 id。同时是授权标识、会话管理 key、子包目录名。 */
  readonly id: string
  /** 认证页面与列表里的显示名。 */
  readonly displayName: string
  /** 该 Agent 所属子包的目录名。通常等于 id。 */
  readonly directory: string
  /** 工具分类标签，用于认证页面按 Agent 分组展示。 */
  readonly category: string
  /** 一句话自述。 */
  readonly description: string
  /**
   * 该 Agent 是否强制要求认证。
   *
   * 有些 Agent 的业务前提就是「必须有可信身份」（例如博客要按用户隔离草稿与附件）。
   * 这类 Agent 在群组跑 standalone 时不是「装载失败」，而是「按设计不可用」：页面会
   * 明确报认证不可用，而不是被误判成崩溃。
   */
  readonly requiresAuthentication?: boolean
  /**
   * 仅用于验收的成员：默认不装载，部署配置显式 `agents.<id>.enabled = true` 才进入
   * 运行环境。随包名单里不带这类成员——接入期的临时替身做完验收就该留在测试里，
   * 不该出现在普通站点的成员名单上。
   */
  readonly verificationOnly?: true
}

/**
 * 当前群组内的 Agent。
 *
 * 每迁入一个 Agent 就在这里加一条 —— 这是群组唯一的名单，牛马大总管侧不用改。
 */
export const AGENT_MANIFESTS: readonly AgentManifest[] = [
  {
    id: 'closedoff',
    displayName: '封闭化管理智能助手',
    directory: 'closedoff',
    category: '封闭化园区',
    description: '园区封闭化业务查询、车辆轨迹与设备数据分析',
  },
  {
    id: 'blog',
    displayName: '博客智能体',
    directory: 'blog',
    category: '博客工作台',
    description: '博客写作、发布、图床与备份',
    // 博客按用户隔离草稿、附件与备份，业务前提是必须有可信身份。
    requiresAuthentication: true,
  },
  {
    id: 'huiyu',
    displayName: '绘语（图片智能体）',
    directory: 'huiyu',
    category: '图片与视觉',
    description: '图片理解与生成：看懂图片内容，也能按描述生成图片',
    // 生成图落 MinIO、业务记录按归属隔离，前提同样是必须有可信身份。
    requiresAuthentication: true,
  },
]

/**
 * 由清单推导出的运行时标识。
 *
 * id、页面路径、权限标识三者必须一致，否则会出现「授权了但页面进不去」
 * 或「会话管理找不到 provider」这类难查的问题。所以三者统一在这里推导，
 * 不允许各处手写。
 */
export interface AgentEndpoints {
  readonly id: string
  readonly entryPath: string
  readonly healthPath: string
  readonly permission: string
  /** 该 Agent 需要的访问模式：强制认证的 Agent 永远是 authenticated。 */
  readonly accessMode: 'standalone' | 'authenticated'
}

export function endpointsOf(
  manifest: AgentManifest,
  routePrefix: string,
  groupAccessMode: 'standalone' | 'authenticated' = 'authenticated',
): AgentEndpoints {
  return {
    id: manifest.id,
    entryPath: `${routePrefix}/${manifest.id}`,
    healthPath: `${routePrefix}/${manifest.id}/ready`,
    permission: `${manifest.id}:access`,
    accessMode: manifest.requiresAuthentication === true ? 'authenticated' : groupAccessMode,
  }
}

/** 校验清单本身没有重复 id；重复会让目录登记直接抛错，提前拦下来更清楚。 */
export function assertUniqueManifests(manifests: readonly AgentManifest[]): void {
  const seen = new Set<string>()
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) throw new Error(`Agent id 重复：${manifest.id}`)
    seen.add(manifest.id)
  }
}
