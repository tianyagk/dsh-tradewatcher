import { build } from 'esbuild'
import { rmSync } from 'node:fs'

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

console.log('built lib/index.js + lib/client.js')
