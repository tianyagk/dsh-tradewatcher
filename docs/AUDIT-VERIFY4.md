# 独立验收报告（可配置卡片 + 五国国债 + 五档 badge · 对抗验证）

> 验收人：`verify`。立场：**证明实现者说错了** —— 全部结论基于我自己跑的门禁、我自己构造的反例与 `git diff`/源码直读，不引用 `docs/AUDIT-IMPL7.md` 的数字。
> 对象：v0.39.0 工作区（6 文件改动 + 10 新增）。临时脚本 `/tmp/tw-v5/`（跑完删除）；写作用域仅本文件。

## 0. 结论：**不通过 —— 不应提交**

- **P0（新实测，实现者报告未覆盖）**：**可配置卡片的配置完全无法落盘** —— 宿主的 `setPrefs` 是逐字段白名单，**没有 `stripCfg` 分支**，客户端发出的 `{stripCfg:{hidden:[…]}}` 被静默忽略；`prefs.json` 里永远只有默认 `{hidden:[]}`。
- **五档算法本身是真的**：单调上行（末段加速）⇒ 过热、单调下行（末段加速）⇒ 过冷、边界 8 例、样本红线（0..35 全扫不许出现"适中"）、收益率取负方向相反、memo/冷却 —— 全部实测通过。
- 其余（171.* 契约、卡片外框、焦点陷阱、合规、门禁）逐条核对通过。
- 另有 2 条 P3 观察与 1 条"验收口径需修正"的事实（横盘序列并不必然给"适中"）。

## 1. 门禁（我自己跑的）

`npm run check`，exit=0：

```
ℹ tests 278  ℹ pass 278  ℹ fail 0     # 第一轮（本机时区）
ℹ tests 278  ℹ pass 278  ℹ fail 0     # 第二轮（TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
built lib/index.js + lib/client.js （v0.39.0，客户端片段校验通过：75 项）
```

交叉验证：`src/*/*.test.ts` 共 **35 个文件**、`test()` 计数合计 **278**，与运行数吻合。`git diff --stat -- build.mjs` **输出为空** → 零改动，75 项片段未删。

## 2. P0：配置无法持久化（不应提交的原因）

### 复现（我已实测）

```bash
node --test --experimental-strip-types /tmp/tw-v5/prefs.test.ts
```

```
[setPrefs 返回] {"hidden":[]}
[prefs.json 落盘] {"hidden":[]}
[重新装载] {"hidden":[]}
```

输入 `setPrefs({ stripCfg: { hidden: ['1.000001', '171.US10Y'] } })`（= 用户隐藏"中国国债"与"美国10Y"两张卡），**期望**落盘并读回该集合，**实际**三次都只有默认空集合 —— 断言 `deepEqual` 失败。

### 根因（`file:line`）

`src/host/store.ts:1000-1056` 的 `setPrefs(patch)` 是**逐字段白名单**：只处理 `theme / costBasis / refreshSec / redUp / panelOpacity / blurDigits / trendArchive / fxMode / fxRates / viewMode / watchSort / portSort / rescue`，**没有 `stripCfg` 分支**，随后直接 `commit([['prefs.json', this.prefs]])`。全仓 `grep stripCfg` 只命中 `shared/model.ts`（类型 + 默认值）、`client/TopBar.tsx`（读 `:375` / 写 `:613`）、`client/StripConfig.tsx`（注释）、`client/stripTone.ts`（注释）—— **宿主侧没有任何代码接受它**。

### 用户看到的现象（比"报错"更隐蔽）

`src/client/index.tsx:216-219` 的 `setPrefs` 是**乐观更新 + 静默吞错**：

```
setPrefsState((prev) => ({ ...(prev ?? DEFAULT_PREFS), ...patch }))   // 本地立刻生效
api.setPrefs(patch).catch(() => undefined)                            // 宿主拒绝被静默吞掉
```

→ 勾选/取消在**当次会话看起来完全正常**，但刷新页面或重启后**配置全部丢失**，且全程**没有任何提示**。这是"静默数据丢失"，属本项目红线的同类。

### 建议修法

在 `store.ts` 的 `setPrefs` 里补一段（放在 `rescue` 之前）：

```ts
if (patch.stripCfg !== undefined) {
  const hidden = Array.isArray(patch.stripCfg?.hidden) ? patch.stripCfg.hidden.filter((x) => typeof x === 'string') : []
  // 去重 + 上限，防手改文件塞进超长数组；未知 secid 由客户端 effectiveHidden 过滤（与装载宽容一致）
  this.prefs.stripCfg = { hidden: [...new Set(hidden)].slice(0, 400) }
}
```

并建议补一条断言：`setPrefs({stripCfg:{hidden:['1.000001']}})` → 重新 `new DataStore(dir)` 装载后仍读得回（即本次缺的那条回归）。

## 3. 五档算法：通过（`/tmp/tw-v5/tones.test.ts`，13/13）

| 项 | 实测输出 | 判定 |
| --- | --- | --- |
| 单调上行（末段加速） | `{"level":"过热","pct":99.6,"r30":43.04,"samples":250}` | ✅ 过热侧 |
| 单调下行（末段加速） | `{"level":"过冷","pct":0,"r30":-30.59}` | ✅ 过冷侧 |
| 边界 10/30/70/90 | `9.99→过冷，10→偏冷，29.99→偏冷，30→适中，70→适中，70.01→偏热，90→偏热，90.01→过热` | ✅ 八例全对 |
| `bars=30` | `level:null`、`why:"样本不足（现有 30 根日线，R30 需 ≥31 根）"`、`insufficient:true` | ✅ |
| `bars=3` | `level:null`、`why:"日线太少（3 根），无法计算"` | ✅ 明确原因 |
| **红线：任何缺失不许"适中"** | 扫 `bars=0..35` + 空序列 + 全零序列，`level` 恒非"适中"（全部为 `null` + 原因） | ✅ |
| **取负方向相反** | 同一序列：`kind=price → 过热(pct 99.6, r30 +43.04)`；`kind=yield → 过冷(pct 0, r30 −43.04)` | ✅ |
| 取负对称性 | 上行/下行两例：`pct_price + pct_yield = 99.6 ≈ 100` | ✅ |
| 取负只作用于变化量 | `tones.ts:157/158/176/177` 均为 `sign * r` / `sign * m`（对 **R30/MOM 值**取负），**没有**对 `closes` 序列取负 | ✅ 与自报的"第一版恒等变换"缺陷已修一致 |
| memo：同日第二次 | 调用数 `1 → 1`（不重拉）；跨日 `→ 2`（重算） | ✅ |
| 失败冷却 | 冷却期内调用数 `1`；过 10 分钟后 `→ 2` | ✅ |

### 一条需要修正的验收口径（不是实现缺陷）

任务期望"**横盘 ⇒ 适中**"。我用 20 个种子的确定性噪声横盘序列（250 根，围绕 100 摆动 ±0.5）实测：

```
适中 7/20，极端（过热/过冷）5/20，其它（偏冷/偏热）8/20
```

原因：档位是 **当前 score 在该标的自身历史分布中的分位**。横盘序列的"当前 30 日涨幅"仍是**单次抽样**，落在分布尾部（>90% 或 <10%）的概率本来就不低。所以：
- **算法按其定义是正确的**（相对自身历史确实极端）；
- 但"横盘 ⇒ 必然适中"这个验收描述**不成立**，建议改为"横盘序列应能落'适中'（存在即可），且不集中于单一档位"。
- 我另外验证了**匀速趋势**（恒定斜率，每 30 日涨跌幅相同）：上行 ⇒ `适中(pct 66.4)`、下行 ⇒ `偏冷(pct 28.4)` —— 当前点与历史同样极端，分位自然不极端，符合分位法语义。

## 4. 171.* 契约与 missing 语义：通过

| 项 | 实测 | 判定 |
| --- | --- | --- |
| 四个 `171.*` 的 `level` | 四个全 `null` | ✅ |
| `r30` 不许是 0 | 四个全 `r30: null`（`notEqual(0)` 通过） | ✅ |
| `pct` | 全 `null` | ✅ |
| `missing.why`（取不到） | 全 `transient` | ✅ |
| `missing.why`（样本/基准不足） | `insufficient` ⇒ `no-source`（`tonesService.ts` 三目；`bars=30`/`bars=3` 两例均 `insufficient:true`） | ✅ |
| 无代理指标 | `TW_ROWS` 的 bond 组 = `1.000012`(price) + 四个 `171.*`(yield)，共 5 项；`stripKindOf` 与行定义逐项一致；宿主侧无任何"用别的数据源顶替 171.*"的分支 | ✅ |
| `asOf/stale/source/day` 可渲染 | 路由回包含 `asOf`(时刻)/`stale`(bool)/`source:'em-kline'`/`day`，客户端 `api.tones` 的返回类型逐字段声明并消费（`TopBar` 读 rows） | ✅（渲染未实测） |
| 当根未收盘不入算 | `closedBars`：末根日期 === 今天 ⇒ 剔除（实测 `['2026-10-08']`） | ✅ |

## 5. 卡片外框 / 焦点陷阱 / 合规：通过

**外框（静态证据，逐像素需装机核对）**
- badge 绝对定位：`.tw-tone{position:absolute;top:4px;right:4px;height:14px;…}`（`styles.ts:431`）✅ 与设计一致
- **让位规则只在"有 tone"时生效**：`.tw-qcard[data-tone] .nm{padding-right:40px}`（`:435`）、`.tw-qcard[data-tone] .tw-qdot{right:42px}`（`:437`）—— 都是**属性选择器**；客户端 `data-tone` 在没有 tone 时传 `undefined`（`TopBar.tsx:558`）⇒ 属性不出现 ⇒ 规则不生效 ✅
- **没改卡片宽高**：`styles.ts` 的 diff 只新增 `.tw-tone` / `[data-tone]` 让位 / `.tw-cfg*` 与一条 blur 清单扩展；`.tw-qcard{…min-height:54px…}`（`:77`）**未出现在任何 `-` 行** ✅
- ⚠️ 我无法渲染：`right:4px;top:4px` 与 `padding-right:40px` 是否**逐像素**不遮挡价格/涨跌行、延迟绿点 `right:42px` 是否与 badge 恰好错开，**需装机核对**（这是静态推断，不是实测）。

**焦点陷阱（读代码，行为未实测）**
- `role:'dialog'` + `aria-modal:'true'` + `aria-labelledby`（`StripConfig.tsx:122-125`）✅
- 打开即聚焦首个控件：`el.querySelector('input,button')?.focus()`（`:50`）✅
- **Tab/Shift+Tab 在窗内循环**：首尾相接 + `!el.contains(active)` 时拉回（`:94-107`），并对 disabled 项过滤 ✅ 是真陷阱，不只是加属性
- Esc 关闭：`:89-92` `props.onClose()` ✅
- **焦点还给齿轮**：`TopBar.tsx:403` `gearRef`、`:614-617` `onClose: () => { … gearRef.current?.focus() }` ✅

**合规**
- badge 与配置窗数字在**两条** `data-blur=1` 清单里：`.tw-tone` 与 `.tw-cfg-count` 各出现在基线清单与 hover 清单 ✅
- 五档色值**无涨跌红绿字面量**：`#e5484d / #ff5f6d / #0e8f5c / #27a644` 在 `.tw-tone` 规则中计数 **0**；色系为靛蓝 `#2B4C9B` / 青 `#176B87` / 石板灰 `#5A6270` / 紫 `#7B3FA8` / 品红 `#A32C7A`（+ 深色主题五档）✅
- 未绕开既有着色通道：`TopBar` 的 `dirClass` 只用于 `quote.chg`（`:80`、`:546`），badge 走 `className:'tw-tone'` + `data-tone`（`:587`），两条通道没有混用 ✅

## 6. 其它发现（P3）

- **D2**：横盘序列的档位分布偏散（见 §3 末），建议把验收口径改成"能落适中且不集中于单一档位"。
- **D3**：`tonesService.ts` 的行序保持用 `rows.sort((a,b) => items.findIndex(…) - items.findIndex(…))`，是 O(n²) 且同 secid 重复时顺序依赖 push 次序；`ytd.ts` 用的是先建索引 Map 的写法，建议对齐。
- **D4**：`computeTones` 的 `missing` 用 `${secid} 状态` 作为 `what`，与行情出处契约的 `what` 写法（纯 secid）不同，客户端/工具做去重时可能对不上（本次未验工具侧消费）。

## 7. 未验证

1. **渲染层全部未跑**（本机无 react 运行时）：badge 的实际位置与遮挡、让位规则的实际效果、配置窗的拖动/焦点循环、两条模糊清单的实际模糊 —— §5 的外框结论是**静态证据**，逐像素需装机核对。
2. **焦点陷阱的运行时行为**：Tab 循环与 Esc 还焦只做了代码核对，没有在浏览器里按键验证。
3. **上游真实数据**：按要求不探活；171.* 的四条链路是否真不可达、`em-kline` 源的真实回包未验。
4. **工具/agent 侧是否消费五档**：本轮只看了客户端 badge 与 HTTP 路由，未检查 `tools.ts` 是否暴露五档（若有，其 `missing` 传参契约也未验）。

## 8. 复现

```bash
npm run check                                                          # §1
node --test --experimental-strip-types /tmp/tw-v5/prefs.test.ts        # §2（P0 复现）
node --test --experimental-strip-types /tmp/tw-v5/tones.test.ts        # §3 / §4
```

**P0 最小复现（一行）**：

```bash
node --experimental-strip-types -e "
process.env.DSH_HOME='/tmp/tw-v5/home';
import('/home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher/src/host/store.ts').then(async ({DataStore}) => {
  const s = new DataStore('/tmp/tw-v5/store');
  await s.setPrefs({ stripCfg: { hidden: ['1.000001'] } });
  console.log('读回 =', JSON.stringify((await new DataStore('/tmp/tw-v5/store').getPrefs()).stripCfg));
})"
# 期望 {"hidden":["1.000001"]}；实际 {"hidden":[]}（配置被静默丢弃）
```
