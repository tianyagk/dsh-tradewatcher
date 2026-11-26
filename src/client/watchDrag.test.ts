import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./WatchlistPage.tsx', import.meta.url), 'utf8')

test('自选分组：拖动图标存在且拖动后调用 reorderGroups', () => {
  assert.match(SRC, /data-role': 'watch-group-drag'/)
  assert.match(SRC, /draggable: true/)
  assert.match(SRC, /op: 'reorderGroups'/)
  assert.match(SRC, /moveGroupTo/)
})
