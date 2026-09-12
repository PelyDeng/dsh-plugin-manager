/**
 * 群组内的 Agent 清单。
 *
 * 这是一份**静态清单**，不是运行时扫描目录：构建产物要可树摇、类型要可检查、
 * 装载顺序要确定，动态扫描在打包后不可靠。
 *
 * 新增一个 Agent 只需要在这里加一条 —— 这是群组唯一的「名单」，
 * 管家（dsh-butler-console）那边不用改。
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
}

/**
 * 当前群组内的 Agent。
 *
 * P0 阶段为空：骨架先证明「空群组能装上、探针可用、切回旧插件可回滚」，
 * 业务迁移在 P1/P2 逐步加进来。
 */
export const AGENT_MANIFESTS: readonly AgentManifest[] = []

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
}

export function endpointsOf(manifest: AgentManifest, routePrefix: string): AgentEndpoints {
  return {
    id: manifest.id,
    entryPath: `${routePrefix}/${manifest.id}`,
    healthPath: `${routePrefix}/${manifest.id}/ready`,
    permission: `${manifest.id}:access`,
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
