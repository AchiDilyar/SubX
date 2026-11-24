import assert from 'node:assert/strict'
import test from 'node:test'
import { createProject, createTrack } from '../src/core/project.mjs'
import { firstPendingCue, reviewStats } from '../src/core/review.mjs'

function project() {
  const item = createProject()
  item.tracks.push(createTrack('S1', [
    { start: 0, end: 1000, text: 'a', reviewed: true },
    { start: 1000, end: 2000, text: 'b' },
  ]), createTrack('S0', [{ start: 0, end: 1000, text: 'c', reviewed: false }]))
  return item
}

test('counts reviewed cues and percentage', () => {
  assert.deepEqual(reviewStats(project()), { total: 3, reviewed: 1, pending: 2, percent: 33 })
  assert.deepEqual(reviewStats({ tracks: [] }), { total: 0, reviewed: 0, pending: 0, percent: 0 })
})

test('finds the first pending cue in track order', () => {
  const found = firstPendingCue(project())
  assert.equal(found.cue.text, 'b')
  assert.equal(firstPendingCue({ tracks: [] }), null)
})
