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
 * 注意：该 bundle 把中文转义为大写 \uXXXX，比对时必须按大写形式，否则会得到假阴性。
 */
const escapeUpper = (text) =>
  [...text].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c)).join('')

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
  '滞后',                    // 顶栏"数据滞后"标记（真实 asOf/stale）
  '上次结果',                // 底部视图的保留视图标记（校准暂不可用）
  '台熔断',                  // 护盘面板的熔断聚合横幅
  '自选排序',                // 自选页排序段控（aria-label）
  '持仓排序',                // 持仓页排序段控（aria-label）
  '仓位占比',                // 持仓排序键「仓位占比」
]

const clientBundle = readFileSync('lib/client.js', 'utf8')
// 版本号必须真的注入客户端包（esbuild define 生效）
if (!clientBundle.includes(TW_VERSION)) {
  console.error(`\n构建校验失败：lib/client.js 未包含版本号 ${TW_VERSION}（__TW_VERSION__ 注入未生效）\n`)
  process.exit(1)
}
const missing = REQUIRED_CLIENT_SNIPPETS.filter(
  (snippet) => !clientBundle.includes(snippet) && !clientBundle.includes(escapeUpper(snippet)),
)
if (missing.length > 0) {
  console.error(`\n构建校验失败：lib/client.js 缺少以下 UI 片段 —— ${missing.join(' / ')}`)
  console.error('（通常是补丁未匹配导致源码里根本没有这段代码，或该段被条件守卫整体跳过）\n')
  process.exit(1)
}

console.log(`built lib/index.js + lib/client.js （v${TW_VERSION}，客户端片段校验通过：${REQUIRED_CLIENT_SNIPPETS.length} 项）`)
