/**
 * 工具箱的页签导航（**纯函数**，便于断言；`toolsNav.test.ts` / `toolsPage.test.ts` 读它）。
 *
 * 规则只有两条（对应"返回按钮把页签切回上一个非 tools 页签"）：
 *  ① **只有非 tools 页会被记为返回目标**（在 tools 页里连点两个工具不该把返回目标改成 tools）；
 *  ② 返回目标必须**当下仍然可见**（被停用的行 ⇒ 那个页签已经不在 tab 条上了，不能返回过去）；
 *     上一页不可用时回落到首个可见的非 tools 页；都没有 ⇒ `null`（调用方**不渲染**返回按钮）。
 *
 * 为什么单独一个文件：`PageKey` 定义在 `src/client/index.tsx`（.tsx，node 的 type-stripping 跑不了），
 * 而 node:test 只能加载 .ts ⇒ 导航规则必须是**不依赖 JSX/React** 的模块，且对页键**泛型**（不硬编码页名）。
 */

/** 记忆"上一个非 tools 页"：`next` 是 tools ⇒ 保持原值；否则记成 `next` */
export function rememberPage<K extends string>(last: K | null, next: K, toolsKey: K): K | null {
  return next === toolsKey ? last : next
}

/** 返回目标：优先 `last`（仍可见且非 tools），否则首个可见的非 tools 页；都没有 ⇒ null */
export function backTarget<K extends string>(last: K | null, visible: readonly K[], toolsKey: K): K | null {
  if (last !== null && last !== toolsKey && visible.includes(last)) return last
  return visible.find((k) => k !== toolsKey) ?? null
}
