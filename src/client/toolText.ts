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

/** 目录页标题 */
export const CATALOG_TITLE = '工具目录'
/** 搜索框占位 */
export const SEARCH_PLACEHOLDER = '搜索工具、市场或指标'
/** 卡片页脚入口文案 */
export const CARD_ACTION = '打开工具 →'
/** 详情页"回到目录"的入口文案 */
export const DETAIL_BACK_ACTION = '← 工具目录'
/** 页级返回按钮文案（回上一个非 tools 页签） */
export const PAGE_BACK_ACTION = '← 返回'
/** 无数据占位（**唯一来源**：不许用 `0` / `—` / `暂无` 冒充） */
export const NOT_FETCHED = '未取到'
/** 占位的原因：工具**还没有**数据源（结构先行） */
export const PENDING_WHY = '数据源下一批接入（本轮只搭结构骨架）'
/** 占位的原因：工具**有**数据源、但这一屏还没取到（具体原因由状态行给出） */
export const NO_DATA_WHY = '本次没有取到数据（原因见顶部状态行）'
/** 占位的原因：整份载荷有数据、但**这一区**没有（逐行原因在市场表下方） */
export const SECTION_EMPTY_WHY = '本次这一区没有可用数据（逐行原因见市场表下方说明）'
/** 搜索无结果的空态 */
export const NO_MATCH = '没有匹配的工具'
