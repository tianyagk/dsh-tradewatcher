import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'

/**
 * 类型门禁：构建前先 tsc --noEmit，失败即中断。
 * 此前 build.mjs 只用 esbuild（不做类型检查），而 typecheck 脚本无人调用 ——
 * 双端共享契约漂移（例如 api.ts 的 source 联合类型漏了 'sina'）没有任何编译期保护。
 * 需要临时跳过（例如调试构建）时设 TW_SKIP_TYPECHECK=1。
 *
 * 两种失败必须分开报：**tsc 根本没起来**（没装 devDependencies、路径不对、权限）
 * 与**类型检查不通过**是完全不同的处置 —— 前者报"类型错误"会让人去翻一个并不存在的
 * 类型问题。`execFileSync` 的错误对象里 `status` 是子进程退出码，只在真的跑起来时才有。
 */
if (process.env.TW_SKIP_TYPECHECK !== '1') {
  try {
    execFileSync('node_modules/.bin/tsc', ['--noEmit', '-p', 'tsconfig.json'], { stdio: 'inherit' })
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : null
    if (status === null) {
      const reason = error?.code ?? error?.message ?? String(error)
      console.error(`\n构建中断：无法启动 tsc（${reason}）。`)
      console.error('这通常是依赖未安装：先在项目根目录跑 `npm i`（需要 devDependencies 里的 typescript）。')
      console.error('确认不需要类型门禁时可设 TW_SKIP_TYPECHECK=1 临时跳过。\n')
      process.exit(2)
    }
    if (typeof error?.signal === 'string') {
      console.error(`\n构建中断：tsc 被信号 ${error.signal} 终止（可能是内存不足或被外部杀掉）。\n`)
      process.exit(3)
    }
    console.error(`\n构建中断：类型检查未通过（tsc --noEmit，退出码 ${status}）。修好后再构建，或设 TW_SKIP_TYPECHECK=1 临时跳过。\n`)
    process.exit(1)
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const TW_VERSION = String(pkg.version ?? '0.0.0')

rmSync('lib', { recursive: true, force: true })

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
]

const banner = `window.__ModuleLoader__.load({
\tid: "dsh-tradewatcher",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;`

const footer = `return module.exports;
\t}
});`

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"', __TW_VERSION__: JSON.stringify(TW_VERSION) },
})

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  sourcemap: false,
  external: CLIENT_EXTERNALS,
  jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"production"', __TW_VERSION__: JSON.stringify(TW_VERSION) },
  banner: { js: banner },
  footer: { js: footer },
})

/**
 * 构建期硬校验：确认关键 UI 片段真的进了产物。
 *
 * 起因：v0.13.2 的复盘表在客户端源码里**从未插入**（脚本补丁因缩进不匹配静默失败），
 * 而 tsc、host selftest、构建全部通过 —— 这类"少了一段 JSX"的失败只有对着产物查才拦得住。
 * 注意：esbuild 会把非 ASCII 字符转义，且**分两种形式**（都是大写十六进制）：
 *   - 码位 ≤ 0xFF（`·` U+00B7、`¥` U+00A5）→ `\xHH` 两位；
 *   - 码位 > 0xFF（汉字、全角标点）→ `\uXXXX` 四位。
 * 曾经只按 `\uXXXX` 一种形式比对，于是含有 `·` / `¥` 的片段一律报"缺少 UI 片段"——
 * 校验器自己的假阴性比漏检更浪费时间（会让人去源码里找一个其实存在的字符串）。
 */
const escapeUpper = (text) =>
  [...text].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c)).join('')

/** esbuild 实际使用的转义形式：≤0xFF 用 \xHH，其余用 \uXXXX */
const escapeEsbuild = (text) =>
  [...text].map((c) => {
    const code = c.charCodeAt(0)
    if (code <= 127) return c
    const hex = code.toString(16).toUpperCase()
    return code <= 0xff ? `\\x${hex.padStart(2, '0')}` : `\\u${hex.padStart(4, '0')}`
  }).join('')

const REQUIRED_CLIENT_SNIPPETS = [
  '当日记录',                // 上游不可用时的当日记录条
  '复盘',                    // 复盘态卡片标记
  '自定义通道',              // 设置里的自定义通道
  '板块',                    // 自定义通道卡片标记
  '5 分钟抽样',              // 复盘区的当日记录条
  '最高评分',                // 复盘区当日记录
  '无实时数据：本次快照没有因子得分', // 因子表空态提示
  '东财行情主机',            // 熔断横幅（文案按"影响范围"改写，断言同步更新）
  '下次开盘自动重试',        // 收盘后不再承诺"N 分钟可重试"
  '腾讯备用源兜底',          // 横幅必须说清兜底结论（旧文案谎称"显示当日复盘数据"）
  '采样失败',                // 数据时刻 vs 失败时刻分离后的标记
  '当日有采样缺口',          // gap 语义修正后的措辞
  '今日信号时间线',          // 时间线（曾在守卫里被误隐藏）
  '分时量能',
  '护盘信号',
  '底部位置 / 形态 / 概率',   // 底部视图面板
  '历史同类情形的频率',        // 概率口径说明（防止被当成预测）
  '板块涨跌来自腾讯备用源',     // 板块栏的来源标注
  '「主力净流入」仅东财提供',   // 备用源下资金流不可用的说明
  // v0.25.0（P0 批次）：口径与状态外化的关键片段 —— 这些字符串来自用户可见文案，
  // 一旦补丁/重构把它们丢掉，构建就该失败（历史上的"少了一段 JSX"正是这样漏出去的）
  '状态：',                  // 逐卡四态 tooltip（quoteState.ts）
  '当根未收盘',              // 详情图口径条（P0-5）：MA 是否含未收盘当根
  '采样暂停 · 下次',          // 护盘非活跃时段的显式态（P0-4）
  '贡献',                    // 因子贡献度列（P0-7）
  '隐身',                    // 三档视图（P0-8）
  '可以导入',                // 备份导入前的校验结论（P0-9）
  '秒内加载',                // 云图超时占位（P0-10）
  '不含 ',                   // 未计入总额的可下钻标记（P0-1）
  '¥••••',                   // 隐身模式的金额遮罩（P0-8）
  // v0.26.0（P1 批次：共同功能补强）
  '净占比',                  // 资金流排行的占比口径列（P1-7）
  '可用（可卖）',            // T+1/T+0 可用数量列（P1-5）
  '累计费用',                // 费用合计 + 占成交额比例（P1-5）
  '区间内无买卖点',          // 缩放区间外的 B/S 图例（P1-2）
  '样本少',                  // 概率面板的小样本标记（P1-9）
  '95% 区间',                // Wilson 区间（P1-9）
  '振幅',                    // 缩略图 hover 的开/高/低/振幅（P1-1）
  '区间外另有',              // 缩放区间外仍有买卖记录的提示（P1-2）
  '板块涨跌与 α 本次未取到',  // 行业接口失败的如实告知（P1-3）
  '上次结果',                // 底部视图的保留视图标记（校准暂不可用）
  '台熔断',                  // 护盘面板的熔断聚合横幅
  '自选排序',                // 自选页排序段控（aria-label）
  '持仓排序',                // 持仓页排序段控（aria-label）
  '仓位占比',                // 持仓排序键「仓位占比」
  '暂无可用行情源',           // 三源都没有该标的时与「暂无行情」区分
  '仅东财源',                // 搜索结果里只有东财一条链路的标注
  '无行情源 ',               // 顶栏"无行情源 N"标记
  '已截断 160',              // 超过 160 项上限时的如实回报
  '留空即清除',              // 分组备注模态（此前绑错状态，保存无效）
  '总额不含',                // 无价持仓被按 0 计入时，总额要标注不含它们
  '点击查看详情',            // 悬浮卡脚注：卡片可点开详情图
  '点击打开详情',            // 顶栏卡片的 aria-label
  '休市定稿缓存',            // 客户端复用了宿主的定稿数据（零回源）
  '显示上次成功数据',        // 刷新失败但仍有旧图时的诚实标注
  '本地缓存',                // 命中客户端 TTL 缓存
  '复权口径',                // 详情图复权段控（aria-label）
  '前复权',                  // 默认口径（除权跳空会让历史 K 线出现无解释的暴跌）
  '后复权',
  '不复权',
  '不适用',                  // 指数/期货无除权除息，开关必须禁用并给理由
  'sidebar.panellist',      // dsh 0.2 客户端扩展面：侧栏图标席位（旧 betterSidebar 已移除）
  'slots.register',         // 面板注册必须走 Slots 服务，否则界面整个不会出现
]

const clientBundle = readFileSync('lib/client.js', 'utf8')
// 版本号必须真的注入客户端包（esbuild define 生效）
if (!clientBundle.includes(TW_VERSION)) {
  console.error(`\n构建校验失败：lib/client.js 未包含版本号 ${TW_VERSION}（__TW_VERSION__ 注入未生效）\n`)
  process.exit(1)
}
const missing = REQUIRED_CLIENT_SNIPPETS.filter(
  (snippet) =>
    !clientBundle.includes(snippet) &&
    !clientBundle.includes(escapeUpper(snippet)) &&
    !clientBundle.includes(escapeEsbuild(snippet)),
)
if (missing.length > 0) {
  console.error(`\n构建校验失败：lib/client.js 缺少以下 UI 片段 —— ${missing.join(' / ')}`)
  console.error('（通常是补丁未匹配导致源码里根本没有这段代码，或该段被条件守卫整体跳过）\n')
  process.exit(1)
}

console.log(`built lib/index.js + lib/client.js （v${TW_VERSION}，客户端片段校验通过：${REQUIRED_CLIENT_SNIPPETS.length} 项）`)
