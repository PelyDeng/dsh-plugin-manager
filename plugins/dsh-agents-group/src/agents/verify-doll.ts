/**
 * 验收娃娃在群组里的适配层。
 *
 * 与 closedoff/blog 的适配层同构：补公共字段、接出释放函数。它是接入路径的活样例
 * （方案 G06），新成员照这里的最小形态接，缺环会在验收测试里红。
 */

import { mount } from '../../agents/verify-doll/src/index.ts'
import type { AgentMount } from '../host.ts'
import { endpointsOf } from './registry.ts'

export const mountVerifyDoll: AgentMount = async context => {
  const entryPath = endpointsOf(context.manifest, context.config.routePrefix, context.config.accessMode).entryPath
  const instance = await mount({ ctx: context.ctx, access: context.access, routePrefix: entryPath })
  return { tools: instance.tools, participant: instance.participant, dispose: instance.dispose }
}
