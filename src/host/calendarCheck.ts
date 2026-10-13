/**
 * `npm run calendar:check` 的入口：只读校验外部交易日历文件（改完立刻自查，不必等运行期）。
 *
 * 用法：`npm run calendar:check`（默认读 `~/.dsh/dsh-tradewatcher/trading-calendar.json`；
 * 可用 `DSH_HOME=/tmp/xxx npm run calendar:check` 在隔离目录里试写）。
 *
 * 预览用的是**真正生效**的判定链（`rescue.tradingDayState` = 外部文件 → 内置表 → 周末）。
 */
import { calendarCheckReport, printCalendarCheck } from './tradingCalendar.ts'
import { tradingDayState } from './rescue.ts'

printCalendarCheck(await calendarCheckReport(Date.now(), tradingDayState))
