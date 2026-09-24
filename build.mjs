import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'

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
  define: { 'process.env.NODE_ENV': '"production"' },
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
  define: { 'process.env.NODE_ENV': '"production"' },
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
  '当日通道复盘',            // 上游不可用时的复盘表
  '曾达异动线',              // 复盘表状态列
  '无实时数据：本次快照没有因子得分', // 因子表空态提示
  '上游行情暂时不可用',      // 熔断横幅
  '今日信号时间线',          // 时间线（曾在守卫里被误隐藏）
  '分时量能',
  '护盘信号',
]

const clientBundle = readFileSync('lib/client.js', 'utf8')
const missing = REQUIRED_CLIENT_SNIPPETS.filter(
  (snippet) => !clientBundle.includes(snippet) && !clientBundle.includes(escapeUpper(snippet)),
)
if (missing.length > 0) {
  console.error(`\n构建校验失败：lib/client.js 缺少以下 UI 片段 —— ${missing.join(' / ')}`)
  console.error('（通常是补丁未匹配导致源码里根本没有这段代码，或该段被条件守卫整体跳过）\n')
  process.exit(1)
}

console.log(`built lib/index.js + lib/client.js （客户端片段校验通过：${REQUIRED_CLIENT_SNIPPETS.length} 项）`)
