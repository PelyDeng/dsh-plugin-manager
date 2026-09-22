/**
 * 用户可见错误文案的单点（评审 #15：模板散落 8 处且 fallback 已漂移两种口径）。
 * 规则：Error 带非空 message 用原话（服务端原因优先），否则落 fallback。
 */
export function errorTextOf(error: unknown, fallback = '网络异常'): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}
