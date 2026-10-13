# FIX-4-REDUNDANCY-DOCS —— 冗余与文档（最后一批）

来源：`docs/REVIEW-1-REDUNDANCY.md`、`docs/REVIEW-3-DOCS.md`。门禁：`npm run check` **EXIT=0，563/563 × 2 时区
+ selftest + build（v0.77.0，73 条锁定片段全过）**；`build.mjs`／`package.json` **零改动**（`git diff --stat` 为空）。

**一行结论**：文档里"教用户用已删功能"的整节与六处行数/行号口径已改正（含 CHANGELOG 里那条不成立的声明、
按历史事实更正而非抹掉），10 个真死导出／1 个零消费文件／2 个死字段／4 条死 CSS 已删（删前逐条核对 build.mjs
的 73 条锁定片段：**无一条命中**），面板里失效的 1.63 阈值已核实为**旧标定 P90** 并改为现行 `f1.extreme = 1.92`
（附跨文件同步断言）；被引用的空文件头补回 3 个，9 条过期注释逐条修正。

---

## A. 文档更正

| # | 项 | 动作 |
|---|---|---|
| 1 | README「大盘云图」自绘整节（`README.md:77-82`）描述 v0.62.0 已删功能 | 整节改为「**只保留第三方站点**」+ 一行删除溯源（指向 CHANGELOG）；同时删掉文件树里的 `client/treemap.ts`（已删文件） |
| 2 | 组件行数 6 → 7 | `README.md:344`「拆成**七行**（… + `tools`）」、`:346` 行清单补 `tradewatcher-tools`（v0.71.0 加入）；`docs/DESIGN-SUBPLUGINS.md` 的 `:3`/`:56`/`:113`/`:162` 全部改七行（含 `core + 6 = 7`、`七条 Loader 行`、`锁七行`） |
| 3 | 「行清单唯一权威处」的行号失效 | `cordis.patch.yml:38-56` → **`:53-75`**，共 6 处（`README.md:346`；`DESIGN-SUBPLUGINS.md:3`/`:42`/`:127`/`:162`），另 `README.md` 那句仍自称"唯一权威处"（见 §8 去重） |
| 4 | CHANGELOG 里不成立的声明（REVIEW-3 §4.1 C1，`CHANGELOG.md:191`） | **更正而非删除**：在 v0.71.0 该条下加「⚠ **更正（v0.78.0 文档批）**：原写"README / DESIGN-SUBPLUGINS 已一并更新"与事实不符……本行按历史事实保留并标注更正」 |
| 5 | 权威性去重 | 收敛到**一处**：行清单唯一权威 = `cordis.patch.yml`（README 只留指针 + 行号），行归属判据 = `src/index.ts` 的 `ROW_ROUTES`（文档只描述、不复制清单），阈值口径 = `src/host/rescue-thresholds.ts`（README 只报数值并注明来源）。见 §8 的说明 |
| 6 | 三条新约定写进 `docs/DECISIONS.md` | 追加「三条新约定（v0.78.0 记）」：① 上游请求必须走 `breakerFetch.withHostBreaker`（含"HTTP 非 2xx 也算失败"与低层 helper 的豁免条件）；② 行归属按实际调用方推导（`deriveRouteOwners`）；③ 断言强度全仓防线（`assertStrength.test.ts`，判据自带双向对照） |
| 附 | 同一批顺手改正的 README 失配（REVIEW-1 §5.1 ③④⑤⑥⑦） | 页签「五个」→**六个**（含工具箱）；行情条「三行」→**四行**并补「国债收益率」行；预设组清单统一为含 `bond`；标定数字 `1.20/1.63/1.98x` → **`1.19/1.57/1.92x`**；`tools.ts:460` 的 `tradewatcher_quotes` 描述补 `bond` |

## B. 安全删死代码

| # | 项 | 动作／核对 |
|---|---|---|
| 7 | 9 条真死导出 | 删除：`PasteDelimiter`（bulkPaste）、`invalidateChips`（chipsLoader）、`ChipsViewState`（chipsView）、`resetMountCounts`（mounts）、`ChipsLineKind`（theme）、`FQ_NOTE`（composition，连同比特它的旧注释）、`flowInflightKeys`（globalFlow）、`heldLocks`／`removeLockFileSync`（lock，后者注释自称"仅供退出钩子使用"而钩子直调 `unlinkSync` —— **说谎注释一并消失**） |
| 7 | 1 个零消费文件 | `scripts/rescue-thresholds.json`（219 行）删除：`grep -rn "rescue-thresholds.json" src build.mjs` → 0 读取方，`scripts/calibrate-rescue.mjs` 只写不读；`src` 侧 import 的是 `src/host/rescue-thresholds.ts` |
| 8 | 2 个死字段 | `model.ts` 的 `DataProvenance.marketState`／`.showing` 删除（全仓仅声明行命中；可选键 ⇒ 老数据/A 端不受影响） |
| 8 | 4 条死 CSS | `styles.ts` 的 `.tw-right`、`.tw-stat-sep`、`.tw-chips-decay`、`.tw-chips-bars` 删除；`.tw-chips-bars` 那段"条宽 % 分母"的说明**搬到** `.tw-chips-plot` 上方（说明不丢） |
| 9 | 硬编码 1.63 vs 标定 1.57 | **先核实**：`rescue-thresholds.ts` 的 `RESCUE_CALIBRATION.f1 = {mid:1.19, high:1.57, extreme:1.92}`、`pooled.p75/p90/p95 = 1.1913/1.5730/1.9208` ⇒ **标定值是对的**；`RescuePanel.tsx` 那个 1.63 是**更早一次标定的 P90**（README 旧文案同源）。面板用的是 `LEVEL_COLOR[3]`（极端档）配色 ⇒ 阈值应为**极端档 = 1.92**。改法：具名常量 `RESCUE_F1_EXTREME = 1.92` + 注释指向标定来源，并新增 `src/client/rescuePanel.test.ts`（跨文件同步断言：面板常量必须 == 标定 `f1.extreme`，且**不许回退到 1.63**） |

## C. 谨慎处理

| # | 项 | 动作 |
|---|---|---|
| 10 | 9 簇重复逻辑 | **合并了 2 簇（行为等价、有测试覆盖）**：⑤ `FQ_NOTE` 死表删除（与 `FQ_LABEL` 重复的那份）；⑨ `fmtPct` 内联的三元改为调用 `pctArrow`（同一套方向语义只留一份实现），`format.ts` 的全部断言仍绿。另做 1 处**零行为变更**的改名：⑦ `tones.ts` 的 `percentileOf` → `rankPctExclusive`（与 `breadth.ts` 同名同签名但并列口径不同；只改名与注释，`tones.test.ts` 断言数值一字未改）。**其余 6 簇按"有风险的不动"处理**（见未做项） |
| 11 | 30 个被删空的文件头 | 补回**被别处引用的 3 个**：`client/marketTime.ts`（`:24` 写"理由见文件头"）、`host/sina.ts`（`tencent.ts:33`/`:144`、`em.ts:1403` 指向它）、`host/tencent.ts`（自带"腾讯备用源"契约 + 国际指数无兜底的说明）；内容按 git 创建提交的原文件头复原**并更新到当前事实**（新浪新增 `hq.sinajs.cn`/汇率/美股日线原语、`int_*` 整族停用；腾讯新增 fqkline/板块/搜索端点）。顺带把 `sina.ts` 的 import 顺序摆正（文件头必须第一） |
| 12 | 15 条过期注释 | 逐条修正：`index.ts` 的 4 处失效行号引用（`rowOf :104-111`、`QuoteDrawer.tsx:79`、`MarketPage.tsx:84`、`WatchlistPage.tsx:89`、`alerts.ts:69`）**改为指函数/调用点而非行号**；`lock.ts:556` 说谎注释随死函数消失；`composition.ts:131` 指向死常量的注释随 `FQ_NOTE` 消失；`docs/DESIGN-CHIPS.md:52` 的 96 桶证据行号 `:123` → `:142`；`docs/STE-REVIEW-UI.md` 抬头加「已执行完毕（v0.51.0），行号基于当时 HEAD，勿逐条照做」 |

## 安全门禁核对（删代码前）

对 16 个待删目标逐个 `grep -c <name> build.mjs` ⇒ **全部 0**（9 个导出、2 个字段、4 条 CSS 类、`rescue-thresholds.json`）。
删完跑完整构建：**73 条锁定片段全部通过**（`built lib/index.js + lib/client.js （v0.77.0，客户端片段校验通过：73 项）`）
⇒ 没有"某片段只由被删代码提供"的情况，未触碰 `build.mjs`。

## 门禁（`npm run check`）

```
EXIT=0
ℹ tests 563   ℹ suites 0   ℹ pass 563   ℹ fail 0   （默认时区）
ℹ tests 563   ℹ suites 0   ℹ pass 563   ℹ fail 0   （TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
```
**末尾三行**：
```
> node build.mjs

built lib/index.js + lib/client.js （v0.77.0，客户端片段校验通过：73 项）
```
（562 基线 + 本轮新增 `src/client/rescuePanel.test.ts` 1 条 = 563。）

## 8. 权威性收敛（A5 的具体做法）

| 事实 | 唯一权威处 | 其它位置 |
|---|---|---|
| 组件行的清单/顺序/是否启用 | `cordis.patch.yml`（`:53-75`） | README／DESIGN-SUBPLUGINS **只留指针 + 行号**，不再复制清单 |
| 每行拥有哪些路由/工具 | `src/index.ts` 的 `ROW_ROUTES`/`ROW_TOOLS` | 文档描述判据（按实际调用方推导），不复写清单；判据本身由 `rowOwnership.test.ts` 守着 |
| 护盘阈值与标定数字 | `src/host/rescue-thresholds.ts`（`RESCUE_CALIBRATION`） | README 只报数值并注明"来源全部标注"，面板用常量 + 同步断言 |
| 历史事实（哪版改了什么） | `CHANGELOG.md` | 本批**只更正不重写**历史条目 |

## 未做项（不许读成"已修"）

| 项 | 理由 |
|---|---|
| 其余 6 簇重复逻辑（① 懒加载 JSON 骨架 ×4、② Tab 焦点陷阱 ×2、③ 北京时格式化 ×3、④ 裸 `toLocaleTimeString` ×10、⑥ 筹码线型类型三处、⑧ `fmtAmt`/`fmtBig` 缩写核） | 按 Lead 的"有风险的不动"：①③⑥ 是跨模块重构（④ 会**改行为** —— 非 UTC+8 浏览器上的显示时刻会变，风险 5）；⑧ 的差异（遮罩/精度）是**有意**的，合并收益仅一个 1e8 分支。全部保留原样并在此登记 |
| 其余 26 个空文件头 | 只补了"被别处引用"的 3 个。剩下 26 个：`git show <创建提交>:<file>` 都能复原，但内容需逐个核对是否仍成立（工作量与收益不成比例）；也**没有**改成"删空块"，因为空块是"这里丢过文档"的可见信号。清单见 REVIEW-1 §5.3 |
| CHANGELOG 的 C2–C7（`REQ-tools-component.md` 不存在、行数/计数差 1、`v0.69.1` 版本号在版本史里不存在等） | 本批只处理 Lead 点名的 C1。C2/C3 需要把需求文档入库（缺文件，无法凭改文档解决）；C6 的 `v0.69.1` → `v0.70.0` 是代码注释里的版本号，属"过期注释"但跨 5 处且需确认实际发布版本，留作下一批 |
| `docs/DESIGN-DASHBOARD.md` 移入 `docs/archive/`（REVIEW-1 §2） | 未在 Lead 的本批清单里；且它是"未落地设计"的历史存档，移动会牵动其它引用 |
| `escapeUpper()` 冗余分支（REVIEW-1 §6） | 改的是**构建门禁**本身（`build.mjs`），本轮硬约束是"零改动"，故不动 |
| `'后复权'` 弱锁增补真锚点（REVIEW-1 §6） | 同上：需要改 `build.mjs` 的片段表 |
