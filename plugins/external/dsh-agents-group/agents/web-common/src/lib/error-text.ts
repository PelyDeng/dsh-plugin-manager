/**
 * 用户可见错误文案的群组单点（自 butler web-react/src/lib/error-text.ts 原样上收；
 * QAb-P1-5 / QAd-序1：此前 blog/closedoff 各散布内联三元，fallback 口径漂移）。
 * 规则：Error 带非空 message 用原话（服务端原因优先），否则落 fallback。
 */
export function errorTextOf(error: unknown, fallback = '网络异常'): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}
