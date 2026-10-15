# RECON-52ETF —— 「爱盯盘-股票盯盘-基金助手」+「大盘云图-A股热力图盯盘」浏览器扩展只读侦察

- 侦察时间：2026-10-15 15:15–15:25（Asia/Shanghai）
- 侦察对象：官网 `https://52etf.site/`、Chrome/Edge 商店条目、扩展包本体（`.crx`）
- **本轮只做三件事**：① 下载扩展包到 `/tmp/recon52-*`；② 静态解压+阅读（读包内代码/CSS/manifest）；③ 读官网公开静态资源与条款页。
  **未安装任何扩展、未改动浏览器、未运行其任何代码、未发起任何需要账号的请求、未对 robots.txt 禁止的路径发请求。**
- 唯一写入：本文档。`src/**` 未改，未 commit，未装 bundle，未动 profile，未重启服务，未在工作区跑 `npm run build`。
- 证据约定：**实测可得** = 本次真跑过并附命令；**实测不可得** = 真跑过但失败/被拒（附命令与输出）；
  **未确认** = 没跑过或静态读不出，**不得当结论**（另附合规确认方法）。

---

## ① 结论（可得 / 不可得 / 未确认）

| 项 | 判定 | 一句话 |
|---|---|---|
| 扩展包本体（两个扩展） | **实测可得** | 商店直连被网络挡（Chrome 走代理 TLS 失败、Edge 端点 500），**第三方只读镜像**（极简插件，robots 允许全站）拿到包：爱盯盘 v2.36.0（**89 个文件**，zip 条目 93 = 89 文件 + 4 目录）、大盘云图 v3.5.6（5 文件） |
| 数据源接口清单 | **实测可得（静态阅读）** | 包内**没有**自建行情后端：行情全部直连东方财富/新浪/天天基金的**公开接口**，另有 1 个自家 Cloudflare Worker 中继作为第三档兜底 |
| 需要「账号令牌」的接口 | **实测不可得（按边界不尝试）** | 仅 4 个自家接口（微信扫码登录 + 云端记录/昵称）；行情/K线/分时/自选/持仓**均不需要登录** |
| 行情接口的**实弹请求** | **实测不可得（robots 禁止）** | `push2*.eastmoney.com/robots.txt` = `User-agent: * / Disallow: /` ⇒ 按边界不发请求，字段语义改由**包内显式映射**确认 |
| UI/UX 方案 | **实测可得** | 亮色主题令牌、暗夜玻璃浮窗令牌、官网暗色主题令牌、窗口尺寸、字号阶梯、动效曲线、栅格与图表类型全部可从包内 CSS/HTML 与官网静态资源读出（均为**数值事实**，非实现复制） |
| 官网大盘云图（TreeMap）内部算法阈值 | **未确认** | 站点 `TreeMap-*.js` 是**混淆代码**（`_0x…` 字符串表）⇒ 不运行其代码就读不出标签/色阶阈值 |
| 是否存在付费功能 | **未确认（倾向"无"）** | 包内搜不到 `会员/付费/订阅/购买/激活码/license` 等字样；只找到"登录后可使用云端同步、股价通知与备份记录管理"，**未**发现付费墙证据（不等于不存在） |

**接口条数小结（与 §2 两张表逐行对应）**：
- §2.1「不需令牌」表 **14 行**，其中第 14 行与第 1 行**同路径同参数**（另一个扩展的调用方）⇒ **去重后 13 条**：
  东方财富 9 条（行情/K线/分时/搜索/资讯/图片/K线分享图/ETF持仓/基金 API）、新浪 1 条、天天基金 1 条、自家 Cloudflare Worker 中继 1 条、腾讯云 COS 签名图 1 条。
- §2.2「需令牌」表 **4 条**，全在 `52etf.site/api/*`（微信扫码登录 + 云端记录/昵称）。
- **合计：需令牌 4 条 / 不需令牌 13 条（去重后），共 17 条。**

---

## ② 接口清单表

### 2.1 不需令牌（行情数据面；判定依据＝包内参数照录，**未做实弹请求**，原因见 §5.1）

| # | 地址 | 参数（照录/要点） | 需令牌 | 实测结果 | 命令 |
|---|---|---|---|---|---|
| 1 | `https://{push2delay\|push2\|push2delay2}.eastmoney.com/api/qt/ulist.np/get` | `fltt=2`、`fields=f12,f13,f14,f2,f3,f6,f20,f25`、`secids=<逗号>`、`_=<ts>`（批量 80 个 id 一组） | 否 | 静态阅读（robots 禁止实弹） | 见 §附录A-3 |
| 2 | 同上 3 台 + 分片主机 `/api/qt/clist/get` | `pn`、`pz=1000/2000/300`、`po=1`、`np=1/3`、`fltt=2`、`invt=2`、`fid=f3\|f20`、`fs=m:90+t:3` 等、`ut=b2884a393a59ad64002292a3e90d46a5` | 否 | 静态阅读 | 同上 |
| 3 | `https://{push2his}.eastmoney.com/api/qt/stock/kline/get` | `secid`、`klt`（见 §2.3 周期表）、`fqt=1`、`end=20500101`、`iscca=1`、`forcect=1`、`lmt=<N>`、`fields1=f1,f2,f3,f4,f5`、`fields2=f51,f52,f53,f54,f55,f56,f57,f59`、`ut=f057cbcbce2a86e2866ab8877db1d059` | 否 | 静态阅读 | 同上 |
| 4 | `/api/qt/stock/trends2/get`（分时走 push2delay，五日走 push2his） | `secid`、`fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13,f14`（五日再 `,f17`）、`fields2=f51,f53,f56,f58`、`iscr=0`、`iscca=0`、`ndays=1\|5` | 否 | 静态阅读 | 同上 |
| 5 | `https://searchapi.eastmoney.com/api/Info/Search` | `appid=el1902262`、`type=14`、`token=CCSDCZSDCXYMYZYYSYYXSMDDSMDHHDJT`、`and14=MultiMatch/Name,Code,PinYin/<kw>/true`、`returnfields14=Name,Code,PinYin,MarketType`、`pageSize14=20`、`isAssociation14=false1640928200409` | 否 | 未发起（robots 404＝未声明；按保守策略不请求） | 见 §附录A-4 |
| 6 | `https://search-api-web.eastmoney.com/search/jsonp` | `cb=`（JSONP）、`param={"uid":"","keyword":…,"type":["cmsArticleWebOld"],"client":"web",…}`（资讯流，每页 20 条） | 否 | 未发起（同上） | — |
| 7 | `https://webquotepic.eastmoney.com/GetPic.aspx` | `imageType=QC`、`nid=<代码>`、`token=44c9d251add88e27b65ed86506f6e5da1`、`timespan=<10 秒对齐的 unix 秒>`（K线分享图） | 否 | 未发起 | — |
| 8 | `https://fundf10.eastmoney.com/FundArchivesDatas.aspx` | ETF 持仓页参数 + 必带 `Referer: https://fundf10.eastmoney.com/` | 否 | 未发起 | — |
| 9 | `https://fundgz.1234567.com.cn/js/<code>.js?rt=<ts>` | 天天基金**场外估值**（JS 变量回包） | 否 | 未发起 | — |
| 10 | `https://fundmobapi.eastmoney.com/…`、`https://dataapi.1234567.com.cn/…` | 固定串 `deviceid=Wap&plat=Wap&product=EFund&version=2.0.0` | 否 | 未发起 | — |
| 11 | `https://money.finance.sina.com.cn/…` | 新浪行情/分时兜底（`ne()` 组参） | 否 | 未发起 | — |
| 12 | `https://noisy-disk-b11f.yxbzcy.workers.dev/<service>/<path>` | **自家 Cloudflare Worker 中继**：K线/板块的第三档兜底（`${worker}/${push2his}/api/…`） | 否 | 未发起（第三方中继，行为不可静态确认） | — |
| 13 | `https://7072-prod-…-1434263518.tcb.qcloud.la/m5kh.png?sign=…&t=…` | 腾讯云 COS **签名图**（公众号二维码），签名由服务端签发 | 否（签名在 URL 里） | 未发起 | — |
| 14 | `https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f13,f14&secids=1.000001` | **另一个扩展（大盘云图）唯一接口**：工具栏角标显示上证指数涨跌幅 | 否 | 静态阅读（该文件是**未混淆**的自研 JS） | 见 §附录A-5 |

> 主机池（故障转移用）照录：`push2delay` 链 = `push2.eastmoney.com` → `push2delay.eastmoney.com` → `push2delay2.eastmoney.com`；
> `push2his` 链 = `push2his.eastmoney.com` → `push2delay2.eastmoney.com`；另有**编号分片主机** `1.push2.eastmoney.com`、`33.push2his.eastmoney.com`、`63.push2his.eastmoney.com`（写死在健康探测里）。
> 主机健康状态用 `{host, at}` 落 `chrome.storage`，TTL **180 s**；失败即换下一台，三档全挂再走 Worker 中继。

### 2.2 需令牌（自家后端；**只记录，不尝试**）

| # | 地址 | 方法 | 令牌 | 用途（包内文案） | 实测结果 |
|---|---|---|---|---|---|
| T1 | `https://52etf.site/api/wechat-qrcode` | GET | 无（取二维码） | 微信扫码登录第一步 | **未发起**（robots 禁止 + 账号边界） |
| T2 | `https://52etf.site/api/wechat-qrcode-status` | GET | 无 | 轮询扫码状态（`expired` → "二维码已失效"） | 未发起（同上） |
| T3 | `https://52etf.site/api/wx-user-name` | GET/POST | `Authorization: Bearer <JWT>` | 昵称读取/设置 | 未发起（需登录） |
| T4 | `https://52etf.site/api/data-records` | GET/POST/DELETE | `Authorization: Bearer <JWT>` | 云端同步/备份记录管理（`page`、`pageSize≤20`） | 未发起（需登录） |

- 令牌形态：**JWT**（三段式，包内解出 `exp` 判过期；401 ⇒ 提示"登录已失效，请重新扫码"），存 `chrome.storage`。
- 触发登录的文案（包内照录）：`当前未登录` / `登录后可使用云端同步、股价通知与备份记录管理等功能。` / `请使用微信扫码并关注公众号完成登录`。
- **边界执行**：按任务硬边界 ①，这些接口**一个请求都没发**；也不需要绕过任何鉴权（行情面本来就不要登录）。

### 2.3 周期/参数映射（照录，供我们对齐口径）

| 周期 | `klt` | 周期 | `klt` |
|---|---|---|---|
| 分时 | 1 | 120分 | 120 |
| 五日 | 5 | 60分 | 60 |
| 日K | 101 | 30分 | 30 |
| 周K | 102 | 15分 | 15 |
| 月K | 103 | 5分 | 5 |
| 季K | 104 | 年K | 106 |

- `lmt` 计算（照录逻辑）：`lmt ≤ 100 ? lmt : lmt*4`，再 `max(400, 该值+400)` ⇒ **请求 240 根日K 时实际向上游要 1360 根**（一次多取、之后切片的取数策略）。
- 缓存节拍（包内常量）：分时/五日结果缓存 **60 s**；主机健康 TTL **180 s**；请求超时 **5 s / 10 s** 两档；`credentials` 模式 `auto|on|off`（见 §5.5）。

---

## ③ 字段语义

### 3.1 已确认（**包内显式映射**，不是猜的）

| 字段 | 语义 | 依据（包内可核） |
|---|---|---|
| `f2` | 最新价 | 行映射里 `price` ← `f2`；大盘云图后台 `price: item.f2` |
| `f3` | 涨跌幅（%） | 行映射里 `changePercent` ← `f3`；角标 `pct: item.f3`，且 `< 0.05` 视为 0 |
| `f12` | 证券代码（6 位/字母） | `code` ← `f12`；secid 由 `f13 + '.' + f12` 拼 |
| `f13` | 市场号（1=沪 0=深 116=港 105/106/107=美） | `f13` 参与拼 secid；代码注释写明"市场 1 + 代码 000001" |
| `f14` | 名称 | `name` ← `f14` |
| `f6` | 成交额 | 行映射里 `volume` ← `f6`（**注意：命名叫 volume，语义是成交额**） |
| `f20` | 总市值 | `marketValue` ← `f20` |
| `f25` | 年初至今涨跌幅（%） | `ytdChangePercent` ← `f25` |

### 3.2 字段清单（照录，供我们按需裁剪）

- 行情批量：`f12,f13,f14,f2,f3,f6,f20,f25`（自选/热力图口径）。
- 涨跌分布/板块成分用的**长字段串**（照录）：`f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f24,f25,f22,f11,f62,f128,f136,f115,f152,f100,f103`。
- K线：`fields1=f1,f2,f3,f4,f5`、`fields2=f51,f52,f53,f54,f55,f56,f57,f59`（字段顺序照录；**逐位语义未在包内确认**，见 §3.3 与 §6#2）。
- 分时：`fields2=f51,f53,f56,f58`（时间、价、量、均价）；五日另取 `fields1` 加 `f17` 并读 `data.hisPrePrices.length` 判"真多日"。
- 角标：`f2,f3,f12,f13,f14,f18,f6,f124` + 用户自定义字段。

### 3.3 未确认（**不得当结论**）

- **`f18`（我们怀疑是昨收）、`f124`（怀疑是行情时间戳）**：包内只在角标字段串里出现、无映射注释；本次**没发实弹** ⇒ 未确认。
- **`f8 / f9 / f10 / f15 / f16 / f17 / f22 / f23 / f24 / f62 / f100 / f115 / f128 / f136 / f145 / f152 / f265 / f266` 的确切语义**：包内只有取用、没有映射注释；本次**没发实弹**（robots 禁止）⇒ 只能标注为未确认，确认方法见 §6。
- 长字段串里 `f62`（界面文案里出现"资金流入"）与 `f115`（"市盈率"）的对应关系属于**邻近文本推断**，未达"已确认"标准，故不写入 §3.1。

---

## ④ UI/UX 方案要点（可检查的阈值）

> 以下是**数值事实**（令牌值、尺寸、时长），用于我们做**自己的**实现；不复制其结构代码与命名体系。

### 4.1 形态与窗口（可核对）

| 形态 | 尺寸/位置 | 依据 |
|---|---|---|
| 工具栏弹窗（`default_popup`） | `index.html`（与主界面同一个 Vue 应用） | manifest |
| 独立"主界面"窗体 | **800×620**，`top:160 left:360`，`type:'popup'`，窗口 id 持久化复用 | 后台窗口预设 |
| 迷你/悬浮窗体 | **200×270**，同位置，`suspend.html` | 同上 |
| 网页内浮窗 | 注入到**任意页面左下角**（设置文案"注意浏览器左下角的数据"），可整页开关 | content script |
| 角标 | 每分钟（`chrome.alarms`，最小 1 分钟）更新涨跌幅；红涨绿跌 | 大盘云图后台 |
| 侧栏/角标字段 | 用户可选字段 ≥1 个（"至少需要显示一个字段"） | 设置文案 |

### 4.2 亮色主题令牌（爱盯盘主界面，照录关键值）

| 类别 | 值 |
|---|---|
| 涨/跌 | `--stock-up-color:#f22423`、`--stock-down-color:#00a000`（**红涨绿跌**） |
| 热力/底色块 | `--stock-bg-up:#e3534f`、`--stock-bg-down:#56b779` |
| 价格闪烁 | up `rgba(242,36,35,.1)`、down `rgba(0,160,0,.09)`，`--price-flash-duration:1s` |
| 主题色 | `--theme-color:#6b3eee`、`--theme-bg-color:#ebe4fd`、左栏 `#fafafa` |
| 表格 | 表头 `#fafbfc`、悬浮行 `#f5f1fe`、边框 `#f0f1f2` |
| 文本/图标 | 图标 `#727a85`、未选中页签 `#989cb8` |
| 涨跌 chip | up 底 `rgba(227,83,79,.14)`/字 `#c93a36`；down 底 `rgba(86,183,121,.15)`/字 `#2d8b51` |
| 折线/迷你图 | `--spark-zero-dash:#b3a6a6`、`--spark-dot:#ff4d4f` |
| 字号阶梯 | **12 / 12.5 / 13 / 13.5 / 14 px**（0.5px 递增的自定义属性阶梯） |
| 字体族 | `-apple-system, BlinkMacSystemFont, "Helvetica Neue", …, "PingFang SC", "Microsoft YaHei", …` |

### 4.3「暗夜玻璃」网页浮窗令牌（content script，照录关键值）

| 类别 | 值 |
|---|---|
| 面板底 | `rgba(13,17,25,.92)` + `backdrop-filter: blur(20px) saturate(1.5)` |
| 表面层 | 白 6% / 白 4%；描边 `rgba(255,255,255,.09)` |
| 文本 | 主 `#eef1f6`、次 `#9aa3b5`、平 `#989cb8`；涨 `#c93a36`、跌 `#2d8b51` |
| 动效 | 缓动 `cubic-bezier(.16,1,.3,1)`（out）与 `.34,1.56,.64,1`（spring）；时长 0.15/0.18/0.2/0.24/0.28 s |
| 性能约定（包内注释明写） | 常驻动画**只用 `transform`/`opacity`**；关闭时 `display:none` 不占图层；页面切后台加 `.ap-idle` 暂停全部动画；`will-change:transform,opacity` |
| 无障碍 | 支持 `@media (prefers-reduced-motion: reduce)` |
| 关键帧命名（结构参考） | 面板入场、条目入场、live 呼吸点、halo 脉冲、header 流光 |

### 4.4 官网（大盘云图）暗色主题令牌

| 类别 | 值 |
|---|---|
| 背景层级 | 主背景 `#262931`、面板 `#373739`、菜单 `#232324`、遮罩 `rgba(23,23,26,.6)` |
| 文本 | `#ffffffe6`（主）/ `#c5c5c5`（次）/ `#5f5f60`（弱） |
| 主色 | `rgb(60,126,255)` = `#3c7eff`；成功 `rgb(39,195,70)`；危险 `rgb(247,105,101)` |
| 描边/填充 | 白 8%（fill-2 `#ffffff14`）/ 白 12%（fill-3 `#ffffff1f`）/ 白 14% |
| 圆角 | 小 2px、中 4px、圆形 50% |
| 强调蓝 | `#6ea3ff80`、`#9dc0ff` |

### 4.5 间距/栅格/字号（官网，可检查）

- 头部：左栏固定 **330 px**；标题 **28 px**；时间 **17 px**；图标 **19 px**；右侧控件间距 16/26 px。
- 统计块：宽 **142 px**、标签 **13 px**、数值两行（值 + `downup-num` 变化量），上边距 `mt-10px`/`mt-2px`。
- 工具类粒度：**1 px**（`w-330px`、`mr-16px`、`mt-27px`、`mt-3vh`）⇒ 没有中间间距刻度，全靠原子类。
- 栅格：`repeat(2,minmax(0,1fr))`（卡片区）、`repeat(3,1fr)`、`repeat(auto-fill,minmax(148px,1fr))`（自适应卡片，**148 px** 是最小卡片宽）。
- 站点口径文案（可信度高的设计约束）：面积=流通市值、颜色=涨跌幅、**每 8 秒更新**、双击色块看 K 线、方向键复盘、全屏观看。

### 4.6 图表与交互

- K线：**ECharts** candlestick + dataZoom（包内含 echarts 运行时代码），带 `progressive:200 / progressiveThreshold:500`（大序列降级渲染）；周期覆盖 §2.3 全部 11 档；含"溢价率"chip（`kline-premium-chip--up/down/na`）。
- 迷你图/火花线：轻量折线（`--spark-*` 令牌，零线虚线 + 末点圆点）。
- 热力图：官网用 **D3**（`d3-vendor` + `TreeMap` 组件）绘制，标尺/阈值**未确认**（混淆）。
- 表格列（照录）：序号、名称、今涨跌、成交额、成交量、总市值、年初至今、持仓占比、成本价、持仓股数、持仓收益率、持仓收益额。
- 分组/页签：自选 / 持仓 / 我的股票 / 个人中心；设置页签：基础设置、指数编辑、自选设置、股价提醒、图标管理、数据管理、关于插件。
- 通知与提醒：`notifications` 权限 + 股价提醒规则（页面 20 条/页、可启用/停用、周期与均线条件）。

### 4.7 我们可直接借鉴的前三条（Lead 要求）

1. **"多形态同一份数据"的窗口策略**：弹窗 / 800×620 独立窗 / 200×270 迷你窗 / 网页内浮窗四种载体共用同一份数据与缓存 —— 我们的面板目前只有侧栏主视图 + 抽屉；迷你悬浮形态（200×270 级）与"网页内左下角浮窗、可整页开关、后台暂停动画"是低风险、高收益的补充。
2. **暗色玻璃浮窗的性能与无障碍约定**（§4.3）：只用 transform/opacity、关闭即 display:none、后台 `.ap-idle` 暂停、尊重 `prefers-reduced-motion` —— 这套约束可以直接写进我们自己的样式红线。
3. **字号阶梯 + 1px 粒度间距 + 最小卡片 148px**（§4.5）：0.5px 递增的 12/12.5/13/13.5/14 阶梯，是"信息密度优先"的盯盘场景里比通用 8px 栅格更贴合的刻度；配合 `auto-fill minmax(148px,1fr)`，窄侧栏也能自适应。

---

## ⑤ 条款与风险

### 5.1 robots.txt（决定本轮的"能不能实弹"）

| 主机 | robots.txt 内容 | 我们的处置 |
|---|---|---|
| `52etf.site` | `User-agent: * Allow: /` + **`Disallow: /api/`** | 静态页/静态资源可读；**`/api/` 一律不发请求** |
| `push2.eastmoney.com` / `push2delay` / `push2his` | `User-agent: *` / **`Disallow: /`** | **完全不发请求**（字段语义改用包内映射确认） |
| `searchapi.eastmoney.com` | 404（未声明） | 保守：未发起（东财用户协议未确认，见 §6） |
| `fundgz.1234567.com.cn` / `money.finance.sina.com.cn` | 404（未声明） | 未发起 |
| `www.crxsoso.com` | `Disallow: /user/`，其余 Allow | 只读详情页（未用它下载） |
| `chrome.zzzmh.cn` | `Disallow:`（空＝全允许） | **用它拿到扩展包**（见 §附录B） |

### 5.2 商店直连的两个失败（实测记录）

- Chrome 官方 CRX 端点：经本机代理 `SSL_ERROR_SYSCALL`，直连超时 ⇒ **未取得**（命令见 §附录A-1）。
- Edge 官方 CRX 端点：`HTTP 500`，`size=0` ⇒ **未取得**。
- 结论：本轮取包**只能走第三方镜像**（极简插件），该站 robots 全允许、下载链接是其公开信息页自带的（带时间戳签名，有效期至 **2026-11-05 00:00 CST**）。

### 5.3 隐私政策 vs 实际 manifest（**逐条对照，均为可核事实**）

`https://52etf.site/privacy`（生效 2026-08-28，标题「隐私权政策｜大盘云图」）声明：

| 政策原文要点 | 实际包内情况 |
|---|---|
| "本扩展仅申请 **activeTab** 权限" | 大盘云图 v3.5.6 manifest 实为 `alarms` + `storage` + host `push2delay.eastmoney.com`（**无 activeTab**） |
| "**不使用 chrome.storage** 等本地存储保存您的数据" | 大盘云图后台**确实写** `chrome.storage.local`（缓存上次行情）；爱盯盘同样用 storage 存 token/主机健康/设置 |
| "**不要求注册账号，不使用账号体系**" | 大盘云图确实无账号；但**爱盯盘**有微信扫码登录 + JWT + 云端记录（`/api/data-records`、`/api/wx-user-name`） |
| 适用范围只写了「大盘云图」 | 官网同域还分发**爱盯盘**（另一个扩展，权限大得多，见 §5.4），该扩展**未见单独政策页** |
| "行情数据…**仅在服务器端被访问**" | 爱盯盘是**浏览器直连**东方财富/新浪接口（manifest 的 host_permissions 为证） |

> 处置建议：**不要照抄"权限最小"的表述**；我们自己的插件如果写隐私说明，必须与自己 manifest 的实际权限一一对应。

### 5.4 权限面（爱盯盘 v2.36.0）

- `permissions`：`storage`、`windows`、`alarms`、`contextMenus`、`scripting`、`notifications`。
- `host_permissions`：**11 条**（`52etf.site` + 6 个东财域 + 天天基金 + 新浪 + 腾讯云 COS）。
- `content_scripts`：`<all_urls>` + `run_at: document_idle`（注入网页左下角浮窗）。
- 风险提示（对我们）：**`<all_urls>` 常驻内容脚本 + `scripting` + 读页面**是这类"网页浮窗"方案的固有代价；
  若我们做同类功能，建议**只在用户显式开启的站点**注入（`optional_host_permissions`/按需授权），并把浮窗做成可一键全站关闭（对方也这么做）。

### 5.5 凭据模式与第三方中继（事实记录，非指控）

- 请求头策略：`credentials` 有 `auto|on|off` 三档；`on`/`auto` 且主机在允许名单内时用 **`credentials:'include'`**（可能携带用户在该域已有的 Cookie），其余用 `same-origin`。
- 存在**自家 Cloudflare Worker 中继**（`*.workers.dev`）作为第三档兜底，且带 `NUXT_APP_BASE`/`CLOUDFLARE_EASTMONEY_PROXY` 两个构建期常量。
- 影响：我们自己若也用中继，需要写明"中继能看到你的请求参数"，并在隐私说明里与 host_permissions 对齐。

### 5.6 数据源与合规风险（对我们最要紧）

- 扩展调用的**都是上游公开接口**（含东财公开常量 `ut`/`token`/`appid`）——这些常量是**上游的公共参数**，不是我们的凭据；
  直接复用它们会**给上游增加压力且有违反其服务条款的风险**（`push2*.eastmoney.com/robots.txt = Disallow: /` 是明确信号）。
- 我们已有的数据层已经接的是同类上游（见我们自己的审计文档），**建议不新增这些常量**；若确需，走"服务端聚合 + 缓存 + 退避"路线（对方官网也是"服务端聚合缓存"的说法）。
- 界面侧：**不复制其配色命名/组件结构与文案**；本文档只提供**可检查的数值**（色值、尺寸、时长、栅格）作为我们自己设计的约束参数。

---

## ⑥ 未确认项与确认方法（未确认 **不得** 写成结论）

| # | 未确认项 | 为什么未确认 | 合规确认方法 |
|---|---|---|---|
| 1 | 官网 TreeMap 的标签显示阈值、色阶断点、最小格面积 | 站点 `TreeMap-*.js` 是混淆代码；**不运行其代码**就读不出 | 人工在浏览器里开 devtools 观察（人做，不是自动化）；或直接问作者 |
| 2 | `f8/f9/f10/f15/f16/f17/f18/f22/f23/f24/f62/f100/f115/f128/f136/f145/f152/f265/f266` 的确切语义 | 包内无映射注释；本轮因 robots 未做实弹 | ① 读东方财富**官方接口文档**；② 在评估是否合乎其条款后，做**单次**、带退避的最小探针并交叉验证；③ 与我们已有的实测数据比对 |
| 3 | 是否存在付费订阅/增值包 | 包内无支付/激活码字样，但通知/云同步等功能是否收费未在包内体现 | 读其公众号/官网定价页（若公开），或人工登录后在"个人中心"查看（**不代跑**） |
| 4 | Cloudflare Worker 中继的服务端行为（是否改写/记录参数） | 无法静态确认（服务端代码不可见） | 由作者披露；或抓包观察（需合规授权） |
| 5 | `/api/data-records` 的数据结构与容量上限 | 需登录，按边界不尝试 | 人工登录后从"数据管理"页查看 |
| 6 | 官网"每 8 秒更新"的实现（轮询 vs 推送） | 相关 bundle 混淆 | devtools Network 面板人工观察一次 |
| 7 | 大盘云图 `STOP_AT = '2027-09-10'` 之后的行为（作者写的自停日期） | 只在 2027-09-10 之后可观察 | 到时回看；或读作者更新日志 |

---

## 附录A：命令与截断输出（每段输出 ≤200 字符）

**A-1 Chrome 官方 CRX 端点（实测不可得）**
```bash
curl -sS -I -m 20 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0.0.0&acceptformat=crx2,crx3&x=id%3Dhmkhfephfjheodabgomnanpbmbjbepni%26uc'
```
```
curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to clients2.google.com:443
（直连 --noproxy '*' 则 15s 超时；本机代理 127.0.0.1:7890 对该域握手失败）
```

**A-2 Edge 官方 CRX 端点（实测不可得）**
```bash
curl -sS -m 60 -L -o aidp-edge.crx -w 'http=%{http_code} size=%{size_download}\n' \
 'https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3Dghgimmholcnejdgphgiiodmpgpefmppl%26uc'
```
```
http=500 size=0
```

**A-3 东财行情主机（robots 禁止 ⇒ 未发请求）**
```bash
curl -sS -m 12 https://push2delay.eastmoney.com/robots.txt
```
```
User-agent: *
Disallow: /
```

**A-4 52etf.site robots 与静态资源（允许）**
```bash
curl -sS -m 15 https://52etf.site/robots.txt | head -4
curl -sS -m 25 -o home.html -w 'http=%{http_code} size=%{size_download}\n' https://52etf.site/
```
```
User-agent: *
Allow: /
Disallow: /api/
http=200 size=28569
```

**A-5 取包（第三方只读镜像，robots 全允许）**
```bash
curl -sS -m 25 'https://chrome.zzzmh.cn/info/hmkhfephfjheodabgomnanpbmbjbepni' -o zzzmh-info.html
grep -oE 'https://cdn3\.zzzmh\.cn/v3/crx/[^"]*\.zip\?auth_key=[^"]*' zzzmh-info.html | head -1
curl -sS -m 90 -o aidp.zip 'https://cdn3.zzzmh.cn/v3/crx/6a66e033…/hmkhfephfjheodabgomnanpbmbjbepni.zip?auth_key=1793808000-…'
```
```
http=200 size=938768 ct=application/zip
（zip 内：hmkhfephfjheodabgomnanpbmbjbepni_2.36.0_chrome.zzzmh.cn.crx + 安装说明书.txt）
sha256(aidp-2.36.0.crx) = 5cc9810c844fb3265ce82f1cbf4bb604de385d007f8a5cd9532d031f48474466
```

**A-6 CRX → ZIP 解壳（Cr24 v3：12 字节头 + header_len 后即 ZIP）**
```bash
python3 -c "import struct;b=open('aidp-2.36.0.crx','rb').read();h=struct.unpack('<I',b[8:12])[0];open('aidp.zip','wb').write(b[12+h:])"
unzip -o -q aidp.zip -d ext && find ext -type f | wc -l
```
```
93
（顶层：manifest.json、index.html、suspend.html、content.js、background/、assets/、icon/、_metadata/）
```

**A-7 接口与令牌的静态提取（只读包内文件）**
```bash
grep -ohE '/api/[A-Za-z0-9/_-]{2,40}' ext/**/*.js | sort -u
```
```
/api/Info/Search
/api/qt/clist/get
/api/qt/stock/kline/get
/api/qt/stock/trends2/get
（另：${Q()}/api/data-records、/api/wechat-qrcode、/api/wechat-qrcode-status、/api/wx-user-name，Q()=https://52etf.site）
```

**A-8 大盘云图（另一扩展，未混淆的自研后台）**
```bash
python3 -c "import zipfile,struct,io;z=zipfile.ZipFile('treemap.zip');b=z.read([n for n in z.namelist() if n.endswith('.crx')][0]);h=struct.unpack('<I',b[8:12])[0];zipfile.ZipFile(io.BytesIO(b[12+h:])).extractall('treemap')"
grep -oE "QUOTE_URL = '[^']*'|REFRESH_MINUTES = [0-9]+|periodInMinutes: [A-Z_]+" treemap/background.js
```
```
QUOTE_URL = 'https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f13,f14&secids=1.000001'
REFRESH_MINUTES = 1
periodInMinutes: REFRESH_MINUTES
（另：STOP_AT = '2027-09-10'；角标色 #e03131 / #0ca678 / #868e96）
```

---

## 附录B：包清单与哈希（本轮全部落 `/tmp`）

| 产物 | 路径 | 大小 | sha256（前 16 位） |
|---|---|---|---|
| 爱盯盘 v2.36.0 CRX | `/tmp/recon52-pkg/aidp-2.36.0.crx` | 944,499 B | `5cc9810c844fb326` |
| 爱盯盘解压产物（89 文件） | `/tmp/recon52-aidp/ext/` | — | — |
| 大盘云图 v3.5.6 CRX | `/tmp/recon52-pkg/treemap.crx` | 6,321 B | `47464be9d35c3868` |
| 大盘云图解压产物（5 文件） | `/tmp/recon52-treemap/` | — | — |
| 官网静态资源（home.html + 4 CSS + 5 JS） | `/tmp/recon52-site/` | — | — |
| 拦截/提取脚本与中间结果 | `/tmp/recon52-pkg/*.html,*.json` | — | — |

- 版本与商店 ID：Chrome `hmkhfephfjheodabgomnanpbmbjbepni` / Edge `ghgimmholcnejdgphgiiodmpgpefmppl` / 360 `bmnoebknpolegjfbjhnpafboihjonoaj`；作者署名「面壁投资」；`homepage_url = https://52etf.site/blog/`。
- 包内文件类型：`js 37 / png 29 / css 18 / json 2 / html 2 / ttf 1`。

---

## 附录C：边界执行清单（逐条对照任务硬边界）

| 硬边界 | 执行情况 |
|---|---|
| 1 不绕过鉴权/付费 | 未发任何登录/记录类请求；4 个自家接口只做**静态记录**（§2.2） |
| 2 不复制源码进仓库 | 本文档只含**接口地址/参数/字段名/令牌值**（公开常量）与 CSS 数值令牌，**未粘贴其 JS 实现** |
| 3 不做产品化复制 | §4 明确"只作数值参考"；§4.7 给出的是**我们自己的**三个可选方向 |
| 4 遵守条款与 robots.txt | 东财 `Disallow: /` ⇒ 零请求；52etf `/api/` ⇒ 零请求；镜像站 robots 全允许后才取包 |
| 5 不安装/不改浏览器/不跑其代码 | 只做 `curl` 下载 + `unzip`/`python` 解壳 + 文本阅读；未在浏览器加载任何扩展；未执行其 JS |
| 只读、不 commit、不装、不动 profile、不重启服务、不在工作区 build | 全部遵守；唯一写入本文档 |
