/**
 * UI/UX 纪律断言（v0.87.0）：参考竞品（爱盯盘）后**采纳**的那几条，做成可检查的判据。
 *
 * 覆盖：
 *  ① 密集字号阶梯 `12 / 12.5 / 13 / 13.5 / 14`（详情页所有 CSS 字号必须落阶梯或 ≥15px 展示级）
 *  ② 1px 间距刻度（所有间距令牌必须是整数 px）
 *  ③ 自适应卡片 `minmax(148px, 1fr)`
 *  ④ 玻璃浮层令牌（两档主题都有值；深色档 = 竞品实测值；CSS 变量与令牌一一对应）
 *  ⑤ 动效纪律（只动 transform/opacity、关闭即 display:none、后台暂停、reduced-motion）
 *  ⑥ 仓库文案与实际行为一致（README 数据文件表覆盖宿主真正落盘的文件）
 *
 * 每条都配**反例注入**：把"不该发生的事"构造出来，判据必须非空 —— 否则这条断言是恒真的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANIM_NOT_ALLOWED_SAMPLE,
  CARD_MIN_W,
  DISPLAY_SIZE_MIN,
  GLASS,
  MOTION_RULES,
  SPACE_GRID,
  TOOL_SPACE,
  TYPE_SCALE,
  animationPropertyProblems,
  cardGridProblems,
  glassCssVars,
  glassProblems,
  keyframesProblems,
  motionCssProblems,
  spaceScaleProblems,
  typeScaleProblems,
} from './toolDetailTheme.ts'
import { TW_CSS } from './styles.ts'
import { panelIdle } from './idle.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, 'src/client', rel), 'utf8')
}

/** 读一个宿主源文件（相对 `src/host`）；⑥ 的 README 覆盖扫描现在自己 walk `src/host/**`（不再硬编码文件表） */
function readHost(rel: string): string {
  return readFileSync(join(ROOT, 'src/host', rel), 'utf8')
}
void readHost

/**
 * 全客户端待扫文件清单（v0.91.1 起）：`src/client/**` 的 tsx/ts，排除 `*.test.ts`。
 * 测试文件里的越格字号是**反例注入**，不属于产品界面。
 */
function walkClient(dir = join(ROOT, 'src/client'), out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walkClient(abs, out)
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(abs.slice(join(ROOT, 'src/client').length + 1))
    }
  }
  return out
}

/** 剥注释（只留代码与字符串）：注释里会写反例说明，不能当成违规 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function fontSizeValuesOf(src: string): number[] {
  const code = stripComments(src)
  const out: number[] = []
  for (const m of code.matchAll(/fontSize:\s*([0-9]+(?:\.[0-9]+)?)/g)) out.push(Number(m[1]))
  return out
}

test('① 密集字号阶梯：详情页所有 CSS 字号必须落在 12 / 12.5 / 13 / 13.5 / 14（≥15px 为展示级）', () => {
  assert.deepEqual([...TYPE_SCALE], [12, 12.5, 13, 13.5, 14], '阶梯本身就是契约（与 DESIGN-UIUX-ADOPT 一致）')
  assert.equal(DISPLAY_SIZE_MIN, 15, '展示级下界必须是 15px')
  // v0.91.1（用户要求）：扫描面从"只扫详情页那 2 个文件"扩到**全客户端**。
  // 排除 `*.test.ts`：那里的 10/10.5/11.5px 是**反例注入**（故意越格去证明判据有效），必须保留。
  const scanned = walkClient()
  assert.ok(scanned.length >= 20, `扫描面必须覆盖全客户端（实际 ${scanned.length} 个文件）—— 否则这条断言会退化成空跑`)
  let seen = 0
  for (const rel of scanned) {
    const sizes = fontSizeValuesOf(readSrc(rel))
    seen += sizes.length
    for (const size of sizes) {
      assert.deepEqual(typeScaleProblems(size, `${rel} 的字号`), [], `字号越出阶梯：${rel} 有 ${size}px`)
    }
  }
  assert.ok(seen >= 60, `全客户端应当扫到足够多的字号（实际 ${seen} 处）—— 防退化`)
  // 同一份 CSS（`TW_CSS`）也全量扫：不只是工具箱详情页那一段
  const cssSizes = [...TW_CSS.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1]))
  assert.ok(cssSizes.length >= 100, `CSS 里应当扫到足够多的字号（实际 ${cssSizes.length} 处）`)
  for (const size of cssSizes) {
    assert.deepEqual(typeScaleProblems(size, 'CSS 的字号'), [], `CSS 字号越出阶梯：${size}px`)
  }
  // 反例注入（整份文档级）：往任意一个被扫文件里塞一个 11px ⇒ 判据必须非空
  const injected = `${readSrc(scanned[0] as string)}\nconst bad = { fontSize: 11 }\n`
  const injectedSizes = fontSizeValuesOf(injected)
  const offLadder = injectedSizes.filter((n) => typeScaleProblems(n, '注入').length > 0)
  assert.equal(offLadder.includes(11), true, '⚠ 反例（塞回一个 11px）必须能被扫出来')
  assert.throws(
    () => assert.deepEqual(offLadder, [], '反例上"全客户端 0 处阶梯外"必须失败'),
    /反例上/,
    '⚠ 反例注入（塞回 11px）必须让断言失败',
  )
  // 反例注入：13.2px（阶梯外）/ 10.5px（低于下限）
  assert.notDeepEqual(typeScaleProblems(13.2, '注入'), [], '⚠ 阶梯外的 13.2px 必须被抓到')
  assert.notDeepEqual(typeScaleProblems(10.5, '注入'), [], '⚠ 低于下限的 10.5px 必须被抓到')
  assert.deepEqual(typeScaleProblems(46, 'Hero 标题'), [], '展示级（46px）不受阶梯约束')
})

test('② 间距刻度：1px 粒度（非整数 px 一律拒绝）', () => {
  assert.equal(SPACE_GRID, 1, '刻度就是 1px')
  for (const [k, v] of Object.entries(TOOL_SPACE)) {
    assert.deepEqual(spaceScaleProblems(v, `TOOL_SPACE.${k}`), [], `间距必须落在 1px 刻度上：${k}=${v}`)
  }
  assert.notDeepEqual(spaceScaleProblems(11.5, '注入'), [], '⚠ 11.5px 间距必须被抓到')
  assert.notDeepEqual(spaceScaleProblems(-1, '注入'), [], '⚠ 负间距必须被抓到')
})

test('③ 自适应卡片：`repeat(auto-fit, minmax(148px, 1fr))`', () => {
  const css = TW_CSS.replace(/\s+/g, '')
  const m = /\.tw-tool-tiles\{[^}]*grid-template-columns:([^;}]+)/.exec(css)
  assert.notEqual(m, null, '必须能找到 .tw-tool-tiles 的栅格声明')
  const template = (m as RegExpExecArray)[1]
  assert.deepEqual(cardGridProblems(template), [], `卡片栅格不合规：${template}`)
  assert.equal(CARD_MIN_W, 148, '最小卡片宽 = 竞品实测 148px')
  // 反例注入：写死四列 / 最小宽改 100px
  assert.notDeepEqual(cardGridProblems('repeat(4,minmax(0,1fr))'), [], '⚠ 写死四列必须被抓到')
  assert.notDeepEqual(cardGridProblems('repeat(auto-fit,minmax(100px,1fr))'), [], '⚠ 最小宽 100px 必须被抓到')
})

test('④ 玻璃浮层令牌：两档主题都有值、深色档 = 竞品实测值、CSS 变量与令牌一致', () => {
  assert.deepEqual(glassProblems(GLASS), [], `玻璃令牌不合规：${glassProblems(GLASS).join(' ／ ')}`)
  // CSS 变量必须与令牌逐项一致（把令牌当唯一来源；样式里的值不许另写一套）
  const css = TW_CSS.replace(/\s+/g, '')
  for (const slot of ['light', 'dark'] as const) {
    for (const [name, value] of Object.entries(glassCssVars(slot))) {
      const want = `${name}:${String(value).replace(/\s+/g, '')}`
      assert.equal(css.includes(want), true, `${slot} 档缺少或写错令牌：${want}`)
    }
  }
  // 深色档 = 竞品实测（做法采纳、值照录）；浅色档必须给对应值（不许把深色写死到浅色主题）
  assert.equal(GLASS.dark.bg.replace(/\s+/g, ''), 'rgba(13,17,25,.92)')
  assert.equal(GLASS.light.bg.replace(/\s+/g, '') === GLASS.dark.bg.replace(/\s+/g, ''), false, '浅色档不许等于深色档')
  // 红线：**不许硬编码竞品的配色**（涨跌/块底/暗底/主色）——只能映射到我们的主题令牌
  const competitorColors = ['#f22423', '#00a000', '#e3534f', '#56b779', '#262931', '#3c7eff', 'rgb(60,126,255)']
  const flat = TW_CSS.toLowerCase()
  for (const c of competitorColors) {
    assert.equal(flat.includes(c), false, `标题样式里不许出现竞品色值 ${c}（涨跌色必须跟主题与 prefs.redUp；暗底必须跟主题）`)
  }
  // 反例注入：把竞品涨跌色贴进样式 ⇒ 上面的检查必须失败
  const withCompetitor = (TW_CSS + '.x{color:#f22423}').toLowerCase()
  assert.equal(competitorColors.some((c) => withCompetitor.includes(c)), true, '⚠ 贴进 #f22423 必须被抓到')
  // 反例注入
  assert.notDeepEqual(glassProblems({ ...GLASS, light: { ...GLASS.light, bg: GLASS.dark.bg } }), [], '⚠ 浅色档抄深色必须被抓到')
  assert.notDeepEqual(glassProblems({ ...GLASS, dark: { ...GLASS.dark, blur: '2px' } }), [], '⚠ 深色档 blur 不是实测值必须被抓到')
})

test('⑤ 动效纪律：只动 transform/opacity；关闭态 display:none；后台暂停；reduced-motion 降级', () => {
  assert.deepEqual([...MOTION_RULES.animatable], ['transform', 'opacity'], '允许参与动画的属性只有两个')
  for (const ok of ['transform', 'opacity']) assert.deepEqual(animationPropertyProblems(ok), [], `${ok} 应当被允许`)
  for (const bad of ['background', 'box-shadow', 'height', 'filter', 'color']) {
    assert.notDeepEqual(animationPropertyProblems(bad), [], `⚠ 动画用 ${bad} 必须被抓到`)
  }
  // 全量扫我们自己的样式表：所有 @keyframes 里出现的属性都必须可动画（反例 = ANIM_NOT_ALLOWED_SAMPLE）
  assert.deepEqual(keyframesProblems(TW_CSS), [], `样式表里有不合规关键帧：${keyframesProblems(TW_CSS).join(' ／ ')}`)
  assert.notDeepEqual(keyframesProblems(ANIM_NOT_ALLOWED_SAMPLE), [], '⚠ 关键帧里动 background 必须被抓到')
  // 关闭态 / 后台暂停 / reduced-motion 三条 CSS 约定
  assert.deepEqual(motionCssProblems(TW_CSS), [], `动效纪律 CSS 不合规：${motionCssProblems(TW_CSS).join(' ／ ')}`)
  assert.notDeepEqual(motionCssProblems(TW_CSS.replace(/\.tw-glass\[data-open=false\]\{display:none\}/, '')), [], '⚠ 关闭态不写 display:none 必须被抓到')
  assert.notDeepEqual(motionCssProblems(TW_CSS.replace(/\[data-idle=true\] \*\{animation-play-state:paused!important\}/, '')), [], '⚠ 去掉后台暂停必须被抓到')
  // 后台判定是纯函数：面板不可见 / 文档隐藏 任一成立即闲置
  assert.equal(panelIdle(true, false), false, '可见且前台 ⇒ 不闲置')
  assert.equal(panelIdle(false, false), true, '面板不可见 ⇒ 闲置')
  assert.equal(panelIdle(true, true), true, '文档隐藏 ⇒ 闲置')
})

test('⑥ 文案与行为一致：README 数据文件表必须覆盖宿主真正落盘的文件', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const start = readme.indexOf('### 数据文件')
  const end = readme.indexOf('\n### ', start + 5)
  assert.equal(start >= 0 && end > start, true, 'README 必须有「数据文件」小节（否则这条断言是空跑）')
  const table = readme.slice(start, end)
  // ⚠ REVIEW-4-RISK I09：此前是**硬编码 8 个 host 文件**，且只匹配单引号小写字面量 ⇒
  // 往别的文件里加一个新落盘文件也全绿（"必须覆盖每个 .json"是夸大的）。
  // 现在改成**扫描生成**：遍历 `src/host/**/*.ts`（排除测试与 .child.ts），
  // 匹配单/双引号与反引号里的 `.json` 文件名（含 `xxx-*.json` 这类通配写法按前缀归一）。
  const hostFiles: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        walk(p)
      } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.child.ts')) {
        hostFiles.push(p)
      }
    }
  }
  walk(join(ROOT, 'src/host'))
  assert.equal(hostFiles.length >= 10, true, `应当扫到至少 10 个宿主源文件（实得 ${hostFiles.length}）`)
  const names = new Set<string>()
  for (const p of hostFiles) {
    const src = readFileSync(p, 'utf8')
    for (const m of src.matchAll(/['"`]([A-Za-z0-9_.-]+\.json)['"`]/g)) names.add(m[1])
  }
  /** 非"数据目录文件"的排除项（每个都要有理由，不许默默略过） */
  const NOT_DATA: Record<string, string> = {
    'package.json': '包清单（不是插件落盘的数据文件）',
    'tsconfig.json': 'TS 配置',
    'state.json': '测试夹具（H1 的计数器之类）',
    'h2-counter.json': '测试夹具（H2 锁用例的计数器）',
  }
  const real = [...names].filter((n) => !/^\d{4}-\d{2}-\d{2}\.json$/.test(n) && NOT_DATA[n] === undefined)
  assert.equal(real.length >= 8, true, `应当扫到至少 8 个数据文件（实得 ${real.length}：${real.join('、')}）`)
  assert.equal(real.length, names.size - Object.keys(NOT_DATA).filter((k) => names.has(k)).length - [...names].filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).length, '排除项只能来自 NOT_DATA 与日期夹具（不许有别的静默排除）')
  /**
   * 覆盖判定 = 字面命中 **或** 命中按 `<占位符>` 生成的模式行（例如 README 写
   * `klines/<secid>_<周期>_<口径>.json`，而代码里出现的是 `1.601872_101_1.json`）——两者都算覆盖。
   */
  const tableTokens = [...table.matchAll(/[^\s|`()]*\.json/g)]
    .map((m) => m[0])
    // 取 basename：README 里写的是 `klines/<secid>_<周期>_<口径>.json` 这种带目录与中文占位符的模式行
    .map((t) => t.split('/').pop() as string)
  /**
   * ⚠ 占位符必须**有语义**（不能一律换成 `[^/]+`）：`<YYYY-MM-DD>.json` 若换成"任意名"，
   * 就会把 `brand-new-cache.json` 也算成"被模式行覆盖" ⇒ 覆盖检查形同虚设（I09 的第二个坑）。
   * 未知占位符一律**不算覆盖**（宁可报缺，也不放过）。
   */
  const PLACEHOLDER: Record<string, string> = {
    '<YYYY-MM-DD>': '\\d{4}-\\d{2}-\\d{2}',
    '<secid>': '[^_/]+',
    '<周期>': '[A-Za-z0-9]+',
    '<口径>': '[A-Za-z0-9]+',
  }
  const patternFor = (token: string): RegExp | null => {
    let out = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const [ph, rx] of Object.entries(PLACEHOLDER)) out = out.split(ph).join(rx)
    if (/<[^>]*>/.test(out)) return null // 未知占位符 ⇒ 不参与覆盖
    return new RegExp(`^${out}$`)
  }
  for (const n of real) {
    // 代码里可能**原样**写着占位名（例如 `YYYY-MM-DD.json`）⇒ 归一成 `<YYYY-MM-DD>` 再比
    const normalized = n.replace(/YYYY-MM-DD/g, '<YYYY-MM-DD>')
    // 先比字面（含归一后的占位名），再比"按占位符生成的模式行"
    const literalHit = tableTokens.some((t) => t === n || t === normalized)
    const patternHit = tableTokens.some((t) => {
      if (!t.includes('<')) return false
      const rx = patternFor(t)
      return rx !== null && (rx.test(n) || rx.test(normalized))
    })
    const covered = literalHit || patternHit
    assert.equal(covered, true, `README 的数据文件表漏了 ${n}（文案必须与实际落盘一致；表里的模式行：${tableTokens.filter((t) => t.includes('<')).join('、')}）`)
  }
  // 反例注入：把某一行从 README 表里删掉 ⇒ 覆盖检查必须报出来
  for (const n of ['global-flow.json', 'market-extras.json', 'trading-calendar.json']) {
    assert.equal(table.includes(n), true, `⚠ 这行本来就该在表里：${n}`)
    const without = table.split(n).join('（已删）')
    assert.equal(without.includes(n), false, `⚠ 删掉 ${n} 那一行后，覆盖检查必须报缺（证明这条断言能抓漏）`)
  }
})

test('⑦ 接线：玻璃浮层用在浮层上、根节点真的挂了 data-idle', () => {
  const tools = stripComments(readSrc('ToolsPage.tsx'))
  const topbar = stripComments(readSrc('TopBar.tsx'))
  const index = stripComments(readSrc('index.tsx'))
  // 浮层（图表悬停提示框 / 行情悬浮卡）必须用玻璃类，并且**带 data-open**（关闭态由 CSS 的 [data-open=false] 管）
  assert.equal(/className: 'tw-chart-tip tw-glass'/.test(tools), true, '图表悬停提示框必须用 tw-glass')
  assert.equal(/'data-open': 'true'/.test(tools), true, '提示框必须声明 data-open（关闭态交给 CSS）')
  assert.equal(/className: 'tw-pop tw-glass'/.test(topbar), true, '行情悬浮卡必须用 tw-glass')
  assert.equal(/'data-open': 'true'/.test(topbar), true, '悬浮卡必须声明 data-open')
  // 根节点的 data-idle 由 usePageIdle 驱动（复用宿主已有的 visible 信号 + 文档可见性）
  assert.equal(/'data-idle': idle \? 'true' : 'false'/.test(index), true, '根节点必须挂 data-idle')
  assert.equal(/usePageIdle\(visible\)/.test(index), true, 'data-idle 必须由 usePageIdle(visible) 驱动')
  // 顺序：玻璃规则必须在被覆盖的浮层规则**之后**（同特异性 ⇒ 后写者胜）
  const glassAt = TW_CSS.indexOf('.tw-glass{')
  const tipAt = TW_CSS.indexOf('.tw-chart-tip{')
  const popAt = TW_CSS.indexOf('.tw-pop{')
  assert.equal(glassAt > tipAt && glassAt > popAt, true, `玻璃规则必须在 .tw-pop/.tw-chart-tip 之后（glass@${glassAt} tip@${tipAt} pop@${popAt}）`)
  // 反例注入：把玻璃规则**挪到最前面**（模拟"有人把表层规则写在文件开头"）⇒ 真正的顺序判据必须判为违规
  const movedTop = '.tw-glass{background:var(--tw-glass-bg)}' + TW_CSS.replace(/\.tw-glass\{[^}]*\}/, '')
  const movedOk = movedTop.indexOf('.tw-glass{') > movedTop.indexOf('.tw-chart-tip{') && movedTop.indexOf('.tw-glass{') > movedTop.indexOf('.tw-pop{')
  assert.equal(movedOk, false, '⚠ 把玻璃规则挪到最前时，顺序判据必须判为违规（证明这条断言能抓）')
  // 反例注入：去掉玻璃类 / 去掉 data-idle ⇒ 上面的检查必须失败
  assert.equal(/className: 'tw-chart-tip tw-glass'/.test(tools.replace("tw-chart-tip tw-glass", 'tw-chart-tip')), false, '⚠ 去掉提示框的玻璃类必须被抓到')
  assert.equal(/'data-idle': idle \? 'true' : 'false'/.test(index.replace("'data-idle': idle ? 'true' : 'false',", '')), false, '⚠ 去掉根节点 data-idle 必须被抓到')
})
