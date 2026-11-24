import assert from 'node:assert/strict'
import test from 'node:test'
import { nearestRetimeFps, retimeCue, retimeCues } from '../src/core/retime.mjs'

test('scales cue timing by the target/source frame ratio', () => {
  const cue = { id: 'a', start: 1000, end: 3000, text: 'x' }
  assert.deepEqual(retimeCue(cue, 24, 25), { id: 'a', start: 1042, end: 3125, text: 'x' })
  assert.deepEqual(retimeCue(cue, 25, 24), { id: 'a', start: 960, end: 2880, text: 'x' })
})

test('keeps at least one millisecond and clamps negative starts', () => {
  const cue = { start: 0, end: 1 }
  assert.deepEqual(retimeCue(cue, 120, 23.976), { start: 0, end: 1 })
  assert.throws(() => retimeCue(cue, 0, 25), /帧率/)
})

test('retimes a list and finds the nearest common fps', () => {
  const cues = [{ start: 1000, end: 2000 }, { start: 2000, end: 3000 }]
  assert.deepEqual(retimeCues(cues, 24, 25).map(cue => [cue.start, cue.end]), [[1042, 2083], [2083, 3125]])
  assert.equal(nearestRetimeFps(24.1), 24)
  assert.equal(nearestRetimeFps(59.9), 59.94)
  assert.equal(nearestRetimeFps(0), 25)
})
