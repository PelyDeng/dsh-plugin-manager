/**
 * huiyu 主题契约段——本文件由 scripts/generate-contract.mjs 从
 * agents/web-common/styles/tokens.css 的 :root 段机械生成，**勿手改**。
 * 改 token 后重跑生成（群组 check 的 --check 断言会拦住漂移）。
 *
 * 生成规则：--bt-* 变量 + color-scheme: light；排除 url() 形态声明
 * （--bt-ink-frame，SSR 页不消费）——生成段零 url() 引用，断网可读。
 */
/** 原样内插进 page.ts `<style>` 的 :root 契约段（每行一条声明，含分号）。 */
export const CONTRACT_ROOT_CSS = `
  --bt-paper: #f6efdd;
  --bt-card: #ffffff;
  --bt-ink: #2f2b26;
  --bt-ink-soft: #7d7468;
  --bt-ink-faint: #a89f92;
  --bt-line: #ddd2bc;
  --bt-stroke: #2f2b26;
  --bt-red: #d2493f;
  --bt-coral: #ff6b57;
  --bt-amber: #ffb703;
  --bt-mint: #2ec4a6;
  --bt-sky: #4d96ff;
  --bt-grape: #9b5de5;
  --bt-ok: #1f9d6b;
  --bt-warn: #d98324;
  --bt-error: #d94f4f;
  --bt-warn-bg: #fdf3e0;
  --bt-error-bg: #fdeceb;
  --bt-ok-bg: #e8f6ef;
  --bt-font: "LXGW WenKai", "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  --bt-ui-font: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  --bt-hand: "Ma Shan Zheng", "Segoe Print", "Comic Sans MS", "KaiTi", "STKaiti", "Kaiti SC", "DFKai-SB", "BiauKai", cursive;
  --bt-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --bt-wobble: 14px 12px 15px 11px / 12px 15px 11px 14px;
  --bt-wobble-sm: 9px 7px 10px 8px / 8px 10px 7px 9px;
  color-scheme: light;
`
