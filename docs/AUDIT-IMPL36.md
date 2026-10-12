# AUDIT-IMPL36 —— 六行标题可区分（子路径名 + 逐行 locale 元数据）

- 基线：`main` @ `aaf5ff2`（v0.59.1，六行已装载），`npm run check` = 412 × 2 时区全绿
- 本轮结果：**413 × 2 时区全绿**（新增 1 条标题/locale 断言；另把 3 条"裸包名不变量"注入加进既有注入用例）
- `build.mjs` 零改动；未装 bundle、未动 profile、未 commit、未重启用户的 `dsh web`
- **临时实例实测**：`dsh --profile web --port 0 --no-open`，三次（基线 / 全子路径 / 本方案），用完即杀

---

## 0. 结论先行（两句话）

1. **任务给的原方案（六行全改子路径）会静默干掉浏览器半区** —— 宿主路由照样 200、`/rows` 照样六项，
   但 `window.__DSH_BOOT__` 里 `dsh-tradewatcher` **出现 0 次**（实测），界面直接没了。**不能这么提交。**
2. **改成「core 留裸包名 + 其余五行用子路径 + 每行自己的 locale 元数据」后三样都成立**：
   六行标题互不相同、宿主六行照常、**浏览器半区仍在**（同一探针 1 次）。本报告给的就是这个方案。

---

## 1. 两个机制（源码级，行号都在 `@deepseek-ai/dsh` 里）

### 1.1 插件列表的**标题**来自哪

`dsh-client-ui-settings-plugin-inventory/lib/client.js`：

```js
function pluginText(row, resolveText) {
  const title = row.meta?.title;
  return { title: typeof title === "object" ? resolveText(title) : moduleShortName(title ?? row.moduleName), … }
}
```

- 有 `meta.title` ⇒ 用它（`LocalizedText` 映射，按当前语言解析）；没有 ⇒ 回退 `moduleShortName(moduleName)`（把 `dsh-` 前缀剥掉）。
- 所以**光改 `name` 只能得到 `tradewatcher/rows/cloudmap` 这种丑标题**；要中文标题必须给 `meta`。

`meta` 由 `dsh-app-boot` 的 **`readPluginMeta(specifier, parentURL)`** 解析（`dsh-host-plugin-inventory:127`/`:147` 与 `dsh-plugin-manager` 的 `declaredRows` 都调用 `packages.metaOf(row.name, base)`，而 `metaOf` 就是它）：

```js
function readPluginMeta(specifier, parentURL) {
  const packageName = barePackageName(specifier);
  if (packageName === void 0) return void 0;
  const englishPath = optionalResourcePath(`${specifier}/locale/en.json`, parentURL);   // ← 入口是 en.json
  const dictionaries = englishPath === void 0 ? new Map() : dictionariesOf(englishPath, specifier, parentURL);
  const manifestPath = packageName === specifier ? optionalResourcePath(`${specifier}/package.json`, parentURL) : void 0;
  const manifest = manifestPath === void 0 ? void 0 : readObject(manifestPath);
  const title = localizedText("title", dictionaries, fallbackText(manifest?.name), specifier);
  …
```

- `dictionariesOf` 把 `<specifier>/locale/` 目录下**每个** `<lang>.json` 读成一个语言字典（`{ meta: { title, description } }`）。
- 对应的源码注释写得明明白白：**“A subpath specifier never reads package.json; its icon comes only from `<specifier>/icon`.”** ⇒ **子路径 specifier 是被支持的元数据主体**，只是不读 package.json。
- `localizedText` 的返回是 `{ en: fallback ?? specifier, ...字典 }` ⇒ **en.json 里的 `meta.title` 会覆盖 en**，`zh.json` 提供 `zh`。
- 客户端解析：`ctx.locale.resolveText(text)`（`dsh-client-locale`）＝
  `fallbackChain(active).reduceRight((r, loc) => text[localeKey(loc)] ?? r, text.en)` ⇒ **当前语言 `zh` 时取 `text.zh`**；
  该包内置语言只有 **`zh` / `en`** 两种（`BUILT_IN_LOCALE_METADATA`）⇒ 我们的 `zh.json` 文件名正好对上。

### 1.2 浏览器半区为什么**只能**由「裸包名那一行」提供（任务问的那条）

`dsh-client-modules/lib/index.js`：

| 锚点 | 代码 | 含义 |
|---|---|---|
| `:791-792` | `sourceKey(loaderName, baseUrl) = baseUrl + "\0" + loaderName` | 去重键是 **specifier**（不是解析后的包名） |
| `:858-869` | `resolveSource(entry)`：`loaderName = entry.options.name` | 直接用行的 `name` |
| `:701-717` | `resolveMeta(loaderName, baseUrl)` | 先 `locatePkgJson`，拿不到就 `pkgMeta.set(sourceKey, null)` 并返回 `null` |
| `:743-747` | `const expectedPackageName = pathLike ? void 0 : exactPackageSpecifier(loaderName)` + `if (!pathLike && expectedPackageName === void 0) return void 0` | **非 scoped 且含 `/` 的 specifier 直接出局** |
| `:82-88` | `exactPackageSpecifier`：非 scoped 时 `!specifier.includes("/")` 才返回本身，否则 **`void 0`** | 这行决定了子路径行**不是** client source |
| `:833-840` | `nextSources.set(source.sourceKey, source)`（只收集 resolveMeta 非空的行） | 子路径行根本不入 `sources` |
| `:871-876` | `reconcilePackage(packageName)`：按**解析后的 `packageName`** 分组，`sources.length > 1` 才抛 composition error | 冲突判据是包名，不是 specifier |

**精确回答任务的第 4 问**：
- 归并/去重按 **specifier**（`sourceKey`）；**冲突判据按解析后的 package name**（`reconcilePackage`）。
- 但对我们这个 package 而言两者都用不上：**`dsh-tradewatcher/rows/<row>` 压根不会被认成 client source**
  （`exactPackageSpecifier` 返回 `undefined` ⇒ `locatePkgJson` 返回 `undefined` ⇒ `resolveMeta` 返回 `null`）⇒
  **既不会去重成一条、也不会触发 `sources.length > 1`**。
- ⇒ **不会有 composition error**（这点任务担心错了），**但会丢掉整个浏览器半区**（这点没人预料到）。
  六行全给子路径 ⇒ `dsh-tradewatcher` 这个包名**一条 source 都没有** ⇒ client 模块直接从 `__DSH_BOOT__` 图表里消失。

---

## 2. 临时实例的三态实测（决定性证据）

三次都用同一条命令、同一个 profile（`web`，symlink 指向工作区），用完即杀：

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher
(timeout 110 dsh --profile web --port 0 --no-open > /tmp/boot-rows-<态>.log 2>&1 &)
sleep 32; P=$(grep -oE 'http://127.0.0.1:[0-9]+' /tmp/boot-rows-<态>.log | head -1 | grep -oE '[0-9]+$')
T=$(grep -oE 'token=[A-Za-z0-9_-]+' /tmp/boot-rows-<态>.log | head -1 | cut -d= -f2)
curl -s -L -c /tmp/cj.txt -b /tmp/cj.txt "http://127.0.0.1:$P/?token=$T" -o /tmp/index-<态>.html   # 首页即 __DSH_BOOT__ 图表
grep -c '"id":"dsh-tradewatcher"' /tmp/index-<态>.html
kill $(lsof -t -i:$P)
```

### 2.1 三态对照表（探针：首页里 `{"id":"dsh-tradewatcher", …}` 出现次数）

| 态 | `cordis.patch.yml` 六行的 `name` | 宿主路由 | `/rows` | 日志 | **浏览器半区** |
|---|---|---|---|---|---|
| **A 基线**（v0.59.1，用户当前） | 六行都是 `dsh-tradewatcher` | 全 200 | 六项 | 无 error | **1 次 ✅** |
| **B 任务原方案** | 六行都是 `dsh-tradewatcher/rows/<row>` | 全 200 | 六项 | 无 error | **0 次 ❌ 界面消失** |
| **C 本方案** | core 裸名 + 另五行 `/rows/<row>` | 全 200 | 六项 | 无 error | **1 次 ✅** |

> 态 B 是最危险的一种失败：**日志里一个字都不报**，`curl` 六个路由全 200，`/rows` 也照旧六项 ——
> 只有把首页 HTML 里的 `__DSH_BOOT__` 图表抠出来数，才发现浏览器半区没了。

### 2.2 态 C 的实测输出（照抄）

```
[tradewatcher] row「core」mounted
[tradewatcher] row「calendar」mounted
[tradewatcher] row「watchlist」mounted
[tradewatcher] row「portfolio」mounted
[tradewatcher] row「market」mounted
[tradewatcher] row「cloudmap」mounted
[tradewatcher] store ready at /home/hu/.dsh/dsh-tradewatcher          ← inits = 1
[tradewatcher] rescue monitor started interval 60s / tail 15s          ← starts = 1
dsh web: http://127.0.0.1:43517/?token=…
（另有三行 dsh-passwords 的端口占用提示 —— 那是**别的插件**的噪声，与本插件无关）

/tradewatcher/health         HTTP 200
/tradewatcher/rows           HTTP 200
/tradewatcher/calendar       HTTP 200
/tradewatcher/watch          HTTP 200
/tradewatcher/portfolio      HTTP 200
/tradewatcher/breadth        HTTP 200
{"rows":["core","calendar","watchlist","portfolio","market","cloudmap"],"asOf":1791778941979}

$ grep -oE '\{"id":"dsh-tradewatcher","url":"[^"]+' /tmp/index-safe.html
{"id":"dsh-tradewatcher","url":"plugins/??dsh-tradewatcher/client.js&rev=63bb60fb886b
```

⇒ **六行装载、`inits`/`starts` 各 1、六条功能路由全 200、`/rows` 六项、浏览器半区在**。
（态 A 与态 C 的首页字节数同为 `45244` —— 除标题元数据外没有别的差异。）

---

## 3. 标题可区分的证据（调**真实** `readPluginMeta`，不是我自己复刻的逻辑）

`readPluginMeta` 是 `@deepseek-ai/dsh-app-boot` 的**导出函数**，直接用真 profile 的 base URL 调它：

```bash
node --input-type=module -e '
import { readPluginMeta } from "/…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js"
import { pathToFileURL } from "node:url"
const base = pathToFileURL("/home/hu/.dsh/profiles/web/").href
for (const s of ["dsh-tradewatcher","dsh-tradewatcher/rows/calendar","…"]) console.log(s, JSON.stringify(readPluginMeta(s, base)))'
```

改前 / 改后的实测（截断）：

| specifier | 改前 | 改后 |
|---|---|---|
| `dsh-tradewatcher` | `{"title":"dsh-tradewatcher","description":"dsh-tradewatcher（盯盘）: a DeepSeek Harness web plugin that registers…"}`（长段落，六行一模一样） | `{"title":{"en":"Tradewatcher · Core","zh":"盯盘 · 核心"},"description":{…"行情条 / 详情图 / 数据层与共享路由"}}` |
| `dsh-tradewatcher/rows/calendar` | `undefined`（⇒ 标题回退成 `tradewatcher/rows/calendar`） | `{"title":{"en":"Tradewatcher · Calendar","zh":"盯盘 · 日历"},…}` |
| `…/watchlist` | `undefined` | `盯盘 · 自选` |
| `…/portfolio` | `undefined` | `盯盘 · 持仓` |
| `…/market` | `undefined` | `盯盘 · 大盘` |
| `…/cloudmap` | `undefined` | `盯盘 · 云图` |

⇒ 六个 specifier 解析出**六个不同的 `meta.title`**（zh 与 en 两套都有），
UI 侧 `resolveText` 在中文环境下取 `zh`（§1.1 的 fallback 链）⇒ 列表里显示「盯盘 · 云图」等。

---

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `cordis.patch.yml` | `tradewatcher-core` **保持** `name: 'dsh-tradewatcher'`；其余五行 → `'dsh-tradewatcher/rows/<row>'`（`config.row` 全不变）。头部新增一节注释，写明「标题来自 `meta.title`」「core 必须留在裸包名上，否则浏览器半区整体不注册（附实测）」 |
| `package.json` | `exports` 增：`"./rows/<row>": "./lib/index.js"`（五个宿主入口）、`"./rows/<row>/locale/*": "./locale/rows/<row>/*"`（五行的元数据）、`"./locale/*": "./locale/*"`（core 行的元数据）；`files` 增 `"locale"`（打包要带上） |
| `locale/zh.json`、`locale/en.json` | **core 行**的标题/描述（`{ meta: { title, description } }`），替换掉原来那段超长 package.json description |
| `locale/rows/{calendar,watchlist,portfolio,market,cloudmap}/{zh,en}.json` | 五行各自的标题/描述 |
| `src/index.test.ts` | ① `checkManifest` 增「**裸包名恰好一行且在 core 上**」「功能行必须是自己的子路径」两条不变量；② 注入用例 +3 条（六行全子路径 / 两行抢裸名 / 功能行退回裸名）；③ 新增一条 task-8 断言（locale 元数据可解析、六个标题互不相同、exports 映射在、`files` 含 `locale`） |

**没有改**：`src/index.ts`（宿主逻辑一行未动）、`build.mjs`、`src/client/**`。

---

## 5. 断言与反例（`npm run check` 内）

新增/更新的用例（`node:test`，中文名）：

- `task-8：六行标题各自可区分 —— 子路径 locale 元数据可解析、六个标题互不相同（防退回同名）`
  - 每行 `<specifier>/locale/en.json` 与 `zh.json` 都存在且 `meta.title` 非空（en.json 是 `readPluginMeta` 的入口，缺了整个目录都不读）；
  - 每行对应的 `exports` 映射存在（没映射 ⇒ Node 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`）；
  - **六个 zh 标题互不相同**（这就是用户要的「哪个是云图」）；
  - `files` 含 `locale`。
- 注入用例（证明非恒真）：

| 注入 | 期望被抓到的原因 |
|---|---|
| 六行全给子路径（core 也换掉） | `必须恰好一行用裸包名` / `裸包名必须留在 core 行上` |
| 两行抢裸包名 | `必须恰好一行用裸包名` |
| 功能行悄悄退回裸包名 | `必须恰好一行用裸包名` / `的 name 应为 …` |
| （既有）改名 / 大写 / 数字后缀 / 漏 config / row 值拼错 | 见 AUDIT-IMPL35 §5 |

> 这 3 条注入是**先有实测结论、后写的断言**：态 B 的失败（浏览器半区消失）就是「裸包名一行都不剩」，
> 所以把「裸包名恰好一行且在 core」写成不变量 —— 它同时挡住态 B 与"标题又全都一样"两种回归。

### 5.1 「裸包名不变量」的反例实测（Lead 要求保留的回归闸门）

改动**真实 `cordis.patch.yml`**：把 core 行的 `name` 换成 `'dsh-tradewatcher/rows/core'`（＝态 B 的最小复现），跑测试：

```
ℹ tests 13 / pass 11 / fail 2
AssertionError: 真实 manifest 必须通过全部六行检查
  （失败项：必须恰好一行用裸包名 dsh-tradewatcher（实测 0 行）⇒ 否则浏览器半区不注册）
AssertionError: 基准（未注入）必须通过 —— 否则下面的注入证明无效
  （失败项：必须恰好一行用裸包名 dsh-tradewatcher（实测 0 行）⇒ 否则浏览器半区不注册）
```

恢复后：`sha256sum -c` 通过、`ℹ tests 13 / pass 13 / fail 0`。

> 为此把两条断言的消息改成**带上失败原因**（原来只说"必须通过全部六行检查"，看不出是哪条不变量破了）——
> 以后谁再把子路径写进 core 行，红的第一行就直接点名原因。

---

## 6. 回滚（一条命令）

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher && git checkout HEAD -- cordis.patch.yml package.json src/index.test.ts && rm -rf locale && echo "已回退到 v0.59.1（六行同名），请重启 dsh web"
```

（`HEAD` = `aaf5ff2` = 用户当前生效的版本。回滚后标题又会全都一样，但功能与今天完全一致。）

---

## 7. 未做 / 留给 Lead 的

1. **没有重启用户的 `dsh web`**（纪律）⇒ 用户端标题的实际观感（中文环境下显示「盯盘 · 云图」）还差最后一步实测。
   我这边能给的等价证据是 §3 的**真实 `readPluginMeta` 输出**＋ §1.1 的 `resolveText` 取值链。
2. **没有动 profile**（用户那条 `- id: tradewatcher` 旧覆盖项仍在，重启后只多一条 warning）。
3. 备选方案（如果 Lead 决定不引入子路径）：**保持六行同名**，只在 README 写明
   「灰色小字即组件的 id 对照表」，列出六行 id ↔ 中文名（`tradewatcher-core`=核心、`-calendar`=日历、
   `-watchlist`=自选、`-portfolio`=持仓、`-market`=大盘、`-cloudmap`=云图）。**本方案的标题更好看，且已验证不伤浏览器半区**，
   但代价是 manifest 里多了一种 specifier 形态（文档与测试都已跟上）。
   > 注：Lead 已选定本方案（方案 C），此条仅作为存档的备选记录。
4. **两处旧文本随本方案过时，未改**（不在 task-8 的 write scope，且 Lead 正在提交，避免与提交打架）：
   - `docs/DESIGN-SUBPLUGINS.md:3` 的抬头仍写「…每行 `config: { row: … }`、**`name` 全为 `dsh-tradewatcher`**」—— 现行是 core 裸名 + 其余五行 `/rows/<row>`；
   - `CHANGELOG.md:48`（v0.59.0 条目）同类表述 —— 那是**当时的事实**，建议在 v0.60.0 条目里写明"name 不再全是裸包名"即可，不必回头改写历史条目。

---

# 8. task-9 追加：标题改英文（中文只留在描述行）

> 用户重启确认方案 C 生效（面板正常、六个组件可区分）后提出的新要求。

## 8.1 六个标题 + 中英描述对照表（`locale/**`，13 个文件）

| 行 | `title`（**两语都英文**） | `description`（`en.json`） | `description`（`zh.json`） |
|---|---|---|---|
| core（包级） | `Tradewatcher · Core` | Quotes strips, detail charts, data layer and shared routes | 行情条 / 详情图 / 数据层与共享路由 |
| calendar | `Tradewatcher · Calendar` | Economic calendar: macro data, IPOs, earnings, dividends | 财经日历：宏观数据 / 新股 / 财报 / 分红 |
| watchlist | `Tradewatcher · Watchlist` | Watchlist groups, industry boards and the anomaly queue | 自选分组、行业板块与异动队列 |
| portfolio | `Tradewatcher · Portfolio` | Position P&L, per-trade ledger and fees | 持仓盈亏、逐笔流水与费用 |
| market | `Tradewatcher · Market` | Advance/decline breadth and the rescue-signal monitor | 涨跌家数与护盘信号 |
| cloudmap | `Tradewatcher · Cloudmap` | Market cloud map (industry heat), client-side only | 大盘云图（行业热力，纯前端） |

**最容易漏的一条（卡里已点名，这里再记一次）**：解析是 `text.zh ?? text.en`
（`dsh-client-locale` 的 `resolveText`：`fallbackChain(active).reduceRight((r, loc) => text[localeKey(loc)] ?? r, text.en)`）⇒
**中文环境下取的是 `zh.json` 的 `title`**。只改 `en.json` 的话中文界面仍是中文标题 —— 所以 `zh.json` 的 `title` 也写英文，
中文只放在 `zh.json` 的 `description` 里。

## 8.2 ⚠ 任务卡里的一处自相矛盾（已按本意处理，请确认）

- 卡里的**断言**是「`title` 匹配 `^[\x20-\x7E]+$`（纯 ASCII）」；
- 但**同一张卡给的示例标题**是 `Tradewatcher · Core` —— 那个 `·` 是 **U+00B7**（不在 `\x20-\x7E` 里）。

⇒ 严格 ASCII 断言会把卡里的示例自己判红。**我按这条要求的本意实现**（用户要的是"标题用英文"）：
断言拆成两条 —— ① 允许集 = 可打印 ASCII **+ `·`**（`/^[\x20-\x7E·]+$/`）；② **标题不得含 CJK**（`/[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/`，覆盖中日韩字、CJK 标点、全角字符）。
要继续用 `·` 就无需改动；**若你要严格 ASCII**，把分隔符换成 `: ` 即可（一条命令）：

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher && sed -i 's/ · /: /g' locale/*.json locale/rows/*/*.json
```

## 8.3 断言与反例证据

**断言（`src/index.test.ts`）**：抽出可直接复用的 `localeMetaViolations(entries)`（返回失败原因列表），
对 13 个文件的 26 条元数据统一检查：`title` 非空 + 允许集 + **不得含 CJK**；`description` 非空；
`zh` 描述**必须含中文**；`en` 描述**不得含 CJK**。真实文件必须返回空 ⇒ 失败时红的那行直接点名原因。

**反例注入（改真实文件，贴输出后恢复）** —— 把 `locale/rows/cloudmap/zh.json` 的 `title` 写回中文：

```
ℹ tests 14 / pass 12 / fail 2
AssertionError: locale 元数据检查未通过
  （失败项：locale/rows/cloudmap/zh.json 的 title 含非允许字符（只允许可打印 ASCII 与 ·）：盯盘 · 云图
     ／ locale/rows/cloudmap/zh.json 的 title 含 CJK —— 标题必须是英文：盯盘 · 云图）
AssertionError: 基准（未注入）必须通过 —— 否则下面的注入证明无效
```

恢复：`cp /tmp/keep-cm.json locale/rows/cloudmap/zh.json` + `diff -q` 逐字一致 → `ℹ tests 14 / pass 14 / fail 0`。

**另有三条注入固化进用例**（不必再手改文件）：① `title` 写回中文；② `zh` 描述失去中文；③ `title` 混入全角括号。

## 8.4 验收（`npm run check`）

```
ℹ tests 414 / pass 414 / fail 0      （本地时区；TZ=UTC 同）
ALL HOST CHECKS PASSED (live probes soft)
```

> 条数 **413 → 414**：task-9 新增 1 条用例（`localeMetaViolations` 的真实检查 + 3 条固化注入）；
> task-8 那条用例被改写（标题断言从"有 title"升级为"标题必须英文/无 CJK"），条数不变。

末尾四行（倒数第三行是构建分段器的空行）：

```
> dsh-tradewatcher@0.60.0 build
> node build.mjs

built lib/index.js + lib/client.js （v0.60.0，客户端片段校验通过：75 项）
```

`build.mjs` 零改动；`cordis.patch.yml` / `package.json` / `src/index.ts` / `src/client/**` 本轮**未动**（只改了 `locale/**` 与 `src/index.test.ts`）。
