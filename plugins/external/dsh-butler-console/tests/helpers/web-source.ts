/**
 * web 前端源码拼接源（设计 v2 §2.3）：源码断言型测试的统一读取口。
 *
 * 为什么需要它：page-*.test.ts 有一类测试从 web/app.js 源码文本里用正则抽函数体进沙盒
 * （pick），拆分（批 1）后函数搬进 `web/modules/*.js`，逐测试改 readFileSync 目标会漏
 * （「不存在某标识」的断言漏改不报红、**静默失去保护**）。统一从这里拿「入口 + 全部模块」
 * 的拼接全文，测试侧零改动地跟随拆分；新增模块只需在 MODULES 清单登记一行。
 *
 * 规则（与拆分设计同步演进，改动前读 doc/arch-refactor 设计 v2）：
 * - 顺序 = 入口 app.js 全文在前，各域模块按**首函数在原 app.js 中的行号**升序拼接；
 *   同模块内部保持原相对顺序与相邻关系（相邻切片断言依赖它）。
 * - 统一 LF 归一（与各测试原有的 `.replace(/\r\n/g, '\n')` 同一口径）。
 * - 清单文件缺失 fail-fast 报文件名：防「模块删了清单还在」（ENOENT 崩全部）与
 *   「清单漏读」（not-contains 断言静默变弱）两类事故。
 * - **拆分提交纪律**：模块文件、本清单、package.json check 脚本行、verifyFiles 结论四者
 *   同一提交。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 域模块清单（批 1 按落位登记；顺序 = 首函数在原 app.js 的行号升序）。
 * 批 0（尚未拆分）为空——webSource() 此时就是 app.js 全文，行为与各测试原来的
 * readFileSync 完全一致，509 基线必须原样绿。
 */
const MODULES: readonly string[] = [
  // 批 1a（底层，打样）
  'modules/config.js',    // 常量（原 25-128 行区间）
  'modules/state.js',     // el/state/historyState + 会话记忆（原 130-249、2173-2187）
  'modules/dom.js',       // make/滚动/帧/stabilize（原 39-42、251-502）
  // 批 1b（展示域四件）
  'modules/rail.js',      // 链路条 + doodleSvg（原 36-43、1228-1287）
  'modules/speech.js',    // 大总管气泡 + 但勒思考挂载（原 50-180、1136-1178）
  'modules/member.js',    // 成员气泡/思考/材料 + settle 三件套（原 151-159、854-987、1033-1226）
  'modules/dcard.js',     // 调度卡 + 描边脉冲（原 182-708、1024-1031）
  // 批 1c（环簇二整批 + 附件独立域）
  'modules/attachments.js', // 待发附件全家桶（原 711-990）
  'modules/panels.js',    // 右栏/设置/列表（原 1363-1788）
  'modules/history.js',   // 历史与视图栈（原 189-223、1790-2231）
  // 批 1d（环簇一整批 + composer，web 拆分收官）
  'modules/cards.js',     // 操作卡/提问卡/汇总卡/欢迎板（原 48-192、456-605）
  'modules/events.js',    // handleEvent/handleSubtask（原 198-454）
  'modules/send.js',      // 发送与回合流（原 607-677、680-1051）
  'modules/composer.js',  // 座右铭/@提及/开新会话（原 1054-1082、1093-1250）
]

/** 入口 + 全部已拆模块的拼接全文（源码断言型测试的默认读取口）。 */
export function webSource(): string {
  const parts: string[] = []
  for (const name of ['app.js', ...MODULES]) {
    let text: string
    try {
      text = readFileSync(fileURLToPath(new URL(`../../web/${name}`, import.meta.url)), 'utf8')
    } catch {
      throw new Error(`webSource 清单文件读取失败：${name}——清单与实际文件不一致。拆分提交必须同步：模块文件、MODULES 清单、check 脚本、verifyFiles 结论。`)
    }
    parts.push(text.replace(/\r\n/g, '\n'))
  }
  return parts.join('\n')
}

/** 按文件名单独读一个 web 源文件（api.js 等不参与拼接的文件用；同一 LF 归一）。 */
export function webFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../web/${name}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
}
