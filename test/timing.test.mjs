import assert from 'node:assert/strict'
import test from 'node:test'
import { clampShiftDelta, createProject, createTrack, shiftTiming } from '../src/core/project.mjs'

test('shifts a cue while preserving its duration', () => {
  const cue = { start: 1000, end: 3000 }
  assert.deepEqual(shiftTiming(cue, 500), { start: 1500, end: 3500, clamped: false })
  assert.deepEqual(shiftTiming(cue, -2000), { start: 0, end: 2000, clamped: true })
  assert.deepEqual(shiftTiming({ start: 0, end: 1000 }, -500), { start: 0, end: 1000, clamped: true })
  assert.deepEqual(shiftTiming(cue, NaN), { start: 1000, end: 3000, clamped: false })
})

test('clamps the whole shift at the earliest start so relative timing stays intact', () => {
  const cues = [{ start: 1000, end: 3000 }, { start: 3000, end: 5000 }]
  assert.equal(clampShiftDelta(cues, -2000), -1000)
  assert.equal(clampShiftDelta(cues, -500), -500)
  assert.equal(clampShiftDelta(cues, 500), 500)
  assert.equal(clampShiftDelta(cues, NaN), 0)
  assert.equal(clampShiftDelta([], -500), 0)
})

test('keeps linked cues linked and their timing differences after a clamped shift', () => {
  const project = createProject()
  const top = createTrack('top', [{ start: 500, end: 2500, text: 'A' }])
  const bottom = createTrack('bottom', [{ start: 1200, end: 3400, text: 'B' }])
  project.tracks.push(top, bottom)
  project.links.push([top.cues[0].id, bottom.cues[0].id])
  const requested = -1000
  const applied = clampShiftDelta([...top.cues, ...bottom.cues], requested)
  assert.equal(applied, -500)
  for (const track of project.tracks) {
    for (const cue of track.cues) Object.assign(cue, shiftTiming(cue, applied))
  }
  assert.deepEqual(project.links, [[top.cues[0].id, bottom.cues[0].id]])
  assert.deepEqual([top.cues[0].start, top.cues[0].end, bottom.cues[0].start, bottom.cues[0].end], [0, 2000, 700, 2900])
  assert.equal(top.cues[0].end - top.cues[0].start, 2000)
  assert.equal(bottom.cues[0].end - bottom.cues[0].start, 2200)
  assert.equal(bottom.cues[0].start - top.cues[0].start, 700)
})
