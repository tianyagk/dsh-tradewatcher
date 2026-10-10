# 行情卡片配置窗 + 五档状态 badge（设计规格 · **未落地**）

取证（只读）：`styles.ts:61-80/134-171`（blur 两条清单、`.tw-qcard`/`.tw-qdot`、z-index 层级）、`TopBar.tsx:425-547`（strip 结构与齿轮落点）、`quoteState.ts`（四态色点与词表）、`ui.tsx:8-28`（Modal 的 Esc 模式）、`store.ts:463-471/1005-1056/1076-1103`（prefs 装载宽容 vs patch 抛错）、`shared/model.ts:11-55/568-616`（TW_ROWS 三组 23 张 + DEFAULT_PREFS）。尺寸/对比度按上述 CSS 与 WCAG 相对亮度实算（对比度公式见 §4）。
**国债可得性已由 `docs/RESEARCH-BOND-STRIP.md`（本机实测）给出**：中国两条路现在可用；美/日/德/英只有 `171.*` 收益率一条路且当前取不到（东财三台行情主机整窗熔断）⇒ §3 按实测结论写，未复核通过前那四张只能 `—`。

## 1. 组件边界

- **齿轮**：放在 `.tw-topmeta`（`TopBar.tsx:428`）右侧按钮组**最左**（现有 `▣` 之前），复用 `.tw-iconbtn`，字符 `⚙`，`aria-label="行情卡片配置"`、`title="配置实时行情卡片（Esc 关闭）"`。理由：不动现有 ▣/◐/⟳ 三枚按钮的位置。
- **状态归属**：`cfgOpen` 留在 `TopBar`（与 `shotOpen` 同处，不上提 `index.tsx`）；**窗口位置是组件内 state，不落 prefs**（跨会话恢复一个飘在半空的窗口会出现在意外位置）。
- **DOM/z-index**：渲染在 `.tw-topbar` 内、按钮组之后，`.tw-cfg{position:fixed;z-index:1180}` —— 高于 `.tw-menu`(1150)/`.tw-suggest`(1100)，低于 `.tw-mask`(1200)/`.tw-drawer-mask`(1300)。打开配置窗时把 `popupDisabled` 置真（`index.tsx:432` 已有此 prop），否则悬停卡 `.tw-pop`(9999) 会盖住窗口。
- **拖动**（鼠标增强）：只有窗口头 `.tw-cfg-h` 是把手（`cursor:move;touch-action:none`）；`onPointerDown` → `setPointerCapture`，`pointermove` 按位移更新 `left/top` 并 clamp 到 `[8, vw−w−8]×[8, vh−h−8]`，`pointerup`/`lostpointercapture` 结束，`resize` 后重新 clamp。窗体 `width:min(320px,calc(100vw−16px))`、`max-height:min(70vh,520px)`、`border-radius:12px`、`background:rgba(255,255,255,.92)`（深色 `rgba(15,16,17,.92)`）+ `backdrop-filter:blur(6px)`（与 `.tw-mask` 的既有用法同族）+ `box-shadow:var(--tw-shadow-lg)`。
- **键盘（必需，不是可选）**：`role="dialog" aria-modal="true" aria-labelledby`；打开即聚焦首个 checkbox；`Tab/Shift+Tab` 在窗内循环；`Esc` 关闭并把焦点**还给齿轮按钮**；控件一律原生 `input[type=checkbox]`/`<button>`（焦点环已有 `styles.ts:48`）。移动窗口不算键盘必需能力；低成本增强可做：把手 `tabIndex=0` + 方向键 8px（Shift 40px）。

## 2. 配置窗内容与持久化

- 结构：标题「行情卡片配置」+ `×`；工具行 `全选` / `反选` / `恢复默认`（`Btn`）；4 个折叠组；底部一行口径 + `已选 N/28`。
- 组行 = 组 checkbox + 组名 + `已选 n/m`；组内每张卡一个 checkbox（两列 `repeat(auto-fill,minmax(140px,1fr))`，区高 `max-height:220px` 内滚动，窄面板自动退一列）。
- 分组与数量：A股指数 6 / 国际市场 9 / 大宗商品 8（`model.ts:11-55`）+ **国债 5（§3：1 张现在可用，4 张待东财复核）**。某组全隐藏 ⇒ **整行不渲染**（不显示空的 `.tw-strip-label`）。
- **调序：建议不做**。① 顺序进两端共享的 `TW_ROWS`，一旦用户可改就有两个真相源；② 拖拽排序与"窗口可拖动"是同一手势，误操作率高；③ 固定格子更利于扫读（同一卡片每天在同一位置）；④ 若确需，下一轮只做**组间顺序**（4 项，上/下按钮，非拖拽）。
- **持久化**：`prefs.stripCfg = { hidden: string[] }` —— 存**隐藏集合**而非显示集合：老 prefs 无此键 ⇒ `hidden=[]` ⇒ 全部可见，且**将来新增的卡片默认可见**（存显示集合会让老 profile 看不到新加的国债卡，这是最典型的向后兼容事故）。
  - 校验照既有两段式：patch 走 `normalizeStripCfg(…, cur)`（非数组/含未知 secid ⇒ **抛错** → 400）；装载走 `safeStripCfg`（过滤未知 secid、非数组回退 `[]`）—— 与 `normalizeSortPref`/`safeSortPref`（`store.ts:1076/1095`）同模式。
  - `恢复默认` = `hidden:[]`；`全选` = `hidden:[]`；`反选` = 把当前可见 secid 全部放进 `hidden`。
  - `已选 N/M` 用 `.tw-cfg-count`（`--tw-mono`）⇒ **必须进 §4 的两条 blur 清单**，且第二条的 hover 容器列表要加 `.tw-cfg`（否则隐身档永远糊着、hover 也不显形）。

## 3. 国债卡片（据 `RESEARCH-BOND-STRIP.md` §1 的实测结论）

**可得性**：中国有两条现成路径 —— `1.000012` 国债指数 / `1.511260` 十年国债 ETF（实测有价 + 40 根日线）；**美/日/德/英只有 `171.US10Y / JP10Y / DE10Y / GB10Y` 收益率一条路**，`/quotes` 全 `missing`、`171.*` 无腾讯/新浪映射 ⇒ **复核（该文档 §1 的两条 curl）通过前这四张只能如实 `—`**；**不许用股指/汇率等代理指标替代**。

| | A 收益率形态（美/日/德/英，待复核） | B 价格形态（中国，现在可用） |
| --- | --- | --- |
| 主值 | `4.23%`（2 位小数） | 指数 `231.10`（2 位）/ ETF `134.829`（3 位） |
| 副值 | `+3.2bp`（1 位小数，**必带正负号**） | `+0.42%` chip |
| 着色 | **不套红绿**，用 `tw-flat`：收益率上行 ≠ 债券"涨" | 走 `dirClass(pct, redUp)` |
| 类型标记 | 卡名行尾一个字 `率` | 卡名行尾一个字 `价` |
| title | 「美国10年期国债收益率；+3.2bp = 收益率上行，对应债券价格下跌 · 数据时刻 …」 | 「国债指数（交易所，价格型）· 数据时刻 …」 |
| badge 基准 | **−收益率**（价格代理）⇒ 过热＝价格强，与股票卡语义一致 | 直接用价格序列 |

**混用两类必须标类型**（该文档 §2-3）：否则同屏"中国涨、美国跌"无法解释。卡名用短名（`中国国债` / `美国10Y` / `日本10Y` / `德国10Y` / `英国10Y`），全称、类型与 `bp` 含义进 `title`/`aria-label`；secid 进 `TW_ROWS` 时必须与复核结果同时提交。

## 4. badge 视觉规格（可直接落 CSS）

**位置：卡片右上角**（`right:4px;top:4px`，绝对定位），不占布局、不改卡片宽高（`min-height:54px`、grid `minmax(112px,1fr)` 全不动）。
为什么不是"贴右侧垂直居中"：卡实际宽 ≈113px（`styles.ts:73` 的 auto-fill 在 1420px 面板生成 12 条轨道、6 张卡各占一条），内容区仅 94px；垂直居中会压住价格（15px mono 7 字符 ≈63px）与 `.chg` 行（≈106px）。右上角只压名称行，而名称本来就会 ellipsis。

```
.tw-tone{position:absolute;top:4px;right:4px;height:14px;line-height:12px;padding:0 5px;border-radius:7px;
  font-size:10px;border:1px solid currentColor;background:currentColor;background-clip:padding-box;
  pointer-events:none;white-space:nowrap}
```
- 尺寸 32×14（2 汉字 ×10px + 左右 5 padding + 1 边框），圆角 7px（=高/2 胶囊）；**只放档位词，不放数字**。
- 底色 = 档位色 12%（浅）/16%（深）透明度，文字与边框 = 档位色本体 —— 按 `--tw-up-bg` 的既有写法定义 `--tw-tone-*-bg` 两套 token。
- **让位规则（唯一改到的既有样式，两行）**：`.tw-qcard[data-tone] .nm{padding-right:40px}`、`.tw-qcard[data-tone] .tw-qdot{right:42px}`。延迟点仍 6px、只是左移；价格与涨跌行**任何情况下不被压**。国债卡的类型字 `率`/`价` 作为 `.nm` 内的行内元素（不做绝对定位），40px 让位仍只留给 badge。
- hover 口径（README 原则 1/6：卡面只留通用词，口径进 `title`/`aria-label`）：badge 自身 `pointer-events:none`，文案挂卡片已有的 `title`/`aria-label` ——
  `状态：过冷（近 30 日涨跌幅分位 6%，动量 −2.1%）· 基准：该标的自身 30 日涨跌幅的历史分布 · 每日 15:05 后更新`

**五档配色（独立色系：靛蓝→青→石板灰→紫→品红，不含红/绿/琥珀）**：

| 档 | 词 | 浅色（卡底 #ffffff，bg 12%） | 深色（卡底 #0f1011，bg 16%） |
| --- | --- | --- | --- |
| 1 | 过冷 | `#2B4C9B` — 6.68:1 | `#7EA6FF` — 6.17:1 |
| 2 | 偏冷 | `#176B87` — 5.06:1 | `#57C7E0` — 7.26:1 |
| 3 | 适中 | `#5A6270` — 5.20:1 | `#A7B0C0` — 6.61:1 |
| 4 | 偏热 | `#7B3FA8` — 5.62:1 | `#C4A2FF` — 6.86:1 |
| 5 | 过热 | `#A32C7A` — 5.44:1 | `#F08BC7` — 6.44:1 |

对比度 = 文字色 vs「该色按 12%/16% 混到卡片底色后的实际底色」，全部 ≥4.5:1（10px 小字达 WCAG AA）。**色盲兜底 = 文字本身**（不靠颜色单独承载语义，满足 1.4.1）+ `data-tone` 属性（供断言与读屏）。**不要**用红→绿渐变；**不要**用琥珀暖端（见 §8-3）。

## 5. 五档怎么算（宿主纯函数 + 按日 memo）

- 序列：该标的**已收盘**日线收盘价（`em.fetchKline` 磁盘缓存，指数/期货/商品按不复权口径）；**不含当日未收盘当根**（与 README「当根未收盘」一致）。
- `R30 = P_t/P_{t−30} − 1`（近 30 个交易日涨跌幅）；`M = (P_t/P_{t−5}−1) − (P_{t−5}/P_{t−30}−1)`（动量 = 近 5 日相对前 25 日）。
- 档位 = `R30` 在该标的**自身历史 R30 分布**中的分位 `p`：`p<10% 过冷 / p<30% 偏冷 / p≤70% 适中 / p≤90% 偏热 / p>90% 过热` —— 回答"相对历史的位置"，不是绝对阈值、更不是预测。
- `M` **只做文字修饰**（title 里给符号与数值），**不参与分档**（否则同一分位会因短期波动跳档）。
- 覆盖分档（与该 RESEARCH 文档 §3-C/§7 一致，`bars` = 可得日线根数）：`bars≥31` 可算 R30（比"30 根"多 1 根是 R30 取 `t−30` 的定义要求）；`5≤bars<31` ⇒ 显示"样本不足"；`bars<5` ⇒ `—`。
- 分位基准样本 `m` = 该标的历史 R30 的个数：`m≥60` 正常；`30≤m<60` 给分位但在 title 标「样本少」与样本数；`m<30` ⇒ 不发布档位（`—` + 「分档基准不足（m/30）」）。
- 「每日一个」：宿主按**日** memo（同 `host/ytd.ts` 的按日 memo 模式），15:05 后重算；盘中不随价格抖动改档。
- 接口：`GET /tradewatcher/tones?ids=` → `{asOf,stale,source,rows:[{secid,tone,pct30,momentum,samples}],missing:[{what,why,note}]}`，`why` 沿用 `no-source`/`transient` 两档；客户端纯函数放 `client/stripTone.ts`（不 import react）。

**空态与失败态（按 README 原则 3，不许用「适中」冒充缺失）**：

| 情形 | badge | 可见/可读文案 |
| --- | --- | --- |
| 有日线但 `5≤bars<31` | `—` | 样本不足（现有 N 根日线，R30 需 ≥31 根） |
| 分位基准 `m<30` | `—` | 分档基准不足（m/30 个历史样本） |
| 三源都没有日线 | `—` | `no-source`：该标的无日线源，重试无用 |
| 本次取数失败 | `—` | `transient`：日线本次未取到，随轮询重试 |
| 计算异常 | 不渲染 | `data-tone=error` + title 记原因；**不得显示 0 / 适中** |

## 6. 边界情形

- **长名称**：`.nm` 本来就 ellipsis，再加 `[data-tone] .nm{padding-right:40px}` 硬让位，不会顶到 badge。
- **最小卡宽 113px**：badge 32px + 延迟点让位后名称可读区 ≥64px；价格/涨跌行满宽（与今天一致，不多裁一个像素）。
- **极窄面板（<520px）**：卡片仍 `minmax(112px,1fr)`（不改）；配置窗 `width:min(320px,calc(100vw−16px))`、组内两列自动退一列、`max-height:min(70vh,520px)`。
- **与延迟绿点冲突**：`[data-tone] .tw-qdot{right:42px}` —— badge 占右 4..36px，点占 42..48px，间隙 6px，两者同在名称行带（y 4..18）；**无 tone 时 qdot 保持 `right:5px` 不动**，现有截图不变。

## 7. 验收清单

静态可查：① `grep -n 'tw-tone\|tw-cfg' src/client/styles.ts` 命中两条 blur 清单各 ≥1 次，且 hover 容器列表含 `.tw-cfg`；② badge 着色不出现字面量 `#e5484d/#0e8f5c/#ff5f6d/#27a644`，一律走 `dirClass`/`toneClass`；③ 断言（`node:test`，中文用例名）：`normalizeStripCfg` 非法输入抛错、`safeStripCfg` 过滤未知 secid 且非数组回退 `[]`、缺 `stripCfg` 键 ⇒ 全部可见、`bars<31` 或 `m<30` ⇒ 返回缺失而非「适中」、`p=0` ⇒ 「过冷」而不是缺失、收益率卡进 badge 前先取负（同一段序列取负后分档必须与价格型卡语义一致）；④ `styles.test.ts` 既有断言继续绿（本规格不新增 `@media (min-width:Npx)`）。
装机观感（必须实机）：⑤ 1420px 面板下卡片宽高与改造前逐像素一致（截图叠加比对），badge 不压价格/涨跌；⑥ 齿轮 → `Tab` 走完所有 checkbox 且焦点环可见、`Space` 生效、`Esc` 关闭且焦点回齿轮、拖到视口四角被 clamp；⑦ 窗口打开时悬停卡片**不出现**悬浮卡盖窗；⑧ 隐身档（Alt+M + 数字模糊）：`已选 N/M` 与 badge title 里的数字不可读，hover 卡片时 `已选` 显形；⑨ 深浅主题各一张「同屏有红涨绿跌卡片 + 五档 badge」的图，确认不混色。

## 8. 异议（3 条，其余按 Lead 约束执行）

1. `aria-modal="true"` 与"浮层可拖动、背景仍可见"语义偏严（该属性声明外部内容不可交互）。建议**真做模态**（§1 的焦点陷阱 + Esc 回焦），否则应去掉 `aria-modal` 只留 `role="dialog"`；不要"加了属性但不做陷阱"。
2. "不许改变卡片尺寸"我按**外框尺寸不变**实现（40px 让位只作用于 `.nm` 内边距）。若要求连内边距都不动，badge 必然压住名称文字，只能改成 hover 才显示 —— 那与"每张卡挂 badge"矛盾，故按前者设计。
3. 暖端未用橙/红：深色主题下 `#E0B15C` 一类暖琥珀与既有警示色 `#e0a94a` 的对比度差 ≈1.0（几乎同色），会把「偏热」读成"故障提示"，故改紫→品红。
