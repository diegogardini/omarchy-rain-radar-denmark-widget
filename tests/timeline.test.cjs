const { test } = require('node:test')
const assert = require('node:assert/strict')
const Timeline = require('../Timeline.js')

test('the nowcast runs far enough to reach 90 min past the clock', () => {
  const step = Timeline.stepMinutes('2026-09-20T10:00:00Z', '2026-09-20T10:10:00Z')
  assert.equal(step, 10)
  assert.equal(Timeline.nowcastSteps(step, 13, 90, 150), 11)   // a scan just published
  assert.equal(Timeline.nowcastSteps(step, 35, 90, 150), 13)   // the oldest normal scan
  assert.equal(Timeline.nowcastSteps(step, 0, 90, 150), 9)
})

test('the nowcast never runs past its longest lead, however old the scan', () => {
  assert.equal(Timeline.nowcastSteps(10, 80, 90, 150), 15)
  assert.equal(Timeline.nowcastSteps(10, 500, 90, 150), 15)
  assert.equal(Timeline.nowcastSteps(10, -3, 90, 150), 9)      // a clock slightly behind the scan
})

test('the step count follows the real cadence', () => {
  assert.equal(Timeline.nowcastSteps(5, 20, 90, 150), 22)
  for (const s of [1, 2.5, 5, 10, 15]) {
    const n = Timeline.nowcastSteps(s, 20, 90, 150)
    assert.ok(n * s >= 110 && n * s < 110 + s, `${s}: ${n}`)
  }
})

test('stepMinutes falls back to the nominal cadence on bad or reversed input', () => {
  assert.equal(Timeline.stepMinutes('', '2026-09-20T10:05:00Z'), 10)
  assert.equal(Timeline.stepMinutes('junk', 'junk'), 10)
  assert.equal(Timeline.stepMinutes('2026-09-20T10:05:00Z', '2026-09-20T10:00:00Z'), 10)
  assert.equal(Timeline.stepMinutes('2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z'), 10)
})

test('stepMinutes clamps an implausible gap (a missed hour of scans)', () => {
  assert.equal(Timeline.stepMinutes('2026-09-20T09:00:00Z', '2026-09-20T10:00:00Z'), 15)
})

test('nowcastTimes counts from the last observed scan, in the DMI timestamp format', () => {
  const times = Timeline.nowcastTimes('2026-09-20T10:05:00Z', 5, 3)
  assert.deepEqual(times, ['2026-09-20T10:10:00Z', '2026-09-20T10:15:00Z', '2026-09-20T10:20:00Z'])
})

test('the last of 24 five-minute steps lands exactly 2 h after the last scan, across midnight', () => {
  const times = Timeline.nowcastTimes('2026-09-20T23:00:00Z', 5, 24)
  assert.equal(times.length, 24)
  assert.equal(times[23], '2026-09-21T01:00:00Z')
})

test('nowcastTimes yields blanks rather than throwing without a valid last timestamp', () => {
  assert.deepEqual(Timeline.nowcastTimes('', 5, 2), ['', ''])
})

test('trailingRegularRun takes up to `count` evenly spaced scans ending at the newest', () => {
  const at = (m) => ({ id: 'a' + m, datetime: new Date(Date.UTC(2026, 8, 24, 12, m)).toISOString() })
  const items = [0, 5, 10, 15, 20, 25].map(at)
  const run = Timeline.trailingRegularRun(items, 4, () => true)
  assert.deepEqual(run.map((i) => i.id), ['a10', 'a15', 'a20', 'a25'])
})

test('trailingRegularRun stops at a gap or a scan that is not loaded', () => {
  const at = (m) => ({ id: 'a' + m, datetime: new Date(Date.UTC(2026, 8, 24, 12, m)).toISOString() })
  const gap = [0, 5, 20, 25].map(at) // 5 -> 20 is a 15 min hole
  assert.deepEqual(Timeline.trailingRegularRun(gap, 4, () => true).map((i) => i.id), ['a20', 'a25'])
  const items = [0, 5, 10, 15].map(at)
  assert.deepEqual(Timeline.trailingRegularRun(items, 4, (it) => it.id !== 'a5').map((i) => i.id), ['a10', 'a15'])
})

test('trailingRegularRun is empty without a newest frame and a single item without a pair', () => {
  const at = (m) => ({ id: 'a' + m, datetime: new Date(Date.UTC(2026, 8, 24, 12, m)).toISOString() })
  assert.deepEqual(Timeline.trailingRegularRun([], 4, () => true), [])
  assert.deepEqual(Timeline.trailingRegularRun([at(0), at(5)], 4, (it) => it.id !== 'a5'), [])
  assert.equal(Timeline.trailingRegularRun([at(0)], 4, () => true).length, 1)
})

test('the shown time is the nearest 10 minutes; the exact time is untouched', () => {
  const t = Date.parse('2026-07-30T18:40:00Z')
  assert.equal(Timeline.shownMs(t), t)
  assert.equal(Timeline.shownMs(t + 4 * 60000), t)               // 18:44 -> 18:40
  assert.equal(Timeline.shownMs(t + 5 * 60000), t + 10 * 60000)  // 18:45 -> 18:50
  assert.equal(Timeline.shownMs(t + 9 * 60000 + 59000), t + 10 * 60000)
  assert.equal(Timeline.shownMs(-1), -0)
})
