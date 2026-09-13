/**
 * 把两类高频、但报错本身看不出原因的失败，翻译成「该怎么办」。
 *
 * 这两类都在真实开发里撞到过，而且原始报错都把原因指向了错的地方：
 *
 * 1. `TS2717 Subsequent property declarations must have the same type`：同一个包被**两条路径**
 *    解析（例如 `packages/plugin-kit` 与某个插件自己的 `node_modules/@dsh-plugin-manager/plugin-kit`
 *    符号链接），于是同一份 `declare module '@deepseek-ai/cordis'` 被加载两次。两个类型看起来
 *    完全一样，报错不会说是重复加载造成的。
 * 2. `MISSING_EXPORT: "X" is not exported by "…/index.d.ts"`：打包器按包名找声明文件，
 *    源码型内部包（只提供 `src`、不产出 `.d.ts`）找不到时，会把「没有这个导出」当成事实。
 *
 * 这里只做识别与提示，不改判定：失败仍然是失败，退出码与输出都原样保留。
 */

/** 报错片段 → 提示。顺序即匹配顺序，先命中先返回。 */
const RULES = [
  {
    test: text => /TS2717|Subsequent property declarations must have the same type/u.test(text),
    hint: [
      '这是「同一个包被两条路径解析」的典型症状：TypeScript 按解析到的路径区分模块身份，',
      '同一条 `declare module \'@deepseek-ai/cordis\'` 被加载两次就会报 TS2717，而两个类型看起来一模一样。',
      '怎么办：确认这些事件通道只在 kit 的 `src/events.ts` 里声明一次，别在别的文件里重复写；',
      '需要新通道时加到那里并 import 它。用 `pnpm why <包名>` 或看报错里的两个路径，确认是不是同一个实体被解析了两次。',
    ],
  },
  {
    test: text => /MISSING_EXPORT/u.test(text),
    hint: [
      '这是「源码型内部包没有声明文件」的典型症状：打包器按包名找 `index.d.ts`，找不到就把',
      '「没有这个导出」当成事实，于是报 MISSING_EXPORT。',
      '怎么办：类型导入改走源码相对路径（例如 `../packages/common/src/participant.ts`），',
      '或者让这个内部包像 kit 一样产出声明文件、在 package.json 里声明 `types`。',
    ],
  },
];

/** 从失败输出里给出可执行的下一步；没有命中已知形态时返回 `null`。 */
export function diagnoseToolFailure(output) {
  const text = String(output ?? '');
  if (!text.trim()) return null;
  for (const rule of RULES) if (rule.test(text)) return rule.hint.join('\n');
  return null;
}

/** 失败时把捕获到的输出与提示一起写出；没有提示时保持原样。 */
export function reportToolFailure(id, captured) {
  replay(captured);
  const hint = diagnoseToolFailure(`${captured?.stdout ?? ''}\n${captured?.stderr ?? ''}`);
  if (hint) process.stderr.write(`[${id}] 已知问题提示：\n${hint.split('\n').map(line => `[${id}] ${line}`).join('\n')}\n`);
  return hint;
}

function replay({ stdout = '', stderr = '' } = {}) {
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
}
