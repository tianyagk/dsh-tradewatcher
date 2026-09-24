import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RescueMonitor } from './src/host/rescue.ts'
import { RESCUE_LEVEL_LABEL } from './src/shared/model.ts'
const t = (): string => new Date().toTimeString().slice(0, 5)
const dir = await mkdtemp(join(tmpdir(), 'twclose-'))
const m = new RescueMonitor(dir, { enabled: true, intervalSec: 60, tailIntervalSec: 15, tailFrom: '14:30', universe: [] })
await m.init()
const snap = await m.sampleNow()
console.log(`[${t()}] 收盘后快照`)
console.log(`  阶段=${snap.pulseBand.phase} 标签=${snap.pulseBand.label} isTail=${snap.pulseBand.isTail} trading=${snap.trading}`)
console.log(`  等级 ${snap.level}(${RESCUE_LEVEL_LABEL[snap.level]}) 评分 ${snap.score} 因子 ${snap.completeness?.available}/${snap.completeness?.total}${snap.completeness?.missing.length ? `（缺 ${snap.completeness.missing.join('、')}）` : ''}`)
for (const f of snap.factors) console.log(`    ${f.hit ? '●' : '○'} ${f.label.padEnd(6)} ${f.actual.padEnd(30)} ${String(f.score).padStart(3)}`)
console.log(`  脉冲可算 ${snap.etfs.filter((e) => e.pulseMult !== null).length}/${snap.etfs.length}（盘后应按最后 5 分钟给出数值）`)
console.log(`  撤离标记 ${snap.etfs.filter((e) => e.flowDirection === 'out').length} 只 · 吸纳 ${snap.etfs.filter((e) => e.flowDirection === 'in').length} 只`)
