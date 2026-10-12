# AUDIT-IMPL35 —— 重做组件分离：恢复六行 manifest（含**纠正**上一轮的历史归因）

- 基线：`main` @ `13c1b73`（v0.58.0），`npm run check` = 412 × 2 时区全绿，工作区干净
- 本轮结果：**412 × 2 时区仍全绿**（测试条数不变：删 3 条"锁单行"的旧断言、加 3 条"锁六行"的新断言）
- `build.mjs` **零改动**（构建末尾仍打印「客户端片段校验通过：75 项」）；未 commit / 未装 bundle / 未动 profile / 未重启 `dsh web`
- 改动文件：`cordis.patch.yml`、`src/index.test.ts`、本文件（三处，均在任务 write scope 内）
- 已取证的源码锚点一律给 `文件:行号`（DSH 装在 `~/.nvm/.../node_modules/@deepseek-ai/dsh/` 下）

---

## 0. 一句话结论

**六行形态此前从未被真正验证过**：上一轮把失败归因成"同包多活跃 Loader 源 = composition error"是**错的**，
真正打死它的是 `apply` 读了未 inject 的 `ctx.config`（真宿主 ctx 是 Proxy，直接抛）——**那个 bug 与行数无关**。
本轮把 manifest 恢复成六行，并用**锚在真实源码 + 真实产物**的断言证明：六行装载下一次性副作用各 1 次、
每行只注册自己那段、**跨行零重复**、且六行的并集与老单行**逐字一致**。

---

## 1. 纠正历史归因（两条，都有源码证据）

### 1.1 "同一 package 多个活跃 Loader 源 = composition error" —— 这条不成立

DSH 原文（`@deepseek-ai/dsh-client-modules/lib/index.js:122-123` 模块注释）：

> the manifest package name identifies the browser module; **distinct active Loader *sources* for that package are a composition error**.

关键词是 **sources**，而 source 的身份由 `sourceKey` 定义：

| 锚点 | 代码 | 含义 |
|---|---|---|
| `dsh-client-modules/lib/index.js:791-792` | `sourceKey(loaderName, baseUrl) { return \`${baseUrl}\0${loaderName}\` }` | 源 = **解析基准 URL + 模块 specifier** |
| `:858-869` `resolveSource(entry)` | `const loaderName = entry.options.name`；`const baseUrl = entry.parent.tree.ctx.baseUrl` | 行的 name 与所属树的 baseUrl |
| `:833-840` `processOne()` | `nextSources.set(source.sourceKey, source)` | **按 sourceKey 收进 Map ⇒ 同名同基准的多行会被合并成一条** |
| `:871-876` `reconcilePackage()` | `if (sources.length > 1) throw new Error(\`… resolves from multiple active Loader sources …\`)` | 只有 **≥2 个不同 sourceKey** 才报错 |

⇒ 我们的六行是 `id` 不同、`name` **都是 `dsh-tradewatcher`**、都在 profile 树的同一次 `insert` 里
（同一个 `baseUrl`）⇒ `sourceKey` **完全相同** ⇒ Map 里只剩 1 条 ⇒ `sources.length === 1` ⇒ **永远走不到 :874 的报错**。
"多个 row" 与 "多个 source" 是两件事，上一轮把注释里的 source 读成了 row。

### 1.2 真正打死它的是 `ctx.config`（v0.45.3 已修）

| 锚点 | 证据 |
|---|---|
| `@deepseek-ai/cordis/lib/index.js:672` | `static handler = { get: (target, prop, ctx) => {` —— 每个 ctx 都是这个 Proxy |
| `:676` | `const error = new Error(\`cannot get property "${prop}" without inject\`)` —— 未 inject 的属性访问**直接抛** |
| `:660` | `isSpecialProperty`（symbol / `prototype` / `then` / 数字串 / `_` 开头）才走 `Reflect.get` 直通 |

`config` 既不是 mixin accessor（`effect`/`get`/`provide`/`accessor`/`mixin` 是，注册在 `ReflectService` 构造函数里：
`cordis/lib/index.js:736` 的 `this.mixin("reflect", [...])` 与 `:743` 的 `this.mixin("fiber", ["runtime","effect"])`，
Proxy 的 get trap 对 accessor 走 `def.get.call(...)`，见 `:680-681`），也不在 `fiber.inject` 里 ⇒ 读 `ctx.config` 抛
⇒ **那一行 fiber failed** ⇒ 用户端"插件服务异常"。
**1 行和 6 行同样会被这一条打死**，所以上一轮"六行不可行"的结论实际上是这个 bug 的替罪羊。

修复方式（v0.45.3，现网代码已带着它）：`src/index.ts:85-91` 的 `ctxSafe()` try/catch + `:253-255`
只读第二参数 `config`、把 `ctx.config` 包进 `ctxSafe`。`src/index.test.ts` 里那条"真宿主 ctx 是 Proxy"的用例就是它的回归网。

### 1.3 顺带核实的两个相邻风险（结论：不会触发）

- **`ctx.provide('tradewatcher.core')` 的名字合法性**：`provide` 是被直接调用的方法（不是 `ctx.x = …` 赋值 ⇒ 不过 Proxy 的 set trap），
  且**单行模式下现网已经在调它**（`applyCore` 的 `full=true` 分支）⇒ 不是新引入的风险。函数本身还包了 try/catch（`src/index.ts:133-140`）。
- **功能行能否拿到内核**：两条路都通。①`ctx.get('tradewatcher.core')` —— `get` 是 mixin accessor，与现网必然可用的 `ctx.effect` 同一注册机制；
  ②模块级单例 `kernel` —— 六行由**同一个 specifier + 同一个 baseUrl** 装载，走同一份模块实例
  （`dsh-app-boot/lib/index.js:3795-3804` 的 `HostResolvedRootInclude.import` → Node internal importer，按 URL 缓存）。
  任一条成立即可，`applyFeatureRow`（`src/index.ts:205-217`）两条都留着。

---

## 2. 改动

### 2.1 `cordis.patch.yml`：单行 → 六行（代码零改动）

```diff
 - insert:
-    - id: tradewatcher
+    - id: tradewatcher-core
       name: 'dsh-tradewatcher'
+      config: { row: core }
+    - id: tradewatcher-calendar
+      name: 'dsh-tradewatcher'
+      config: { row: calendar }
+    - id: tradewatcher-watchlist
+      name: 'dsh-tradewatcher'
+      config: { row: watchlist }
+    - id: tradewatcher-portfolio
+      name: 'dsh-tradewatcher'
+      config: { row: portfolio }
+    - id: tradewatcher-market
+      name: 'dsh-tradewatcher'
+      config: { row: market }
+    - id: tradewatcher-cloudmap
+      name: 'dsh-tradewatcher'
+      config: { row: cloudmap }
```

- **`src/index.ts` 一行未改**：`rowOf`（:104-111）早就能认这六个 row 值；不带 `config` 的 `all` 语义原样保留（老 profile 的单行仍能用）。
- 文件头注释写明了：六行的语义、**历史归因纠正**（§1 的两条）、profile 层按 id 关闭的写法、以及"改完必须重启 `dsh web`"。
- 六行**全部启用**（文件里不出现 `disabled: true`，"要关由 profile 层覆盖"）。

### 2.2 `src/index.test.ts`：把"锁单行"的 3 条断言换成"锁六行"的 3 条

| 旧用例（删） | 新用例（加） |
|---|---|
| `P2：cordis.patch.yml 与代码的行集合一致` （断言 `ids === ['tradewatcher']`） | `task-6：六行 manifest —— id ↔ config.row 一一对应，且与代码的行集合一致` |
| `task-60：patch id 正则放宽 + 行级精确 + 数量守恒` | 同上（同一份检查 `checkManifest()`，真实文件必须返回空） |
| `task-60：两种注入的模拟` | `task-6：四种注入各让"六行检查"非空（改名/大写/数字后缀/漏 config）` |
| — | `task-6：六行装载（manifest 驱动）—— 幂等各 1 次、每行只注册自己那段、跨行零重复、并集 == 老单行` |

保留的 task-60 纪律：**行级精确**（整行必须匹配 `^- id: tradewatcher-[a-z0-9]+$`，抓截断/大写）+ **数量守恒**（解析到的行数 == `- id:` 行数，抓漏 `config`）+ **反例注入**（见 §5）。期望集合从 `['tradewatcher']` 变成六个 `tradewatcher-<row>`。

新增的两个辅助函数（都在测试文件里，锚真实文件而非自指）：`parseRowsFromText()`（唯一解析器，三段式严格匹配）、
`checkManifest()`（把一份 manifest 文本跑完整套检查、返回失败原因列表——**真实文件必须返回空、每个注入必须非空**，这一条就是"非恒真"的结构保证）。

---

## 3. 装载路径结论：**不需要 `plugin install`，manifest 是实时读的**

| 证据 | 值 |
|---|---|
| profile 依赖声明 | `~/.dsh/profiles/web/package.json`：`"dsh-tradewatcher": "link:/home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher"` |
| profile 侧路径 | `~/.dsh/profiles/web/node_modules/dsh-tradewatcher -> ../../../../workspace/Servers/dsh/Dev/dsh-tradewatcher`（symlink） |
| **同 inode 验证** | `stat -c '%i'` ⇒ 工作区 `cordis.patch.yml` 与 profile 视角下的是 **4879983 同一个 inode** ⇒ 同一份文件，不是拷贝 |
| 清单来源 | `package.json` 的 `dsh.bundle.patch = "./cordis.patch.yml"`（`dsh-app-boot/lib/index.js:496-497` 解析该字段） |
| profile 是否缓存副本 | `.plugin-manager/` 下**只有 `logs/*/pnpm.log`**，没有 manifest 副本 |

⇒ **改工作区的 `cordis.patch.yml` 就等于改 profile 看到的清单**（下次启动读到的就是它）。
`plugin install` / `pnpm install` 都不会、也不需要参与这一步（除非依赖本身变了）。

### 3.1 新起的六个 id 怎么被 profile 层单独关掉

profile 的 `cordis.patch.yml` 顶部写的是 "applied after **every** bundle layer" ⇒ 它按 id 覆盖 bundle patch 插入的行。
一条 `- id: <行id>` + `disabled: true` 即可（其余字段不写就保持不变），例如只关日历：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: tradewatcher-calendar
  disabled: true
```

- 关掉后：该行 fiber 不激活 ⇒ `/tradewatcher/calendar` 未注册（404）、`tradewatcher_calendar`/`calendar_add` 不出现、
  `GET /tradewatcher/rows` 的 `rows[]` 不含 `calendar` ⇒ 前端 tab gate 自动隐藏"日历"页签（`src/client/tabsGate.ts`，已有测试）。
- **core 行不要关**：路由前缀表里 core 兜住其余全部路由（行情/详情图/云图/备份/`rows`），关掉等于整个插件失效。
- ⚠ **profile 里那条现存的 `- id: tradewatcher`（`disabled: false`）在六行之后会"指向不存在的行"**。
  这**不是**启动错误：`dsh-app-boot/lib/index.js:3651-3655` 明确写着 *"a single patch whose target row is absent stays a
  per-entry Loader warning"*，`:2848` 的工具描述也是 "Unknown targets … are warned and skipped" ⇒ 只会多一条 warning。
  想干净就把那两行换成六条 `- id: tradewatcher-<row>` 的显式开关（或直接删掉——六行默认全启用）。

---

## 4. 静态自查：锚在**真实产物**上的六行装载验证

### 4.1 可导入 + 六行 apply（`lib/index.js`，即宿主真正装载的那份产物）

`npm run check` 会先 build 出 `lib/`；下面的探针直接 import 产物（不是源码），并用假 ctx 驱动。

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher
export DSH_HOME=$(mktemp -d)          # 隔离数据目录：绝不能在探针里碰用户的 ~/.dsh
node --input-type=module -e '<见下>'
```

实测输出（`[tradewatcher]` 日志行已滤掉）：

```
导入 lib/index.js 成功：name = dsh-tradewatcher | inject = ["webServer","webRuntime"]
"applies" = 8                 ← 此读数的构成：core 行两次（同一行两个 fiber）+ 五个功能行各一次 + 单独 core fiber 一次；
                                其后又 apply 了一次"无 config ⇒ all"的行作对照（发生在读数之后，未计入这 8）
"inits" = 1                   ← store.init() 只跑一次
"starts" = 1                  ← rescue.start() 只跑一次（采样器只有一个）
"跨行重复路径" = []            ← **跨行零重复**
"各功能行路由数（cloudmap 应为 0）" = {"calendar":1,"watchlist":3,"portfolio":2,"market":2,"cloudmap":0,"core":16}
"六行并集 == 单行全量" = true
"路由总数" = 24
"core 含（应为空）" = []        ← core 不含 /watch /calendar /portfolio /ledger /breadth /rescue
"各功能行工具" = {"calendar":["calendar","calendar_add"],"watchlist":["group_rank","watchlist"],
                 "portfolio":["ledger","portfolio"],"market":["rescue"],"cloudmap":[],
                 "core":["position","quotes","search","undo","ytd"]}
"applies/inits/starts（注册 round 3 之后）" = [9,1,1]   ← 又注册一行（all 对照行）后，一次性副作用**仍是 1**
ALL OK（built lib/index.js）
```

路由账（24 = 16 + 1 + 3 + 2 + 2 + 0，**逐条不重不漏**）：

| 行 | 路由数 | 内容 |
|---|---|---|
| `tradewatcher-core` | 16 | 其余全部：`health`/`rows`/`quotes`/`chips`/`board`/`industry`/`trades`/`backup`… |
| `tradewatcher-calendar` | 1 | `/tradewatcher/calendar` |
| `tradewatcher-watchlist` | 3 | `/watch`、`/industries`、`/anomaly` |
| `tradewatcher-portfolio` | 2 | `/portfolio`、`/ledger` |
| `tradewatcher-market` | 2 | `/breadth`、`/rescue` |
| `tradewatcher-cloudmap` | 0 | 纯客户端 iframe（只贡献 activeRows） |

> 探针把 `__kernelStats` 读了**两遍**：第一遍在"六行各就位"之后（`applies=8 / inits=1 / starts=1`），
> 第二遍在又注册一行 `all` 之后（`applies=9`，而 `inits`/`starts` **仍是 1**）⇒ 幂等跟着"一次性副作用"而不是跟着 apply 次数走。

### 4.2 YAML 本身必须能解析（**这条最要紧**：语法错是启动期硬失败）

`dsh-app-boot` 对补丁文件分两档：**解析不了 ⇒ throw**（`failed to parse patches …`，启动直接挂）；
**目标行不存在 ⇒ 只 warning**（`:3651-3655`）。所以清单的语法必须过。用 DSH 自带的那份 yaml 解析器实测：

```
$ node -e "const m=require('…/@deepseek-ai/dsh/node_modules/yaml'); const d=m.parseDocument(fs.readFileSync('cordis.patch.yml','utf8')); …"
errors = 0 | warnings = 0
顶层 = array(len=1)   insert 行数 = 6
[{"insert":[{"id":"tradewatcher-core","name":"dsh-tradewatcher","config":{"row":"core"}},
            {"id":"tradewatcher-calendar","name":"dsh-tradewatcher","config":{"row":"calendar"}},
            {"id":"tradewatcher-watchlist","name":"dsh-tradewatcher","config":{"row":"watchlist"}},
            {"id":"tradewatcher-portfolio","name":"dsh-tradewatcher","config":{"row":"portfolio"}},
            {"id":"tradewatcher-market","name":"dsh-tradewatcher","config":{"row":"market"}},
            {"id":"tradewatcher-cloudmap","name":"dsh-tradewatcher","config":{"row":"cloudmap"}}]}]
```

⇒ 结构就是"一个 `insert` 补丁 + 六行"，六行的 `config.row` 与代码的六个 row 值一一对应。

### 4.3 探针自己踩到的坑（如实记，因为它正是"断言要锚真实行为"的样本）

第一版探针的假 `ctx.effect` **登记完 disposer 就立刻 dispose** ⇒ 命中 `src/index.ts:147-150` 的
`if (disposed) { log('plugin unloaded before store init finished — rescue monitor not started'); return }`
⇒ `starts = 0`，断言红。**那是探针写错，不是插件坏**：真实 ctx 的 `effect` 只在 fiber 卸载时 dispose。
改法：`effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) }`（`src/index.test.ts` 的 `fakeCtx` 同款）。
顺带证明了"卸载早于 init 落定 ⇒ 不起采样器"这条守卫是活的。

### 4.4 `npm run check` 里的等价断言（`src/index.test.ts` 新增用例）

同一条链在测试里跑（`node --test`，中文用例名），并加了探针没有的三条：

1. manifest 驱动：行集合来自**解析 `cordis.patch.yml` 的结果**（不是硬编码的六个字符串）⇒ 清单改错会被抓。
2. **每行只注册自己那段**：功能行的每条路由都必须落在自己的前缀下、且自己的前缀一条不少；cloudmap 行路由/工具都为 0。
3. **跨行零重复**：同一路径/工具被两行各注册一次即失败（判据见 §5 的注入 2）。
4. **并集 == 老单行全量**：六行注册的路径集合与 `apply(ctx)`（无 config ⇒ `all`）注册的集合 `deepEqual` ⇒ "拆分不多不少"，
   也顺带证明**回退成单行不会丢东西**。
5. core 的"确实不含"逐条证据：`/watch`、`/industries`、`/anomaly`、`/calendar`、`/portfolio`、`/ledger`、`/breadth`、`/rescue`
   共 **八条**路径（含点名的六条）+ 它们的**任何前缀**都不在 core 的注册表里，且 core 不提供对应工具。

---

## 5. 反例注入证据（证明断言**非恒真**）

### 注入 1（代码级）：把 `applyCore(ctx, true)`（`all` 分支）当成默认

临时把 `src/index.ts` 改成"每个 row 都走全量分支"：

```diff
-  } else if (row === 'core') applyCore(ctx)
-  else applyFeatureRow(ctx, row)
+  } else if (row === 'core') applyCore(ctx, true)
+  else applyCore(ctx, true)
```

```
ℹ pass 5
ℹ fail 7
✖ calendar 行：只注册日历那一段…            AssertionError: calendar 行不许注册别的路由
✖ 功能行找不到 core ⇒ 拒绝注册…              AssertionError: 拿不到内核 ⇒ 一个路由都不注册
✖ P2：cloudmap 行启用 ⇒ rows 含 cloudmap…   AssertionError: 开启后 rows 应含 cloudmap
✖ P3：market 行只注册独占前缀…               AssertionError: core 不该再注册 /tradewatcher/breadth
✖ P4：五行关闭时三处都不在                    AssertionError: core 不该注册 /tradewatcher/calendar
✖ task-60：归属按实测调用方所在行              AssertionError: /tradewatcher/board 不该出现在 watchlist 行
✖ task-6：六行装载（manifest 驱动）           AssertionError: calendar 行不该注册 /tradewatcher/health
```

恢复：`git checkout -- src/index.ts`；恢复后 `cmp` 与注入前**逐字一致**（sha256 见下）。

### 注入 2（代码级）：只让"跨行零重复"这条断言失效

把 market 行的前缀表多加一段 `/tradewatcher/watch`（**行内隔离性成立**——它确实只注册自己声明的前缀；
但与 watchlist 行重叠）:

```
✖ task-6：六行装载（manifest 驱动）…
  AssertionError [ERR_ASSERTION]: 同一路径被两行各注册一次 ⇒ 关掉一行会连带弄坏另一行
```

（为了让这条断言先于行内隔离断言触发，用例里把"跨行零重复"排在"每行只注册自己那段"**之前**——这两条不是同一条断言的重复。）

### 注入 3（清单级，改**真实文件**）：三个注入逐个跑，跑完即恢复

| 注入 | 手段 | 结果 |
|---|---|---|
| 大写残留 | `- id: tradewatcher-market` → `- id: tradewatcher-Market` | `ℹ pass 10 / fail 2`：`真实 manifest 必须通过全部六行检查` |
| 数字后缀 | `- id: tradewatcher-market` → `- id: tradewatcher-market2` | 同上（`fail 2`） |
| 漏 `config` | 删掉 calendar 行的 `config: { row: calendar }` | 同上（`fail 2`） |

三个注入都改在**真实 `cordis.patch.yml`**上（不是字符串模拟），每次跑完立刻用备份还原，
收尾 `sha256sum -c` 通过：

```
ad6c93d7f9b1091c6f6505c151d5ffea992c51d8e6e54d77a3e5b2ce85a58f26  cordis.patch.yml   ← 六行版基线
cordis.patch.yml: 成功                                                                    ← 三次注入后校验
```

清单级注入的模拟还留在测试里（`checkManifest()` 对同一份检查同时跑真实文件与 5 个字符串注入：
改名 / 大写 / 数字后缀 / 漏 config / row 值拼错），所以**以后也不需要靠手工注入来保证断言非恒真**。

> 注入 4 号（`row: marketx`）中途还暴露过一个**假阴性陷阱**，已修：注入最初直接在**原文**上 `replace('tradewatcher-portfolio', …)`，
> 而本文件注释里也写着 `tradewatcher-portfolio` 这类字样 ⇒ 改到的是注释行、被剥掉 ⇒ 注入静默失效（断言"通过"）。
> 现在注入一律改**剥注释后的正文**，且先断言 `mutated !== body`（"这条注入必须真的改到了正文"）。

---

## 6. 用户要做什么才能看到效果（一句话）

**改完 `cordis.patch.yml` 必须重启 `dsh web` 进程**（宿主行只在启动时装载；刷新页面 / 重开侧边栏都不够）。

---

## 7. 回滚（已演练，一条命令）

**主命令**（把两个文件都退回 `HEAD` 的单行形态；`HEAD` 即 v0.58.0 提交）：

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher && git checkout HEAD -- cordis.patch.yml src/index.test.ts && echo "已回退单行，请重启 dsh web"
```

**不依赖 git 的备用命令**（只回滚清单，用 heredoc 直接写回单行）：

```bash
cd /home/hu/workspace/Servers/dsh/Dev/dsh-tradewatcher && cat > cordis.patch.yml <<'YAML'
# dsh-tradewatcher bundle patch —— **单行回退形态**（六行若在用户端出问题，用这条恢复）。
# 不带 config ⇒ row=all：全量注册，与拆分前逐字一致（老 profile 的语义）。详见 docs/AUDIT-IMPL35.md。
- insert:
    - id: tradewatcher
      name: 'dsh-tradewatcher'
YAML
```

**这条备用命令本轮已实测**：写入后 `src/index.test.ts` 跑出 `ℹ tests 12 / pass 10 / fail 2`——
红的正是那两条"锁六行"的清单断言（**这是设计如此，不代表插件坏**），10 条运行时断言全绿
（含"六行 apply 幂等 / 跨行零重复 / 并集 == 单行"——它们不读清单，只读代码）；
随后用备份还原六行，`ℹ tests 12 / pass 12 / fail 0` 且 sha256 与基线一致。
⇒ 回滚后**必须重启 `dsh web`**；如果连测试也要绿，用主命令（连测试一起退回）。

---

## 8. `npm run check` 末尾三行

原样（`tail -4`；倒数第三行是构建分段器的空行）：

```
> dsh-tradewatcher@0.58.0 build
> node build.mjs

built lib/index.js + lib/client.js （v0.58.0，客户端片段校验通过：75 项）
```

（类型门禁 + `ℹ tests 412 / pass 412 / fail 0` × 2 时区 + `ALL HOST CHECKS PASSED (live probes soft)` + 构建全通过；
`build.mjs` 未改动，75 项片段校验照旧。）

---

## 9. 未做项 / 遗留（如实列出）

1. **没有实测"重启 `dsh web` 后的真实装载"**（任务硬约束：不重启、不动 profile）。
   本轮的证据强度是：DSH 源码规则（§1）+ profile symlink/同 inode（§3）+ 真实产物探针（§4）
   + 清单与代码一致性断言（§4.3）。**最后一公里必须由 Lead 重启后验**——验收判据与观察点见 `docs/DESIGN-SUBPLUGINS.md:107`（六条），
   建议至少看：`plugin_manager list_plugins` 是否出现 `tradewatcher-core`…`tradewatcher-cloudmap` 六行且 `fiberPhase=active`、
   `GET /tradewatcher/health` 与 `/tradewatcher/rows`（`rows[]` 应为六项）是否 200、以及关掉一行后是否 404。
2. **其它文档还写着"单行 + 错误归因"**，不在本轮 write scope，未改：
   - `docs/DESIGN-SUBPLUGINS.md:140-146`「回退记录（v0.50.0）」整段（结论已被 §1 推翻，需改写为"归因纠正 + 六行已恢复"）；
   - `README.md` / `CHANGELOG.md` 里指向 `cordis.patch.yml:3-9`「唯一权威记录」的行；
   - `src/index.ts:12` 的文件头注释仍写着"老 profile（没有 `config.row`）⇒ row = `core`"，与 `rowOf` 的真实缺省
     `all`（`src/index.ts:99-111`）**相矛盾**——**代码是对的、注释是旧的**；因"代码不改"约束本轮未动（改注释不属 write scope）。
3. **profile 层的 `- id: tradewatcher`（`disabled: false`）未改**（硬约束：不动 profile）。
   重启后它应表现为一条 "unknown target … skipped" warning；要清爽就按 §3.1 换成六条行开关。
4. **`/tradewatcher/rows` 的客户端 gate** 在六行下的实际观感（六个 tab 全在）未在浏览器里目视确认——
   逻辑层已有 `tabsGate` 测试覆盖，重启后看一眼即可。
5. **同一 row 出现两条 Loader 行（配置错误）会重复注册路由**：本轮的"零重复"只保证"六条不同 row 之间"不重叠；
   同一 `id` 重复出现时 Cordis 自己会因重复 service/entry id 报错，不在本轮范围（`src/index.test.ts:127` 的注释已记这条边界）。

---

## 附：本轮做过的事故与恢复（可审计性）

| 操作 | 校验 |
|---|---|
| 三次改真实 `cordis.patch.yml` 做注入 | 每次改完立刻 `cp /tmp/cordis.patch.yml.sixrows` 还原；收尾 `sha256sum -c` 通过 |
| 两次改 `src/index.ts` 做注入 | 每次 `git checkout -- src/index.ts` 还原；`cmp` 与注入前逐字一致 |
| 一次演练回滚命令（写单行清单） | 用 `/tmp/keep-six.yml` 还原；`sha256sum -c` 通过（`ad6c93d7…`） |
| 收尾工作区状态 | `git status --short` = `M cordis.patch.yml`、`M src/index.test.ts`（+ 本文件未跟踪）；`git diff --stat` 里**没有 `build.mjs`** |

---

## 10. task-7 追加：三处旧文本的错误归因已修正（**只改文字与注释**）

> 本节由 task-7 追加（v0.59.0 已把六行 manifest 落地，§1–§9 是那一轮的记录）。
> 目标：把**还写着旧归因**的文本改成事实 —— 报错对象是**不同的加载源**（`sourceKey`），不是"同一个源的多个 row"；
> 当年真凶是 `apply` 读 `ctx.config`（Proxy 未 inject 即抛），**1 行 6 行同样打死**；六行已于 v0.59.0 恢复。

### 10.1 改动清单

| # | 文件 | 改动 |
|---|---|---|
| ① | `docs/DESIGN-SUBPLUGINS.md` | 抬头（`:3`）状态改为「**已落地（v0.59.0 / `a2066e1`）**」+ 一行归因纠正块（引文 `sourceKey` 机制 + `ctx.config` 真凶）；「回退记录（v0.50.0）」**整节改写**为「**归因纠正与恢复记录**」（三段结论 + 代码级证据表 + 真凶一节 + 仍然成立/仍然未验证）；§5 的「验收判据（**未执行**）」改为「静态口径已验证、真实装载待装机」；§P0 与 §5.1 里的"缺省 `core`"改为 **`all`**；§5.1 的 `cordis.patch.yml:13-15` 指针改为现行 **`:38-56`**，并给 §5.1 加一行"这是设计轮次的计划书、行号为当时值"的前置说明。**同类的过时"现状"陈述一并修正（三处，改的是同一类事实）**：`:8`（"现状：单行 bundle…将来重试"→"现状（v0.59.0 起）：六行 bundle 已生效"）、§1.3 抬头加"**快照说明**：下表是 v0.44.0 迁移前的现场"、§7 标题由「明确不做 / 未验证」改为「明确不做」并把未验证项指向文末新节 |
| ② | `README.md`「子组件与开关」 | 行清单的权威处改指**本包 `cordis.patch.yml:38-56`**（并列出六个 id）；落地记录由 `AUDIT-IMPL12–15` 改为 `docs/AUDIT-IMPL35.md`；**新增**"怎么关一行"（profile 层 `- id: tradewatcher-<row>` + `disabled: true`）与"**必须重启 `dsh web`**"、"`core` 行别关" |
| ② | `CHANGELOG.md` | 三处历史陈述加**相邻纠正标记**（保留原文以存史，不篡改历史记录；原文行号是改动前的值，标记现在落在 `:316`/`:562`/`:571`）：`:315`（v0.32 时代的「未落地 / 未执行 / 回退记录」doc 整理）、`:560`（v0.45.3「上一轮回退仍然有效且必要」）、`:569`（v0.45.2 第 3 条「同包六行会被整体拒绝 ⇒ 得走每个子组件各自一个包」）；另把 v0.44.0 那句"同包多 resolve 属 composition error"**改写为**"同一个包被**多个解析源** resolve 才属；**同一源的多个 row 不算**"——那句歧义正是当初误读的来源 |
| ③ | `src/index.ts:12` | 注释"缺省 row = `core`"改为 **`all`（全量；不是 `core`）**，并写明"给 `core` 会把自选/持仓/大盘/日历的路由一起 404（v0.45.1 实测踩到）"、口径见 `rowOf`（`:104-111`） |

**README / CHANGELOG 里其实已经没有 `cordis.patch.yml:3-9` 这个指针**了（R21 那轮评审已收敛掉了）——
残留的是同类的**过时落点**（`AUDIT-IMPL12–15`、「未落地」抬头），本轮按同一意图修正；这一点如实记下，避免任务描述与文件状态对不上。

### 10.2 纪律自查

- **零行为改动（有哈希证据）**：改注释前后各构建一次 ⇒
  `lib/index.js` = `25bb8cbaa5035e67be5ec3d8b1814b32d8ff0aab0a99a2cae05a2f8d913de62e`、
  `lib/client.js` = `8fa44f3292006e532bd12c76ef379092dad5c951c9dc68689234f0238902c914`，**逐字一致**
  （esbuild 不把普通注释带进产物）。
- **行数中性**：`src/index.ts` 仍是 **269** 行 —— 注释**压成一行**（而不是拆三行），
  这样本文件 §1–§9 里所有 `src/index.ts:NNN` 锚点（`:85`/`:104`/`:127`/`:205`/`:253`…）**全部继续有效**。
  （第一版把它拆成了三行、行数 271 ⇒ 会让本文件十几处锚点集体漂移 +2，已改回。）
- **全仓 grep 自查**（`composition error` / `多个活跃 Loader 源` / `多行会被整体拒绝` / `只装一行` / `未落地`）逐条结论：
  - **保留且本来就正确**：本文件 §1、`cordis.patch.yml:14-16`（纠正注释本身）、`CHANGELOG.md:18-19`（v0.59.0 条目）、
    `docs/DESIGN-SUBPLUGINS.md:38`（英文原句引用；其结论"client 半区是包级单实例、不能按行拆"**仍然成立**）、
    `src/index.ts:99`（`rowOf` 的 `all` 缺省说明）。
  - **已加纠正标记的历史段落**：`CHANGELOG.md:315`、`:560`、`:569`。
  - **不在本轮 write scope、未改的两处遗留**（交给 Lead 决定）：
    ① `docs/STE-REVIEW-DOCS.md:15`（一条评审建议表，建议把 `DESIGN-SUBPLUGINS.md` 抬头写成"未落地 + `cordis.patch.yml:3-9`"，现已过时）；
    ② `docs/AUDIT-IMPL23.md:13`/`:20`（上一轮的自述报告，按"一次性报告 = 时间点记录"的惯例保留原文）。
- `build.mjs` **零改动**；未装 bundle、**未动 profile**（`- id: tradewatcher` 那条按 Lead 决定保留，重启后只多一条 warning）、未 commit、未重启。

### 10.3 验收（`npm run check`）

```
ℹ tests 412 / pass 412 / fail 0        （本地时区）
ℹ tests 412 / pass 412 / fail 0        （TZ=UTC）
ALL HOST CHECKS PASSED (live probes soft)
```

末尾四行（倒数第三行是构建分段器的空行）：

```
> dsh-tradewatcher@0.59.0 build
> node build.mjs

built lib/index.js + lib/client.js （v0.59.0，客户端片段校验通过：75 项）
```

### 10.4 本轮工作区状态

`git status --short`：`M README.md`、`M CHANGELOG.md`、`M docs/DESIGN-SUBPLUGINS.md`、`M src/index.ts`、`M docs/AUDIT-IMPL35.md`
（全部为文字/注释；`git diff` 里**没有 `build.mjs`**、没有 `cordis.patch.yml`、没有 `src/index.test.ts`）。
