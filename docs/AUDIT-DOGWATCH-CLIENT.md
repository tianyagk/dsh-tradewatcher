# 客户端审查：汪汪队跟踪（v0.185.0 → v0.188.0）

> 审查范围：`src/client/**`（`dogwatchView.ts` / `MarketPage.tsx` 汪汪队卡 / `styles.ts` 的 `.tw-dw-*`）。
> 基线：1487/1487 全绿、构建 73 项。只修 P0/P1，P2 只登记。

## 结论

- **P0：0 条**
- **P1：1 条**（已修，带反例注入）
- **P2：6 条**（只登记）

## P1（已修）

### P1-1 切窗时旧窗口数据挂在新 tab 下（无 loading 态）
- 位置：`src/client/MarketPage.tsx` 汪汪队 fetch effect（`api.dogwatch(dwWindow)`）。
- 问题：`dogwatch` 状态在切窗后仍保留上一个窗口的回包，直到新请求返回；期间 tab 显示「近3月」而图与表格仍是 1 年数据（最长一个往返）。
- 影响：用户会读到错窗口的数字；快速连点时更明显。
- 修法：effect 内 `setDwErr(null)` 后立即 `setDogwatch(null)` → 卡片进入「加载中」分支，新回包到达再渲染。卸载/旧请求由既有 `alive` 标志丢弃，不会旧盖新。
- 断言：`dogwatchAudit.test.ts`「P1-1」；注入删除 `setDogwatch(null)` ⇒ 判失败。

## P2（只登记）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| P2-1 | `MarketPage.tsx` 表格 `td title` | `title` 只在鼠标悬停可读，键盘不可聚焦 | 读屏/键盘用户拿不到缺值原因；后续可加 `aria-label` 或把原因并入单元格文本 |
| P2-2 | `styles.ts` `.tw-mk-*` | 删卡后仍残留若干 `.tw-mk-*` 规则（`tw-mk-empty` 仍在用） | 死 CSS，体积与维护成本；建议下一轮清理未引用类 |
| P2-3 | `MarketPage.tsx` | 切窗无骨架屏，只靠「加载中」一行 | 体验可再提升（骨架占位） |
| P2-4 | `dwSeries` | `line` 过滤掉非有限值后长度可能与 `bars` 不一致（x 轴不同步） | 正常回包不会触发；异常数据下折线与柱不对齐 |
| P2-5 | `MarketPage.tsx` | 已删模块（涨跌分布/分钟成交额）仍每次挂载发一次 `api.marketExtras`，结果只写进 `data-bars`/`data-limits` 调试属性 | 每次进页多一次上游聚合请求；**删它会改动路由账（market-extras 行归属）**，需与路由表同批处理，本轮不动 |
| P2-6 | `dogwatchView.dwTable` | 合计行的「规模」「份额变化」恒为 `—`（后端未给合计） | 与设计稿的 6,264.9 / −152.78 有差异；属数据缺口，不是计算错误 |

## 已核对（无问题）

1. **失败/加载**：`dwErr` 与 `dogwatch === null` 各有独立分支（一句原因 / 「加载中」），不渲染空表；`summary` 全 null 时四指标与合计全部 `—`（`dwNum` 对 null/NaN/Infinity 兜底）。
2. **空 series**：`dwBarsOf` 用 `Math.max(1e-9, ...[])` 防 `-Infinity`，`dwLineOf` 空数组直接返回 `[]`，两图都不崩、不画假点。
3. **动态行数**：`dwTable` 按后端 `rows` 映射（5 行 ⇒ 5 + 合计）；`sharesStale=true` 时**合计行**的「份额变化」同样 `—` + title。
4. **数字格式**：`sharesYi` 走 `dwNum`，`null/NaN/Infinity` ⇒ `—`，不会出现 `NaN`；涨跌/份额变化的符号类输出 `up/down`，颜色取自 `--tw-up/--tw-down`，`prefs.redUp` 反转时自动跟随。
5. **无障碍**：切窗 4 个档位是原生 `<button>`，键盘可达；670px 下表格在 `.tw-dw-tscroll` 内横滚，口径小字在该容器之外，不会被遮住。
