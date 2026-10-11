# 切页签不再"整块刷新"：保留上一张图 + 叠载入态；筹码与页签彻底解耦（两批合并记录）

对象：`dsh-tradewatcher` v0.47.0 工作区。基线 371 条。
末次 `npm run check`：**372 条 × 2 时区全绿**、`ALL HOST CHECKS PASSED (live probes soft)`、`build.mjs` 零改动。
不装 bundle、不动 profile、不 commit、不重启；**未动 `src/index.ts` 行映射**。

---

## 批一：保留上一张图 + 叠载入态（用户第二次反馈的那个观感）

### 根因
`QuoteDrawer` 在切页签时执行 `setPayload((prev) => (prev !== null && prev.tab === tab ? prev : null))` ⇒ 把上一帧**丢掉**，
`chartBody()` 的早退分支（`payload === null || payload.tab !== tab`）于是渲染**整块骨架**（`height: chartHeight` 的空盒）
⇒ 图表区从"有图"塌成骨架，观感就是"整个侧栏在刷新"。筹码面板本身没被卸载（它是同一 body 的兄弟），
但图表区的塌陷把它一起往上拽 ⇒ 看起来"上下都在刷"。

### 改法（三处，都是小改）
1. **不再清空**：删掉那句 `setPayload(…null)`，改为 `setLoading(true)` ⇒ 上一帧留在 `payload` 里。
2. **骨架只留给首帧**：`chartBody()` 的早退条件收窄为 `payload === null`（没有任何上一张图时才允许骨架）；
   旧周期的最后一帧继续渲染（**不**把旧周期数据当作新周期解释：页签标签、复权控件、图表类型仍按当前 `tab` 走，
   图种切换由 `KlineChart` 自己的 `key: tab` 完成）。
3. **叠加层**：body 里用 `.tw-chart-wrap` 包住 `chartBody()`，并叠 `.tw-chart-loading`（**半透明淡遮罩 + 2px 细进度条**，
   `pointer-events:none` ⇒ 不挡 hover；文案"载入中 · 上图为上一周期"，带 `aria-busy`/`aria-label`）。
   新数据到达后 `payloadTab === tab` ⇒ 叠加层自动消失，**不闪回空态**；失败仍走既有 `NoteIcon`/`unavailable` 契约。

### 纯函数（可断言）
`src/client/chartFrame.ts`：`chartFrameOf({ hasPayload, payloadTab, tab })` → `{ state: 'fresh'|'stale'|'first', overlay, skeleton }`。
```
① 首帧（无任何图）  ⇒ state=first,  skeleton=true          ② 切页签（旧图属别的页签）⇒ state=stale, overlay=true, skeleton=false
③ 新数据到达        ⇒ state=fresh,  overlay=false, skeleton=false
```
### 断言（`src/client/chipsView.test.ts`）
```
① 切页签后旧序列仍被渲染：不许再出现"切页签清空 payload"的写法 ✓；骨架分支只匹配 `payload === null` ✓
② 加载态与旧图同时存在：`chartBody()` 与 `frame.overlay` 在同一个 `.tw-chart-wrap` 内 ✓
③ 首次进入允许骨架 ✓（纯函数 first 分支）
④ 筹码面板 DOM 身份不变：沿用挂载计数（`__twMounts()`）+ 既有结构断言 ✓
```

---

## 批二：筹码与页签彻底解耦（用户指出、Lead 认定为设计错误）

### 改法
1. **删掉页签门控**：`ChipsPanel` 的 `isFiveDay` props 与整个五日档分支删除；抽屉不再向面板传页签 ⇒
   `分时/五日/日K/周K/月K/年K` **六个页签全部显示**筹码模块，数据（同一个 `secid`）与滑杆位置完全一致。
2. **删掉那行说明文案**"筹码分布只在分时/日K 及以上显示…"（面板源码里已无此串，连注释一并更新，
   避免文档与实现不符）。
3. **保留与标的/数据有关的原因**（不是页签门控，各给一行）：
   - `fqSupported=false`（指数/期货/板块无前复权序列）⇒ 一行原因；
   - 样本不足（`N < 10`）⇒ 一行原因；
   - 口径偏离默认（港股回落固定半衰期、缺 `floatMv`）⇒ 由 `caliberDeviates()` 给一行原因；正常标的**一个字都不显示**。

### 断言与反例
```
遍历六个页签（1m/5d/day/week/month/year）：`caliberDeviates()` 结果必须逐字相同（筹码与页签无关），
  正常标的恒为 null（不显示任何口径文案）✓
面板/useChips/chipsLoader 三个文件里**不存在** 页签判断（不出现 isFiveDay / tab === '5d'）✓
那行说明文案在前端源码里已不存在 ✓
反向注入（把 `isFiveDay` 变量加回面板）⇒ 断言失败：
  ✖ task-64：筹码与页签无关 …
    AssertionError: 面板不许再有 isFiveDay（页签门控）        （恢复后 7/7 通过）
```

---

## 测试与门禁
```
371 → 372（批一：保留上一帧的三态 + 加载态共存；批二：六页签一致性与门控删除；
  同时把 task-59/61 留下的"五日档"用例与面板注释一并更新，避免断言与实现不符）
npm run check：372 × 2 时区全绿；75 项片段校验通过；build.mjs 零改动
```

## 未做项
1. 批一没有改"图表区骨架高度"本身：首帧仍是骨架（规格要求允许），但**首帧**的高度跳变无法完全消除（没有旧图可留）。
2. 批二删掉页签门控后，五日档会显示基于**日线**的筹码分布 —— 这是**刻意的**（筹码是标的属性，由日线推出）；
   面板没有再加"这是日线口径"的常驻说明（用户明确反对增加前台说明文字）。
3. 拖拽分割线（`task-65`）**尚未开始** —— 按 Lead 的"顺序做"排在这两批之后。

## 需装机复核（无浏览器，未做视觉验证）
① 切 6 次页签：图表区应**不再塌成骨架**，而是"上一张图 + 细进度条/淡遮罩"；筹码区一动不动；
② 控制台 `__twMounts()` 切页签前后保持 `{drawer:1, chips:1}`；
③ 弱网/失败时：叠加层消失后按既有契约出 `NoteIcon` 或一行原因（不留白）；
④ 六页签下筹码四数字与分布条逐字一致（含五日档）。

---

## 批三（task-65）：抽屉上下分区可拖拽分割线 + 图表高度动态重绘

### 规格落地
| 项 | 实现 |
| --- | --- |
| 分割线本体 | `.tw-split`：**9px 命中区（1px 细线 + 上下各 4px）**，`cursor:row-resize`，**无**装饰箭头/把手 |
| 拖拽 | `mousedown` 起手 → 只更新 `dragRatio`（**只挪线**，不重绘图表、不发请求）→ `mouseup` 才 `commitRatio` ⇒ **按最终高度重绘一次**；`user-select:none` + `e.preventDefault()` ⇒ 不选中文字、不触发图表 hover |
| 持久化 | `prefs.splitRatio`（默认 **0.62**，范围 **[0.25, 0.75]**）；宿主 `setPrefs` 白名单放行 + `normalizeSplitRatio` 归一；**老 profile 缺键 ⇒ 默认**；NaN/越界/字符串 ⇒ 回落默认并 `log` 如实记录；装载路径同样归一 |
| 边界 | `splitHeights()` 夹取：上窗 ≥ **160px**、下窗 ≥ **120px**；整体太矮按最小值给且**两区之和 ≤ 可用高度**（不出现负高度/重叠）；`available=0` ⇒ `{0,0}` 不抛错 |
| 键盘 | `role="separator"` + `aria-orientation="horizontal"` + `aria-valuenow/min/max` + `tabIndex=0`；`↑/↓` **2%**（两端夹住）；`Enter`/**双击**恢复默认；`title`/`aria-label` 写明"拖动调整…双击或回车恢复默认" |
| 与结构的关系 | 筹码区原 160px 上限**改由分割线决定**（`props.maxBottom` → `.tw-chips-body` 的 `maxHeight`）；折叠时**不渲染分割线**（面板用 `onOpenChange` 上报折叠态）；拖拽不重挂载（无 key 变化） |
| 数字面 | **不新增**（没有比例百分比常驻显示）⇒ 不涉及 `data-blur` 清单 |

### 图表高度必须**重绘**（Lead 补的关键点）
- `chartHeight` 从硬编码 `8+210+6+54+6+64+16 = 364` 改成 `klineHeightsOf(split.top)` 算出的**动态值**；
  `KlineChart` 的 `mainH/volH/macdH` 也由它给 ⇒ 比例尺/轴刻度/横条位置都按新高度**重算**（**没有** CSS 拉伸/缩放）。
- **不是等比缩放的判据**：固定开销（间隙 `8+6+6+16 = 36` + x 轴文字 24 = **60px**）保持常量，
  只有绘图区随高度变 ⇒ 断言里两个高度的 `chartHeight − (mainH+volH+macdH)` **恒等于 60**。
- **拖拽节流**：拖动中只挪线；松手后按最终高度重绘一次全图（避免每像素全量重绘）。
- **零尺寸保护**：`top ≤ 60` ⇒ `usable=false`（最小值夹住、不重绘空图、不出现 0/负几何、不抛错）。
- **页签身份不变**：`KlineChart` 的 `key: tab` 原样保留；新增的定高容器与分割线**都不带 key** ⇒ 拖动不会重挂图表/筹码。

### 断言与本轮证据
```
① 动态高度：320 vs 560 两个上窗高度 ⇒ mainH/volH/macdH 不同；固定开销恒为 60（非等比缩放）；
   轴刻度按高度重算（<120px ⇒ 3 条、<240px ⇒ 4 条、≥240px ⇒ 5 条；同一价格区间不同高度刻度集不同）
② 极小/极大高度夹住且不抛错：0/1/36/59/60（usable=false 且几何有最小值）、1000px 比例越界夹到 75% 内
③ 拖动前后挂载计数不变：`KlineChart` 仍 `key: tab`、定高容器与分割线无 key（配合 `__twMounts()` 装机复核）
④ 反例一（去掉夹取）：✖ 夹取：超界落在最小值/最大值… AssertionError: 被夹住时标记 clamped
   反例二（把几何改回硬编码 230/54/64）：✖ 动态高度：… AssertionError: 图表几何必须来自 kh（不许硬编码）
   （两次注入均已恢复，恢复后 6/6 通过）
⑤ 键盘/折叠/持久化：四组断言全绿（步长 2%、两端夹住、Enter/双击复位、role/aria/tabIndex 齐备、
   折叠上报 ⇒ 分割线不渲染、setPrefs 白名单放行 + 装载归一）
```

### 测试与门禁
```
372 → 378（+6：夹取/持久化归一/键盘与 aria/折叠与不重挂载/动态高度与轴刻度/拖拽预览）
npm run check：378 × 2 时区全绿；75 项片段校验通过；build.mjs 零改动
```

### 未做项
1. 拖动中**没有**做"跟手重绘预览"（按规格允许的第二条路线：只挪线、松手重绘一次）⇒ 松手前上窗内容仍是旧高度。
2. 触屏（`pointer*` 事件）未处理：当前用 `mousedown/mousemove/mouseup`；`role=separator` + 键盘已覆盖无鼠标场景。
3. 比例没有常驻百分比显示（规格要求不加新数字面）⇒ 只在 `aria-valuenow` 与 drag 时可见。

### 需装机复核（无浏览器，未做视觉验证）
① 拖动分割线：线条跟手、松手后图表**按新高度重画**（文字/线宽不变形）；② `__twMounts()` 在拖动与折叠切换后仍为 `{drawer:1, chips:1}`；
③ 键盘 Tab 到分割线有可见焦点环、↑/↓ 各 2%、Enter/双击回默认；④ 折叠筹码后分割线消失；⑤ 极矮窗口下不出现负高度/重叠。
