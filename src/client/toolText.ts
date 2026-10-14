/**
 * 工具箱的**固定用户文案**（唯一来源，纯常量、零 import ⇒ 不会参与任何循环依赖）。
 *
 * 为什么单独一个文件：这一批起，工具自己的文件（`tools/cake.ts`）里有**运行时** import
 * （数据加载器要走 `tools/globalFlowView.ts` → `api.ts`），而视图模块又要用这里的占位文案。
 * 如果文案留在 `toolRegistry.ts` 里，就会形成
 *   `toolRegistry → tools/cake → tools/globalFlowView → toolRegistry`
 * 的环 —— ESM 下 `TOOL_ENTRIES = [cakeTool]` 会在 `cakeTool` 初始化之前执行，
 * 直接 `ReferenceError: Cannot access 'cakeTool' before initialization`（本机实测）。
 * 把纯常量下沉到这个叶子模块即可断环：`toolRegistry.ts` 仍然 `export` 这些名字，
 * 所以"文案唯一来源"这条约定不变（调用方还是从 `toolRegistry` 拿）。
 */

/**
 * ⚠ 已按用户要求删除的页头元素（**不许加回来**，`toolsPage.test.ts` 有"全目录页不出现"的断言）：
 *   · 页标题 + 计数那一行（`docs/AUDIT-IMPL43.md` §7）；
 *   · 卡片页脚入口文案（改为整卡可点，真实按钮语义、阴影 + 圆角）；
 *   · **页级返回控件**与它的文案（v0.81.0：工具页是顶层页签，"返回"没有意义 ⇒ 连 `PAGE_BACK_ACTION`
 *     常量一并删除；`toolsNav.ts` 也随之删掉 —— 那个模块只服务这个按钮）；
 *   · **搜索框**与它的占位文案（v0.81.0：用户判定冗余 ⇒ `SEARCH_PLACEHOLDER` 与本模块里的
 *     `matchesQuery`/`searchTextOf` 整条链路删除，只保留分类过滤）。
 * 注释里也不再写那几个字面量：`toolsPage.test.ts` 的负向断言是对**源码全文**做的（含注释），
 * 写进去等于自己把断言弄红。
 */
/** 详情页"回到目录"的入口文案（**保留**：从工具详情回目录的唯一入口） */
export const DETAIL_BACK_ACTION = '← 工具目录'
/** 无数据占位（**唯一来源**：不许用 `0` / `—` / `暂无` 冒充） */
export const NOT_FETCHED = '未取到'
/** 占位的原因：工具**还没有**数据源（结构先行） */
export const PENDING_WHY = '数据源下一批接入（本轮只搭结构骨架）'
/** 占位的原因：工具**有**数据源、但这一屏还没取到（具体原因由状态行给出） */
export const NO_DATA_WHY = '本次没有取到数据（原因见顶部状态行）'
/** 占位的原因：整份载荷有数据、但**这一区**没有（逐行原因在市场表下方） */
export const SECTION_EMPTY_WHY = '本次这一区没有可用数据（逐行原因见市场表下方说明）'
/** 目录页零结果的空态（分类过滤可能过滤空；与搜索无关，v0.81.0 起搜索已删） */
export const NO_MATCH = '没有匹配的工具'

/**
 * 详情页底部**两段散文**的标题（用户口径 v0.85.0）：方法一段、边界一段。
 * 两段的正文都来自工具文件（`cake.ts` 的 `method` / `boundary`），页面只负责排版。
 */
export const METHOD_TITLE = '当前偏好怎么判断'
export const BOUNDARY_TITLE = '这份数据的边界'

/**
 * 红线判据（**唯一实现**）：一段文本是不是在把"没有数据"显示成 0。
 *
 * 为什么要有这个函数：v0.72.0 的断言里手写了一条 `/^0(\.0+)?/.test(footnote)` —— 脚注以
 * 「份额合计 = 」开头 ⇒ 行首锚定永远匹配不到 ⇒ **断言恒真、抓不到 `份额合计 = 0.00%`**（AUDIT-HY4-1 §2）。
 * 手写正则很容易再犯；这里给一个"能不能被 0 顶替"的单点判据，页面与断言共用。
 *
 * 命中示例：`0`、`0.00`、`0.00%`、`0.00 亿美元`、`0 亿元`
 * 不命中：`未取到`、`+0.01pp`、`89.17%`、`1063.50 亿元`、`0.05pp`（那是真的非零值）
 *
 * ⚠ **使用范围**：只在"**不该为 0**"的列上用它 —— 本工具里就是「规模」与「份额」（一个市场的
 * 规模不可能恰好为 0，份额 0% 也意味着没有规模）。「份额变化」「动量」两列**可以是真实的 0**
 * （"这一格没变化"或"动量恰好为零"），那里的缺失由「未取到」/「—」的显式断言看守（见 ② 号断言）。
 */
export function looksLikeZeroStandIn(text: string): boolean {
  const t = text.trim()
  if (t === '') return false
  return /^[+-]?0(?:\.0*)?\s*(?:%|万亿美元|亿美元|亿元|万美元|美元|万元|万|亿)?$/.test(t)
}
