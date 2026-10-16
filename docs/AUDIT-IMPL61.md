# AUDIT-IMPL61 —— 搜索下拉被裁：高度链定位与修复

- 基线：`main`（v0.96.0，`698 × 2` 全绿）→ 本轮后 **706 × 2 全绿**（+5 条高度断言，另有 3 条上一批的收尾断言一并落地）
- `build.mjs` 未触碰；未 commit / 未装 / 未动 profile / **未重启服务**；隔离目录 `DSH_HOME=/tmp/ui-h-*`

## 1. 一行结论

**不是条数不够，是祖先裁剪**：下拉是绝对定位、只往下长，而它的祖先 `.tw-modal{max-height:82vh; overflow:auto}`（`src/client/styles.ts:369`）是**滚动容器 = 裁剪边界** ⇒ 只有落在弹窗内容盒里的那一行（计数行）可见。修法：把下拉改成**视口坐标**（`position:fixed` + 实测矩形），并按下方空间**向上翻转/整体上移**，高度按视口实测给（保底 ≥5 行 / 160px，上限 52vh / 320px，超出内部滚动）。

## 2. 高度链逐层实测表（改前 / 改后）

> 说明：CSS 值与行号是**实读**；"可见高度"是按几何算出的**推导值**（示例：视口 900px 高、分组添加弹窗、17 条结果）。本机没有可渲染的宿主页面（客户端半区由宿主提供、且本轮不许重启），所以没有浏览器截图，数值给出算式便于复核。

| 层 | 规则 / 位置 | 改前 | 改后 |
|---|---|---|---|
| ① 遮罩 `.tw-mask` | `styles.ts:368`：`position:fixed; inset:0; display:flex; align-items:flex-start; padding:56px 14px 20px` | 弹窗从 **y=56** 起；不裁剪 | 不变 |
| ② 弹窗 `.tw-modal` | `styles.ts:369`：`width:min(560px,94vw); **max-height:82vh; overflow:auto**; padding:14px 16px` | **裁剪边界**：900px 视口下 82vh=738px，但分组弹窗内容只有标题+输入框（≈200px）⇒ 盒子下沿 ≈256px；下拉本该长到 ≈500px ⇒ **只有 256→260 这一行落在盒内**（用户看到的就是计数行） | 弹窗自身保持滚动（它的职责）；**下拉不再住在它里面** ⇒ 裁不到 |
| ③ 输入框包装 | `ui.tsx` `boxRef`：`position:relative` | 绝对定位的参照物 | 不变（仍用它**量取**矩形） |
| ④ 下拉 `.tw-suggest` | `styles.ts:366`：改前 `max-height:**262px**; overflow:auto`；`position:absolute`；`top:calc(100% + 2px)` | 262px（≈9 行）其实**不是瓶颈**（算法：`(262−26)/24 = 9` 行）⇒ 症状来自 ②；但写死高度让它无法按场景取长 | 去掉写死高度；`position:fixed` + `top/left/width/maxHeight` 由 `suggestView.suggestDropdownBoxOf()` 按**视口实测**给出；`overflow:auto` 保留 |
| ⑤ 实际可见 | —— | **≈1 行**（仅计数行，列表被 ② 裁掉） | **≥5 行 / ≥160px**；上限 `min(320, 52vh)`（900px 视口 = 320px ⇒ 12 行）；超出内部滚动 |

**贴底场景（同一套公式）**：输入框在 y=860–884（视口 900）⇒ 下方只有 `900−884−8 = 8px`、上方 `860−8 = 852px` ⇒ 判据 `below(8) < 最小列表(160)` 且 `above > below` ⇒ **`up=true`**，浮层整体上移到视口内（`top = max(8, min(884+2, 900−maxHeight−8))`），翻转后仍能显示 ≥5 行。

**窄侧栏**（插件常见）：输入框 260px 宽、视口 760px ⇒ 上限 `min(320, 52vh=395) = 320` ⇒ 12 行 ≥5 ✓；宽度沿用输入框（不缩水）。

## 3. 实现

| 文件 | 改动 |
|---|---|
| `src/client/suggestView.ts` | 新增纯几何：`SUGGEST_ROW_PX(24)` / `SUGGEST_HEAD_PX(21)` / `SUGGEST_COUNT_PX(26)` / `SUGGEST_MIN_LIST_PX = max(160, 5 行)` / `suggestCapOf(vh) = min(320, max(下限, 52vh))` / `suggestDropdownBoxOf({rect, viewportH, contentHeight}) → {top,left,width,maxHeight,up}` / `visibleRowsOf(h)` |
| `src/client/ui.tsx` | `SuggestInput`：`measure()` 读输入框 `getBoundingClientRect()` + 按当前分批内容算高度 ⇒ 落点用**视口坐标**；`open` 时量一次，并在 `resize` 与 `scroll`（捕获阶段）时跟随；渲染加 `data-flip` / `data-max-h`（可复核） |
| `src/client/styles.ts` | 删掉 `.tw-suggest` 里写死的 `max-height:262px`（保留 `overflow:auto`），并写明高度改由几何函数给 |

**没有改变既有交互**：回车仍选"排序后第一条"、点击仍 `onMouseDown` 添加、计数行文案仍来自 `countTextOf`（唯一实现）；**不新增依赖**（没用 portal：`react-dom` 不在打包 external 面里，动它会牵到 `build.mjs`）。

## 4. 断言与反例注入（`src/client/suggestHeight.test.ts`，5 条）

| # | 断言 | 反例注入（必败） |
|---|---|---|
| ① | 列表可见高度 ≥ `max(160px, 5 行)`；不超过上限；内容高于上限时按上限截断（内部滚动） | 上限被压到 40px ⇒ `assert.throws` |
| ② | 下拉必须是**视口坐标**（`fixed`）+ 由几何函数算落点；`.tw-suggest` 里写死的 `262px` **必须已删**；`overflow:auto` 保留 | 退回 `absolute` ⇒ `assert.throws` |
| ③ | 贴底（下方 8px / 上方 852px）⇒ `up=true`，落点与下沿**都在视口内**，翻转后仍 ≥5 行；空间充裕时不翻转 | 去掉翻转（`up=false` 且按下沿定位）⇒ 浮层越出视口底边 ⇒ `assert.throws` |
| ④ | 17 条结果、窄侧栏（260×760）下可见行数 ≥5；宽度沿用输入框；高度 ≤52vh 上限 | 按"祖先裁剪"的真实形态（可见高度 20px）构造 ⇒ 0 行 ⇒ `assert.throws` |
| ⑤ | 回归：计数行文案/data-role、点击添加、回车选第一条、类名与滚动行为都不变 | ——（逐条源码断言） |

**写这条 ④ 时先踩了一次自己的坑（记录在案）**：我最初的反例是"把可用高度砍一半"，实测 `(497/2−26)/24 = 9` 行 ⇒ **反例不成立** ⇒ 说明"砍高度"复现不出用户症状，**印证了根因在祖先裁剪而不是高度上限**；已把反例改成"可见高度 = 20px（被祖先裁掉）"这一真实形态。

## 5. 未做项

1. **未做真机截图**：本机无法渲染插件页面（客户端半区由宿主提供），且**本轮不许重启** ⇒ 高度链是"CSS 实读 + 几何推导"，不是浏览器实测。发布后建议复核三处：分组添加弹窗里 17 条是否一次能看到 ≥5 行、弹窗贴底时是否向上展开、窄侧栏（自选/持仓页）下同样成立。
2. **未用 portal**：`position:fixed` 已能脱离所有祖先裁剪，且不需要改打包 external（`build.mjs` 归你）；若将来要"跨 iframe/多窗口"再评估 portal。
3. **弹窗自身的滚动没动**（`.tw-modal{overflow:auto}` 保留）：它对"内容很长的弹窗"是必要的；本轮只是让下拉不再依赖它露出。
4. 未处理"虚拟键盘/极小视口（<400px 高）"：那时保底 5 行也放不下，公式会给相对视口的最大值（`top` 仍夹在视口内，不会整块消失）。
