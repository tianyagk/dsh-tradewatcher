/**
 * v0.62.0（task-10）：云图**只留第三方站点**。
 *
 * 用户要求下线内建热力视图（截图里的 `自绘 / 第三方站点` 段控 + 「行业热力（自绘）」）。
 * 本文件锚三件事：
 *   ① 内建视图与段控**彻底移除**（全仓无残留字样，含 `title`/`aria-label`）；
 *   ② 第三方 iframe 与其三态（loading / loaded / timeout）**不变**，timeout 给域名 + 最后成功时间；
 *   ③ 反例注入：把字样加回**渲染位置** ⇒ ①的判据必须失败。
 *
 * ⚠ 扫描边界（写进报告）：
 *   - **排除本文件自身**：它必须写出那两个待查字样才能 grep（否则自己命中自己，恒假）。
 *   - **排除 `docs/**` 与 `CHANGELOG.md`**：它们要能描述"这次删了什么"。
 *   - **不排除任何 `src/**` 实现文件**（含 `CloudMap.tsx` / `src/index.ts`）：实现里不许再有该字样。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url)) // src/client
const SRC = join(here, '..') // src/
const THIS_FILE = fileURLToPath(import.meta.url)

/** 待查字样：内建热力视图的组件名与它唯一的来源标记 */
const REMOVED_TOKENS = ['IndustryHeatmap', '自绘'] as const
/** 段控的标志类名与状态（只剩一个选项的控件不该存在） */
const SEGMENT_MARKERS = ['tw-seg', 'setSource', "source === 'self'"] as const

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

/**
 * 返回**违规清单**（空 = 干净）。把本文件排除在扫描外，其余 `src/**` 一律扫。
 * 真源码必须为空；把字样加回渲染位置必须非空 ⇒ 断言非恒真。
 */
function removalViolations(override?: { path: string; text: string }): string[] {
  const bad: string[] = []
  for (const f of walk(SRC)) {
    if (f === THIS_FILE) continue // 本文件自己要写出这些字样
    const text = override !== undefined && override.path === f ? override.text : readFileSync(f, 'utf8')
    for (const tok of REMOVED_TOKENS) {
      if (text.includes(tok)) bad.push(`${relative(SRC, f)} 仍含 ${tok}`)
    }
  }
  return bad
}

/** 段控与内建视图的渲染痕迹（只在 CloudMap.tsx 里查，锚真实文件） */
function segmentViolations(cloudMapSrc: string): string[] {
  const bad: string[] = []
  for (const m of SEGMENT_MARKERS) {
    if (cloudMapSrc.includes(m)) bad.push(`CloudMap.tsx 仍有段控痕迹 ${m}`)
  }
  for (const m of ['IndustryHeatmap', '自绘']) {
    if (cloudMapSrc.includes(m)) bad.push(`CloudMap.tsx 仍含 ${m}`)
  }
  return bad
}

test('① 内建热力视图与「段控」彻底移除（全仓 src/** 无残留字样；title/aria-label 也没有）', () => {
  assert.deepEqual(removalViolations(), [], `全仓 src/** 必须无残留（实际：${JSON.stringify(removalViolations())}）`)
  const cloudMap = readFileSync(join(here, 'CloudMap.tsx'), 'utf8')
  assert.deepEqual(segmentViolations(cloudMap), [], 'CloudMap.tsx 不许留段控或内建视图痕迹')
  // 被删的文件本身也不该再存在
  for (const f of ['IndustryHeatmap.tsx', 'treemap.ts', 'treemap.test.ts']) {
    assert.throws(() => readFileSync(join(here, f)), /ENOENT/, `${f} 必须已删除`)
  }
  // `tw-seg` 是**通用**段控样式类（别处仍在合法使用）⇒ 只断言云图不再用它，
  // 并反证该类没被误删（否则就是"为了删一个控件把公共样式拆了"）
  const users = walk(SRC).filter((f) => f !== THIS_FILE && readFileSync(f, 'utf8').includes('tw-seg'))
  assert.equal(users.some((f) => f.endsWith('CloudMap.tsx')), false, 'CloudMap 不许再用 tw-seg')
  assert.ok(users.length >= 2, `tw-seg 仍是别处在用的公共类（实际用户：${users.map((f) => f.split('/').pop()).join(', ')}）`)
  assert.ok(readFileSync(join(here, 'styles.ts'), 'utf8').includes('.tw-seg'), 'styles.ts 里 .tw-seg 定义必须保留（别处还在用）')

  // 反例 ①：把内建视图的标题加回 CloudMap 的渲染位置 ⇒ 判据必须非空
  const injectedRender = cloudMap.replace(
    "React.createElement('span', { className: 't' }, `大盘云图 · A股热力图（${CLOUD_MAP_HOST}）`),",
    "React.createElement('span', { className: 't' }, `大盘云图 · A股热力图（${CLOUD_MAP_HOST}）`),\n      React.createElement('span', { className: 't', title: '行业热力（自绘）' }, '行业热力（自绘）'),",
  )
  assert.notEqual(injectedRender, cloudMap, '反例注入必须真的改到源码（锚点还在）')
  const v1 = segmentViolations(injectedRender)
  assert.notDeepEqual(v1, [], '⚠ 反例（把内建视图标题加回渲染位置）必须被判据抓住')
  assert.throws(() => assert.deepEqual(v1, [], '反例上"不许留痕迹"必须失败'), /反例上/,
    '⚠ 反例注入必须让断言失败')
  // 反例 ②：把段控加回来（只剩一个选项的控件）⇒ 同样必须非空
  const injectedSeg = cloudMap.replace(
    "React.createElement('span', { className: 'tw-hint', style: { margin: 0 } }, '面积=流通市值 · 双击看K线'),",
    "React.createElement('div', { className: 'tw-seg' }, React.createElement('button', { 'data-on': true }, '第三方站点')),",
  )
  assert.notEqual(injectedSeg, cloudMap, '反例注入必须真的改到源码')
  assert.notDeepEqual(segmentViolations(injectedSeg), [], '⚠ 反例（段控加回）必须被判据抓住')
  // 反例 ③：把字样放进一个**别的**实现文件 ⇒ 全仓扫描必须非空（证明扫描覆盖面真实）
  const fakePath = join(SRC, 'index.ts')
  const v3 = removalViolations({ path: fakePath, text: readFileSync(fakePath, 'utf8') + "\n// 自绘\n" })
  assert.notDeepEqual(v3, [], '⚠ 反例（把字样放进 src/index.ts）必须被判据抓住（扫描确实覆盖实现文件）')
})

test('② 第三方站点保留：三态各一例；timeout 给域名 + 最后成功时间', () => {
  const src = readFileSync(join(here, 'CloudMap.tsx'), 'utf8')
  // 三态：state 的三个取值与各自的可见文案（既有行为，逐条锚源码）
  assert.ok(src.includes("type LoadState = 'loading' | 'loaded' | 'timeout'"), '三态类型在')
  assert.ok(src.includes("state === 'loading' ? '加载中…' : state === 'loaded' ? '已完成' : '加载超时'"),
    '三态各自的可见文案（加载中… / 已完成 / 加载超时）')
  // timeout 占位：域名 + 最后成功时间（不是一块空白 iframe）
  assert.ok(src.includes('无法在 ${TIMEOUT_MS / 1000} 秒内加载 ${CLOUD_MAP_HOST}'), 'timeout 占位必须给出**域名**')
  assert.ok(src.includes('最后成功加载：${lastOkText}'), 'timeout 占位必须给出**最后成功时间**')
  assert.ok(src.includes("? '尚无成功记录'"), '没有成功记录时的文案（不写成 0/空）')
  // iframe 仍在，且超时后移出布局
  assert.ok(src.includes("React.createElement('iframe', {"), '第三方 iframe 必须在')
  assert.ok(src.includes('src: CLOUD_MAP_URL'), 'iframe 指向第三方源站')
  assert.ok(src.includes("display: state === 'timeout' ? 'none' : 'block'"), '超时后 iframe 移出布局')
  // 三态映射（纯逻辑复算，锚真实常量）：超时阈值与源站常量都在
  const timeout = Number(/const TIMEOUT_MS = (\d+)/.exec(src)?.[1] ?? NaN)
  assert.equal(timeout, 8000, '超时阈值必须仍是 8s（既有行为）')
  const host = /const CLOUD_MAP_URL = '([^']+)'/.exec(src)?.[1]
  assert.equal(host, 'https://52etf.site/', '第三方源站必须仍是同一处引用（域名不散落）')
  // 不得新增常驻可见文案：面板头只有标题 + 既有 hint + 徽标 + 状态 + 两个按钮
  const headers = [...src.matchAll(/className: 'tw-hint', style: \{ margin: 0 \} \}, '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(headers, ['面积=流通市值 · 双击看K线'], `面板头的 hint 必须仍是这一句（实际 ${JSON.stringify(headers)}）`)
})
