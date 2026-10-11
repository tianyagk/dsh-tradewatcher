# 独立验收报告（「下一轮」A+B 批次 · 对抗验证）

> 验收人：`verify`。立场：**证明实现者说错了** —— 结论基于我自己跑的门禁、我自己构造的反例、以及隔离副本注入实验；不引用 `docs/AUDIT-IMPL9.md` / `AUDIT-IMPL10.md` 的数字。
> 对象：v0.41.0 工作区。临时脚本/副本 `/tmp/tw-v7/`（跑完删除）；写作用域仅本文件。

## 0. 结论：**有条件通过**（2 条建议本批修掉，均不阻塞提交）

- **D1（P1）`deleteLedger` 用子串匹配而不是前缀**：契约写的是"按 note **前缀**反删"，实现是 `note.includes(prefix)`。用任务点名的形态实测：`notePrefix='批量录入#1'` 把 `批量录入#1`、`批量录入#12`、`批量录入#1x` **三条一起删了**。真实批次标记是 `批量录入#<base36 时间戳>`（8 位定长），我实测两个不同批次**不会**互相误伤 ⇒ 当前不可达，但误删是**不可恢复的数据丢失**，且修法是一行（`startsWith`）。
- **D2（P1）Markdown `**` 泄漏回归**：去注释后字符串内命中 **25 处**（工具 description / `methodology` / `disclaimer`），是历史 P0-4 同类问题的回归（本项目此前已清零过一次）。
- **其余全部实测通过**：信号前瞻手算 5 例、做T 3 轮/方向/不齐/自洽、分组桶回归（+3.14 不再极冷）、滞后告警 8 例（含"不触发"）、工具索引断言非恒真（副本注入实测）、批量录入分隔符等价与写入→撤销往返、合规与门禁。

## 1. 门禁（我自己跑的）

```
ℹ tests 319  ℹ pass 319  ℹ fail 0     # 第一轮（本机时区）
ℹ tests 319  ℹ pass 319  ℹ fail 0     # 第二轮（TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.41.0，客户端片段校验通过：75 项）
```

交叉验证：`src/*/*.test.ts` 共 **42 个文件**、`test()` 合计 **319**，与运行数吻合。`git diff --stat -- build.mjs` **输出为空** → 零改动，75 项片段未删。

## 2. `deleteLedger`（B 的越界改动）—— 核心发现在这里

**① 任务点名场景：确认误删**（`/tmp/tw-v7/deleteLedger.test.ts`）

```
[删除前] 批量相关 note = ["批量录入#1","批量录入#12","批量录入#1x"]
调用 deleteLedger({ notePrefix: '批量录入#1' })
[删除后] 剩余 note = ["手工录入","撤销批量录入：反删 3 条交易流水（…、…、…）"]
[删除后] 存活的批量 note = []
```

**预期**（契约 = 前缀语义）：只删 `批量录入#1`，`#12` 与 `#1x` 保留。
**实际**：三条全删（`removed.length = 3`）。根因在 `store.ts` 的 `case 'deleteLedger'`：

```ts
this.ledger.entries.filter((e) => set.has(e.id) || (prefix !== null && typeof e.note === 'string' && e.note.includes(prefix)))
```

`includes` 是**子串**匹配，`批量录入#12`.includes(`批量录入#1`) === true ⇒ 被误删。
**建议修法**：把 `e.note.includes(prefix)` 改成 `e.note.startsWith(prefix)` 或 `e.note.split(/\s+/).includes(prefix)`（后者更稳：批次标记是 note 里以空格分隔的一个词）。

**② 真实批次标记（base36）下不误伤** ✅ —— 这是当前路径的实际安全性证据：

```
[标记] A = 批量录入#mv386ri6  B = 批量录入#mv3abxa6   A 是 B 的前缀? false
[删除 A 后] 剩余 = ["批量录入#mv3abxa6","批量录入#mv3abxa6", ...]
```

（`BulkPaste.tsx:68` 的 `batch = \`批量录入#${Date.now().toString(36)}\`` 是同长度字符串，互不为前缀。）

③ **留痕** ✅：删除写一条 `pnote`（`撤销批量录入：反删 N 条交易流水（id…）`），且该 pnote **不会**被同前缀二次删除；再次撤销报 `没有匹配的流水 id（可能已经撤销过）`。
④ **删后核算自洽** ✅：删前 `{qty:150, avg:13.3333, mv:1800}` → 删后 `{qty:100, avg:10, mv:1200}`（`assemblePortfolio` 复算正确）。
⑤ **老账本仍能读** ✅：手写含旧 `actor:'tool'` 记录的 `ledger.json` → 读入 2 条、`actor` 保留、文件未被自动改写。
⑥ **契约边界** ✅：`ids`/`notePrefix` 都缺 ⇒ 报错；未匹配 ⇒ 明确错误；空前缀 ⇒ 报错。
⑦ **按 ids 反删** ✅：只删指定 id，持仓 qty 从 30 回到 10。

⚠️ **D3（P3）**：`model.ts` 注释写"删掉的原件写进 writeLog，可从那边恢复"，但实现只写**id 列表**（不含 qty/price/ts）⇒ 实际上**恢复不了**。注释与实现不符，建议要么补写原件摘要，要么改掉注释。

## 3. 信号前瞻（`signalForward.ts`）—— 手算 5 例全对

| 例 | 我的构造 | 手算期望 | 实测 |
| --- | --- | --- | --- |
| 涨 | 信号 01-02；bars 01-05=100…01-09=110；基准 200→204 | ret +10%、bench +2%、excess +8%、holdDays 7、holdTradingDays 4 | 全部吻合 ✅ |
| 跌 | 信号 02-01；100→90；基准 200→198 | −10% / −1% / −9% | 吻合 ✅ |
| 退化（信号日=最新日） | 信号 03-06、最后一根也是 03-06 | `retPct: null`、`holdDays: 0`、why 写"持有期 0" | ✅ **不是 0** |
| 基准缺失 | `benchBars = []` | `benchPct: null`、`excess: null`、retPct 仍可算 | ✅ 不当 0 |
| 样本 <10 | 2 个事件 | summary 标注"样本过少（2 < 10），不构成统计结论" | ✅ |

**"基准与持有期同时出现"** ✅（两者都非 null 时才给 excess）。**disclaimer** 实测为否定式：`这是"过去 N 次信号之后发生了什么"的…不是"信号有预测能力"。不能用来干什么：不能当作买卖信号、不能外推将来、不能证明因果` ✅（D2 的 `**` 问题见 §9）。

## 4. 做T（`dayTrade.ts`）

- **同日两轮 + 次日一轮 = 3** ✅（实测 `rounds = 3`，不是 2）
- **先卖后买** ✅：`direction: 'sell-first'`，与被渲染方向一致
- **数量不齐** ✅：买 200 卖 100 ⇒ `rounds[0].qty = 100`，`unmatched = [{verb:'buy', qty:100}]`（自己算过：剩 100 股买未配对）
- **净盈亏自洽** ✅：`毛 200 − 费 10 = 净 190`；汇总 `netPnl = 190` = 各轮之和

## 5. 分组排序（`groupRank.ts`）—— 首版错数的回归已修

```
[分位桶] bucketOf(3.14) = 极冷      ← 第一版的错误形态：涨跌幅被套进分位桶
[涨跌桶] returnBucketOf(3.14) = 上涨 ← 修复后的正确口径
[分组结果] [{"甲":"上涨"},{"乙":"平盘"},{"丙":"下跌"}]
[药丸] [{上涨:1},{平盘:1},{下跌:1}]  sum = 3 = 总数 ✅
```

**调用点也核对过**：`tools.ts:1023` `rankOf(rows, notes, by === '涨跌幅' ? returnBucketOf : undefined)` —— **按口径显式传桶函数**，不是只加了个函数 ✅。分位口径（`bucketOf`）只用于分位类指标。

## 6. 滞后告警（`lagAlertOf`）—— 8 例，含"不许恒输出"

```
[11 天前（日频）] → 数据更新滞后：X 最新 2026-05-30，落后 11 天     ✅ 触发
[45 分钟前（分时）] → … 落后 45 分钟                              ✅ 触发
[2 天前（日频）] → null（不输出）                                  ✅ 不触发
[5 分钟前（分时）] → null（不输出）                                ✅ 不触发
[asOf=null] → null（不输出）                                      ✅ 不触发
[asOf 在未来（时钟偏差）] → null（不输出）                          ✅ 不触发
[3 天整 / 30 分钟整（边界）] → 都触发                              ✅ 边界含等号
```

不是恒输出（6 种不触发路径实测为 `null`）✅。

## 7. 工具索引断言非恒真（隔离副本注入）

基线（干净副本）：`toolIndex.test.ts` **2/2 pass**。
往副本的 `tools.ts` 注入一个假工具 `phantom_probe`（README 不动）后：

```
✖ README 工具索引与 tools.ts 的 defs 完全一致（名字与数量）  → actual ≠ expected
✔ drift 断言真的会抓：加一个假工具就不一致
```

→ 主断言**确实会失败**（非恒真）✅。测试文件里另有一条自证断言（拿注入的假源码字符串跑）也通过。工作区未被注入（副本已删）。

## 8. 批量录入（`bulkPaste.ts` + 模态）

- **分隔符逐字段等价** ✅：`|`、`｜`（全角）、制表符、`,`、` , `（带空格）五种变体解析出的行（除 `raw`/`line`）**逐字段一致**，`errors = 0`
- **解析失败逐行报错 + 保留原文** ✅：3 行输入 → `rows=1`、`errors=2`，原文被保留：`{"line":2,"raw":"坏行没有分隔符","message":"列数不足（需要 5 列…实际 1 列）"}`、`{"line":3,"raw":"0.300750|宁德|2026-06-01|50|abc","message":"价格「abc」不是正数"}`
- **写入 → 撤销往返一致** ✅（临时 DSH_HOME + 真实 `mutatePortfolio`）：写入 3 条带批次标记的流水后 `流水=5 / qty=30 / avg=11`；`deleteLedger(notePrefix=batch)` 后 `流水=3（= 写入前 2 条 + 1 条留痕 pnote）/ qty=0` —— 持仓与交易流水都还原 ✅

## 9. 合规

| 项 | 证据 | 判定 |
| --- | --- | --- |
| B 的新数字面在**两条**模糊清单 | `styles.ts:147`（基线清单）与 `:161`（hover 清单）都含 `.tw-review-bline, .tw-daytrade-table td, .tw-bulk-table td, .tw-bulk-sum` | ✅ |
| 着色走 `dirClass` | `PortfolioPage.tsx` 新增段：`className: \`tw-num ${dirClass(r.netPnl, props.redUp)}\`` | ✅ |
| `BulkPaste.tsx` 无裸色值 | 该文件中 `dirClass/toneClass/var(--tw-up)/#rrggbb` **零命中**（表单与预览不着色） | ✅ |
| **D2：`**` 泄漏回归** | 去注释后字符串内 **25 处**命中（`tools.ts:901/902/1041/1043/1166/1167`、`ytd.ts:19` 等）；本项目此前已把这类文案清过一次 | ⚠️ P1 |

## 10. 发现汇总

- **D1（P1，建议修）**：`deleteLedger` 的子串匹配（`includes`）与契约（"前缀"）不符；任务点名形态下**会误删**（实测三条全删），当前 base36 路径不可达；修法一行。
- **D2（P1，建议修）**：`**` 文案泄漏 25 处（工具 description / methodology / disclaimer），历史 P0-4 同类回归。
- **D3（P3）**：`deleteLedger` 的留痕只记 id、不含原件，注释声称"可从 writeLog 恢复"与实现不符。

## 11. 未验证

1. **渲染层**：批量录入模态、做T 表格、分组药丸、告警行的实际排版与交互未跑（本机无 react 运行时）。
2. **`deleteLedger` 的 500 条上限**与 `dayTrade` 的多持仓交叉配对只做了代码阅读，未构造大数据。
3. **前复权/上游数据**：按要求不探活；本轮验证全部用注入/临时 DSH_HOME。
4. **`marketState`/`showing` 仍未接线**：本轮未复查（上一批已确认只落类型）。

## 12. 复现

```bash
npm run check                                                     # §1
node --test --experimental-strip-types /tmp/tw-v7/deleteLedger.test.ts   # §2（① 即 D1 复现）
node --test --experimental-strip-types /tmp/tw-v7/batch2.test.ts         # §3–§6
node --test --experimental-strip-types /tmp/tw-v7/bulk.test.ts           # §8

# §7 工具索引非恒真（隔离副本，不动工作区）
mkdir -p /tmp/tw-v7/repo && cp -r src tsconfig.json package.json README.md /tmp/tw-v7/repo/ \
  && ln -sfn "$PWD/node_modules" /tmp/tw-v7/repo/node_modules
cd /tmp/tw-v7/repo && node --test --experimental-strip-types src/host/toolIndex.test.ts   # 基线 2/2
# 往 src/host/tools.ts 的 quotes 定义前插一个 `${PREFIX}phantom_probe` 工具后再跑 → 主断言失败
```

**D1 最小复现（一条命令，我已实测：输出"删除后剩余的买入流水 note = []"）**：

```bash
node --experimental-strip-types -e "
process.env.DSH_HOME='/tmp/mini/home';
import('<repo>/src/host/store.ts').then(async ({DataStore}) => {
  const s = new DataStore('/tmp/mini/store');
  await s.mutatePortfolio({op:'addGroup', name:'G'});
  const gid = s.portData().groups[0].id;
  await s.mutatePortfolio({op:'addPos', groupId:gid, secid:'1.600519', symbolName:'茅台'});
  const pid = s.portData().items[0].id;
  const T0 = Date.now() - 9*86400000;
  for (const [i, note] of ['批量录入#1','批量录入#12','批量录入#1x'].entries())
    await s.mutatePortfolio({op:'buy', posId:pid, qty:10, price:10, ts:T0+i*1000, note});
  await s.mutatePortfolio({op:'deleteLedger', notePrefix:'批量录入#1'});
  console.log('剩余买入流水 =', JSON.stringify(s.ledgerEntries().filter(e=>e.verb==='buy').map(e=>e.note)));
})"
# 期望 ["批量录入#12","批量录入#1x"]；实际 []（三条全删）
```
