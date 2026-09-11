# dsh-tradewatcher（盯盘）

一个 DeepSeek Harness **Web 插件**：在 betterSidebar（`ctx.betterSidebar` 服务）注册一个「盯盘」页签，提供 A股/国际/商品行情条 + 悬浮分时图、内嵌大盘云图（52etf.site）、分组自选、流水驱动的分组持仓账本（市值/浮动盈亏/当日盈亏/已实现），并把持仓记录以**只读模型工具 + 明文 JSON 双通道**开放给 dsh 会话分析。

界面与数据组织参考浏览器插件「爱盯盘」（[52etf.site](https://52etf.site/)）；行情为免费公开接口的**延迟行情**（非 L2），仅作盯盘参考，不构成投资建议。

## 功能

- 顶部行情条（三行，每 10s 自动刷新 + 手动刷新，暂停于页签隐藏时）
  1. **A股指数**：上证指数、深证成指、创业板指、科创50、沪深300、中证500
  2. **国际市场**：韩国KOSPI200、法国CAC40、英国富时100、欧洲斯托克50、标普500、纳斯达克、德国DAX30、日经225、恒生指数
  3. **大宗商品**：生猪主连、焦煤主连、豆粕主连、螺纹钢主连、布伦特原油当月、COMEX铜、COMEX白银、伦敦金现
  - 每卡片：名称 / 现价 / 当日涨跌值 / 涨跌幅（红涨绿跌，浅色/深色/跟随系统主题可切换）
  - **hover 悬浮卡**：当天分时图（源缺失自动回退近 5 日收盘走势），附昨收基准虚线、最后行情时间与成交额
- **大盘云图**：内嵌 iframe `https://52etf.site/`（行业热力图、缩放钻取、约 8s 刷新；可重新加载/新窗口打开）
- 内部页签：
  - **自选**：分组的新建/改名/备注/删除（删除=归档，可恢复）+ 组内添加（名称/代码搜索补全）/移除/移动分组（搜索池：A股/港股/美股/ETF/基金/指数/期货主连，如 688825、02155）；A股行展示**所属行业板块名、板块当日涨幅**及**个股相对板块 alpha（个股涨跌幅 − 板块涨跌幅）**（行业归属 10 分钟缓存，板块涨幅随行情轮询同步刷新）
  - **分时缩略线与明细抽屉**：自选/持仓每行带当日分时缩略曲线，点击弹出右侧抽屉：固定信息头（名称/代码/现价/涨跌幅/所属行业板块及板块涨跌幅/今开/昨收/换手率/最高/最低/成交量/成交额/市盈率/总市值），图表为**三窗格专业图**：主图 + **成交量**（红绿柱、最大量标注）+ **MACD**（HIST 柱 + DIF/DEA 线，12/26/9，HIST=(DIF−DEA)×2），主图与子图均带**纵轴刻度线**（1/2/5×10ⁿ 步长）；K 线叠加 **MA5/10/30/60**（橙/蓝/紫/灰，附当前值图例，均线在全量序列上计算后再截取可视区间）；K 线下方为**日期宽度缩放窗**（双滑块缩放/平移 + 近1月/3月/6月/1年/全部 快捷键 + 当前区间与根数），图表内**滚轮可以光标为中心缩放**（最少 8 根）。分时主图另叠加**均价线**；五日图为 5 个交易日**连续拼接**（午休/隔夜已折叠，交易日之间画分隔线）。注意东财 `trends2` 的 `ndays` 参数会被上游忽略（只回当日），因此五日视图改用**5 分钟 K 线拼接**：新浪为主源（A股/ETF/指数，一次可取 6–8 个交易日）、腾讯 5 分钟 K 线兜底；港股等无多日分钟源的市场自动退回当日分时，图下注脚会如实显示交易日数量。
图上按持仓流水标注 **B/S 买卖点**（悬停显示「数量 @ 价格 · 分组/持仓」；周/月/年 K 把同周期多笔归并为 `B2`/`S3`），下方以 tab 切换 **分时 / 五日 / 日K / 周K / 月K / 年K**
  - **持仓**：分组 CRUD（同上归档语义）+ 组内证券的「买入/卖出/调整/编辑/移动/明细/移除」；每分组与总览显示**总市值、浮动盈亏、当日盈亏、累计已实现**；每行明细含 **浮动盈亏率与当日盈亏率**（口径见下）
  - **A股大盘**：六大指数 + 沪深两市涨跌家数/成交额统计；行业/概念板块涨跌排行与主力资金排行；ETF 排行；个股/基金搜索 + 详情卡（分时大图、换手/量比/市盈率/市值等）
  - **大盘云图**：见上

## 安装

前置：插件依赖宿主已挂载 `dsh-better-sidebar`（本机 web profile 一般已随其他聚合插件提供；`ctx.betterSidebar` 缺失时「盯盘」页签不会出现）。

```bash
# 1) 构建（lib/index.js + lib/client.js）
cd dsh-tradewatcher && npm install && npm run build   # 或 npm run selftest

# 2) 注册进 web profile（默认 ~/.dsh/profiles/web，可用 DSH_PROFILE_DIR 覆盖）
bash scripts/install.sh

# 3) 重启 dsh web 进程（必须：客户端 bundle 在启动时装载）
#    重启后打开 betterSidebar「+」菜单 → 大盘概览
```

卸载：`bash scripts/uninstall.sh`，然后同样重启 web。

> 插件为「双面」结构：主机半区（quote 中继、文件存储、`/tradewatcher/*` 路由、agent 工具）+ 浏览器半区（Tab UI），通过 `dsh.bundle.patch`（`cordis.patch.yml` 的 insert 行）随 bundle 自动挂载，无需手改 profile 的 cordis 配置。

## 数据与接口

### 数据文件（DSH_HOME 默认 `~/.dsh`）

| 文件 | 内容 |
| --- | --- |
| `~/.dsh/dsh-tradewatcher/watch.json` | 自选：`{ groups: [{id,name,order,archived?,note?}], items: [{id,groupId,secid,name,note?,createdAt}] }` |
| `~/.dsh/dsh-tradewatcher/positions.json` | 持仓：`{ groups:[…], items:[{id,groupId,secid,name,note?,createdAt}] }` —— **数量/成本不落盘，全部由流水推导** |
| `~/.dsh/dsh-tradewatcher/ledger.json` | 逐笔流水/审计（append-only）：`{v, entries:[{id,ts,actor,verb,groupId?,posId?,secid?,qty?,price?,fee?,note?,meta?}]}` |
| `~/.dsh/dsh-tradewatcher/prefs.json` | 主题/刷新间隔/配色偏好 |
| `~/.dsh/dsh-tradewatcher/quotes-lkg.json` | 行情 last-known-good 快照（每只证券最近一次有效读数，进程重启后仍可兜底，非账本数据） |
| `~/.dsh/dsh-tradewatcher/klines/<secid>_<周期>.json` | K 线本地缓存：首次查看一次性拉全量（日 800 / 周 400 / 月 240 根），之后每次只增量拉最新几根并合并；上游不可用时直接回退缓存 |

- `verb`：`buy`买入 / `sell`卖出 / `adjust`调整 / `add`新建持仓 / `remove`移除持仓 / `gcreate`新建分组 / `grename`改名 / `gdelete`归档 / `grestore`还原 / `gmove`移动或编辑 / `pnote`备注
- 成本口径：买入按移动加权（费用计入摊薄成本）；卖出确认已实现盈亏（费用于卖出时扣除）；当日盈亏 = 隔夜 `(现价−昨收)×数量` + 当日每笔买卖差额 − 当日费用；昨收取行情接口 `昨收`（期货主连按接口口径的昨结基准，见免责）
- 盈亏率口径：浮动盈亏率 = 浮动盈亏 ÷（摊薄成本×数量）；当日盈亏率 = 当日盈亏 ÷（期初数量×昨收 + 当日买入金额）；无法估值（无昨收等）时显示 —
- **成本口径可切换**（持仓总览面板右上角分段开关，偏好存 `prefs.json`）：
  - **摊薄口径（默认，与多数券商 App 一致）**：摊薄成本 = (累计买入含费 − 累计卖出净额) ÷ 剩余数量；持仓盈亏 = (现价 − 摊薄成本) × 数量，**已实现盈亏已折进剩余持仓成本**；卖出亏损会抬高摊薄成本，卖出盈利会压低（可能为负）。
  - **均价口径**：买入移动加权均价（卖出不改成本）；浮动盈亏单独显示，已实现盈亏另列。
  - 两者恒等关系：**摊薄持仓盈亏 = 均价浮动盈亏 + 累计已实现**。
- 价格与成本保留 4 位小数（ETF/基金等低价标的 0.948 不会被四舍五入成 0.95）。
- `secid` 为东财代码，格式 `市场.代码`：`1.600519`（沪A）、`1.688825`（科创板）、`0.300750`（深A）、`1.510300`（沪ETF）、`116.02155`/`116.00700`（港股）、`100.KOSPI200`（全球指数）、`114.lhm`（生猪主连）等

### 会话内分析（双通道）

1. **模型工具（只读，重启后对所有会话可见）**
   - `tradewatcher_portfolio` — 分组汇总 + 每只持仓（数量/成本/现价/市值/浮盈/当日/已实现）
   - `tradewatcher_ledger` — 逐笔流水，可按 `posId`/`groupId` 过滤（追溯完整交易过程）
   - `tradewatcher_watchlist` / `tradewatcher_quotes` / `tradewatcher_search` — 自选、实时行情、证券搜索（`cn`/`intl`/`commodity`/`all` 预设组）
   - 系统提示词已注册引导段落（插件在会话工具列表即显形，如出现工具名即说明挂载成功）
2. **明文 JSON 文件**：上述数据文件路径固定、格式如上，任何会话可用文件工具直接读取做离线分析/回溯校验

### HTTP 路由（同源，浏览器信任围栏保护，POST 校验 Origin）

`GET /tradewatcher/health|quotes?ids=|trend?secid=|kline?secid=|detail?secid=|suggest?q=|board?scope=&sort=&pn=&pz=`、`GET|POST /tradewatcher/watch|portfolio|prefs`、`GET /tradewatcher/ledger`

## 开发

```
src/
  index.ts            # 主机半区入口（路由 + 工具注册）
  host/em.ts          # 东财行情中继（push2delay/push2/push2his 多主机回退 + TTL 缓存）
  host/store.ts       # 文件存储 + 校验 + append-only 流水（纯函数可测）
  host/portfolio.ts   # 流水重放 → 持仓/分组/总览核算（纯函数）
  host/routes.ts      # /tradewatcher/* HTTP
  host/tools.ts       # tradewatcher_* agent 工具 + 提示词段落
  host/selftest.ts    # npm run selftest（核算断言 + 实时接口冒烟，网络项 soft）
  client/index.tsx    # 浏览器半区：ctx.betterSidebar.registerTab + 装配
  client/*.tsx        # TopBar/自选/持仓/A股大盘/云图 + SVG 分时图 + 悬浮卡
  shared/model.ts     # 两端共享类型 + 23 个固定代码
```

- 构建：`npm run build`（esbuild → `lib/index.js` ESM、`lib/client.js` CJS + `__ModuleLoader__` 工厂）
- 自测：`npm run selftest`（node 原生 TS，无需构建）
- 客户端在浏览器中的 `react`/`react-dom`/`cordis` 由 web shell 模块表提供（externals）；其余全部内联

## 已知边界与免责

- **K 线数据源**：腾讯历史 K 线为主（A股/港股/美股，稳定且快），东财 `push2his` 兜底（指数/期货等腾讯不覆盖的标的），两源统一**不复权**口径避免混源污染缓存；东财 `klt=104` 实际是季K，本插件的「年K」由月K本地重采样；历史接口的「200 + 空数组」按失败处理并切换数据源
- 行情来自东方财富免费公开接口（`push2delay` 主、`push2`/`push2his` 备；历史接口偶发限流会自动重试/降级）；延迟数据，盘中偶有缺口；国际指数与商品按源时区展示
- 接口瞬时缺价/漏返（实测东财会出现几十秒级的丢码窗口）时，主机侧按 **last-known-good** 回退：每次返回路径（新拉取/TTL/peek 命中）都做字段级回填，快照持久化到 `quotes-lkg.json` 跨重启生效，且单批缺码会先换备机补拉；客户端再保留已拉取旧值、空样本不回写——价格不会在“数字 / —”间闪烁；停牌等真实无价标的仍显示 —
- 分时图对没有当日分时的标的回退近 5 日日线；`push2his` 限流时悬停图可能短暂显示占位
- 期货主连「昨收/昨结」等口径字段随接口语义展示，若做精确期货结算对账请以结算单为准
- 持仓记账支持任意可报价标的；跨市场标的盈亏按接口币种金额展示，未做汇率折算（人民币资产无影响）
- 删除分组 = 归档（保留持仓与全部流水）；「移除持仓」要求数量为 0（先卖后移），保证流水完整可追溯
- 本插件不构成投资建议

## License

MIT
