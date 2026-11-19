/** S3：AGENT DESK 三栏骨架 + 人类列（12 条断言）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PAGE = readFileSync(new URL('./PrismPage.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8')

test('① 三栏栅格 392 / 1fr / 374（左栏加宽：5+1 列在 344 里装不下）', () => {
  assert.match(CSS, /\.tw-ad-board\{[^}]*grid-template-columns:392px minmax\(0,1fr\) 374px/)
})
test('② ≤1100 单列', () => {
  assert.match(CSS, /@media \(max-width:1100px\)\{\.tw-ad-board\{grid-template-columns:minmax\(0,1fr\)\}/)
})
test('③ 六个约束全渲染（设计稿顺序 + 标签，少一条 ⇒ 败）', () => {
  for (const l of ['单票上限', '单笔金额上限', '最大总仓位', '单票止损线', '日回撤熔断', '最低现金留存']) assert.ok(PAGE.includes(l), `缺 ${l}`)
  assert.equal((PAGE.match(/LIMITS\.map/g) ?? []).length, 1)
})
test('④ 约束输入占位 = 设计稿默认值（灰字，不写进草稿）', () => {
  assert.match(PAGE, /placeholder: LIMIT_FALLBACK\[key\]/)
  assert.match(PAGE, /title: isDefault \? '默认值，未保存' : undefined/)
  assert.ok(!PAGE.includes("placeholder: '—'"), '不得再用 — 占位（设计稿是默认值灰字）')
})
test('⑤ 空持仓 —（未取到持仓）', () => { assert.match(PAGE, /missText\('持仓'\)/) })
test('⑥ selftest 指示存在（含 title 与耗时）', () => {
  assert.match(PAGE, /api\.prismSelftest\(\)/)
  assert.match(PAGE, /'data-role': 'ad-status'/)
  assert.match(PAGE, /自检\$\{self\.ok \? '通过' : '失败'\}/)
})
test('⑦ 中右栏真实区块（详情/决策流/总览/绩效）', () => {
  for (const r of ['ad-detail', 'ad-flow', 'ad-overview', 'ad-perf']) assert.ok(PAGE.includes(r), r)
})
test('⑧ 无说明性长句（中文长串 ⇒ 败）', () => {
  const longs = [...PAGE.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]{40,})'/g)].map((m) => m[1]).filter((x) => !x.includes('${'))
  assert.deepEqual(longs, [], `长句：${longs.join(' | ')}`)
})
test('⑨ 字号 ≥12（11px 及以下 ⇒ 败；tab 计数 11px 为唯一例外）', () => {
  const css = CSS.replace(/\.tw-ad-fchip \.cn\{[^}]*\}/g, '')
  const sizes = [...css.matchAll(/\.tw-ad-[^{]+\{[^}]*font-size:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
  assert.deepEqual(sizes.filter((n) => n < 12), [])
})
test('⑩ 口径行 ≤3（banner + hint）', () => {
  assert.ok((PAGE.match(/tw-ad-(hint|banner)/g) ?? []).length <= 3)
})
test('⑪ 新页不引用旧类（tw-prism-* ⇒ 败）', () => { assert.doesNotMatch(PAGE, /tw-prism-/) })
test('⑫ 添加持仓弹层存在且可关闭', () => {
  assert.match(PAGE, /'添加持仓'/)
  assert.match(PAGE, /onClose: \(\) => setAdding\(false\)/)
})

test('⑬ 中栏：九项口径（昨收/今开/最高/最低/持仓 + 成交额/换手率/量比/振幅）+ 未选空态', () => {
  const MID = readFileSync(new URL('./prismDeskMid.ts', import.meta.url), 'utf8')
  for (const k of ['昨收', '今开', '最高', '最低', '持仓', '成交额', '换手率', '量比', '振幅']) assert.ok(MID.includes(k), k)
  assert.match(PAGE, /missText\('个股详情', '选择左侧持仓查看'\)/)
  assert.match(PAGE, /className: `tw-ad-q-price is-\$\{head\.tone\}`/)
})
test('⑭ 决策流五动作 + 空态', () => {
  const FORM = readFileSync(new URL('./prismForm.ts', import.meta.url), 'utf8')
  for (const a of ['buy', 'sell', 'hold', 'reject', 'cancel']) assert.ok(FORM.includes(a), a)
  assert.match(PAGE, /missText\('决策记录'\)/)
})
test('⑮ 动作胶囊五色映射', () => {
  for (const c of ['is-buy', 'is-sell', 'is-reject', 'is-mute']) assert.ok(CSS.includes('.tw-ad-pill.' + c), c)
  assert.match(CSS, /\.tw-ad-pill\.is-buy\{color:var\(--tw-up\)\}/)
  assert.match(CSS, /\.tw-ad-pill\.is-sell\{color:var\(--tw-down\)\}/)
})
test('⑯ 右栏四格 + 绩效四格（第二批：设计稿口径）', () => {
  const SIDE = readFileSync(new URL('./prismDeskSide.ts', import.meta.url), 'utf8')
  for (const k of ['可用资金', '持仓市值', '浮动盈亏', '今日已实现']) assert.ok(SIDE.includes(k), k)
  for (const k of ['决策', '胜率', '回撤', '超额']) assert.ok(SIDE.includes(`label: '${k}'`), k)
  assert.match(PAGE, /acctView\.cells/)
  assert.match(PAGE, /perfCells\.map/)
},)
test('⑰ 绩效无源 ⇒ —（不写 0）；sparkline 少于 2 点写「样本不足」', async () => {
  const { perfCellsOf, sparkOf } = await import('./prismDeskSide.ts')
  for (const c of perfCellsOf({ runsCount: 20, hitRate: null, maxDrawdown: null, excessPct: null })) {
    if (c.key !== 'runs') assert.equal(c.value, '—', `${c.label} 无源必须 —`)
  }
  assert.equal(perfCellsOf({ runsCount: 20, hitRate: null, maxDrawdown: null, excessPct: null })[0].value, '20')
  assert.equal(sparkOf([{ equity: 1 }]).has, false)
  assert.match(PAGE, /'—（样本不足）'/)
})
test('⑱ 深色 1:1 设计稿令牌', () => {
  for (const v of ['#070a0f', '#0f141c', '#1c2532', '#2b3748', '#e8eef7', '#98a7bc', '#5d6a7d', '#ff4d5e', '#00c88a', '#5b8cff', '#f0a93b']) {
    assert.ok(CSS.includes(v), `缺 ${v}`)
  }
  assert.match(CSS, /\.tw-root\[data-theme=dark\] \.tw-ad-root\{/)
})
test('⑲ 选中联动：点击持仓行设置 picked', () => {
  assert.match(PAGE, /onClick: \(\) => setPicked\(p\.secid\)/)
})

test('⑳ B6 四类空态文案', () => {
  assert.match(PAGE, /missText\('持仓'\)/)
  assert.match(PAGE, /missText\('决策记录'\)/)
  assert.match(PAGE, /missText\('个股详情', '选择左侧持仓查看'\)/)
  assert.match(PAGE, /missText\('账户数据'\)/)
})
test('㉑ B6 约束恒定 6 条且可编辑（写接口已接，不得再 disabled）', () => {
  const n = (PAGE.match(/\['(perStockPct|stopLossPct|perOrderYuan|maxPosPct|maxDDPct|minCashPct)'/g) ?? []).length
  assert.equal(n, 6, `约束条数 ${n}`)
  assert.ok(!PAGE.includes("title: '未接写入接口'"), '写接口已就绪，约束输入框不得再置为未接')
  assert.match(PAGE, /action: 'constraints'|prismConstraints/)
})
test('㉒ B6 超限样式与文案', () => {
  assert.match(PAGE, /limitState\?: string[^\n]*desk\?\.limits\?\.limitState === 'exceeded'/)
  assert.match(PAGE, /is-over/)
  assert.match(PAGE, /'已用超出上限'/)
  assert.match(CSS, /\.tw-ad-bar\.is-over i\{background:var\(--tw-danger\)\}/)
})
test('㉓ B6 部分失败隔离：各区块独立判空', () => {
  // 第二批：决策流改由 state.runs 派生（desk.decisionFlow 不再是唯一来源）
  for (const r of ["state?.state.runs", "desk?.overview", "desk?.performance"]) assert.ok(PAGE.includes(r), r)
})
test('㉔ B6 三栏骨架（加载态）', () => {
  assert.ok((PAGE.match(/Skeleton, \{ lines: \d, height: \d+ \}/g) ?? []).length >= 3, '三栏骨架')
})

test('㉕ B5 请求体：add/update/remove（含 confirm）', () => {
  assert.match(PAGE, /api\.prismPosition\(\{ op: 'add', secid: draft\.code, shares: Number\(draft\.shares\)/)
  assert.match(PAGE, /op: 'remove', secid, confirm: true/)
})
test('㉖ B5 约束六字段请求体', () => {
  for (const k of ['perStockPct', 'stopLossPct', 'perOrderYuan', 'maxPosPct', 'maxDDPct', 'minCashPct']) assert.ok(PAGE.includes(`${k}: nums[`), k)
})
test('㉗ B5 保存中禁用 + 文案', () => {
  assert.ok((PAGE.match(/disabled: saving \}/g) ?? []).length >= 3)
  assert.ok(PAGE.includes("'保存中…'"))
})
test('㉘ B5 客户端前置校验文案', () => {
  const FORM = readFileSync(new URL('./prismForm.ts', import.meta.url), 'utf8')
  assert.match(FORM, /'仅支持沪深 A 股与 ETF'/)
  assert.match(FORM, /'股数必须是 100 的整数倍'/)
  assert.match(FORM, /'股数必须是正整数'/)
})
test('㉙ B5 错误原样展示 + 成功后刷新', () => {
  assert.match(PAGE, /setSaveErr\(r\.error \?\? '保存失败'\)/)
  assert.match(PAGE, /if \(r\.ok\) \{ setAdding\(false\); setConfirmDel\(null\); load\(\) \}/)
})
test('㉚ B5 移除需二次确认弹层', () => {
  assert.match(PAGE, /title: '移除持仓'/)
  assert.match(PAGE, /'确认移除该持仓？'/)
})
test('㉛ B5 校验函数：非法代码/股数', async () => {
  const { positionErrorOf } = await import('./prismForm.ts')
  assert.equal(positionErrorOf('00700', 100), '仅支持沪深 A 股与 ETF')
  assert.equal(positionErrorOf('510300', 0), '股数必须是正整数')
  assert.equal(positionErrorOf('510300', 150), '股数必须是 100 的整数倍')
  assert.equal(positionErrorOf('510300', 200), null)
})
