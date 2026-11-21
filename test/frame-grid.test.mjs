import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignCue, frameBoundaries, nearestBoundary } from '../src/core/frame-grid.mjs'
import { cueTiming } from '../src/core/project.mjs'

test('aligns both subtitle edges to real variable frame boundaries and keeps at least one frame', () => {
  const grid = frameBoundaries([0, 41.7, 100.2, 175], 250)
  assert.deepEqual(grid, [0, 42, 100, 175, 250])
  assert.deepEqual(alignCue(grid, 48, 152), { start: 42, end: 175 })
  assert.deepEqual(alignCue(grid, 110, 111), { start: 100, end: 175 })
  assert.deepEqual(alignCue(grid, 999, 1000), { start: 175, end: 250 })
  assert.equal(nearestBoundary(grid, 90, 43, 174), 100)
  assert.equal(nearestBoundary(grid, 90, 101, 174), undefined)
})

test('keeps millisecond editing when no frame index exists and uses aligned drag timing', () => {
  assert.deepEqual(alignCue([], 103.2, 208.8), { start: 103, end: 209 })
  const cue = { id: 'a', start: 103, end: 209 }
  const adjustment = { ids: new Set(['a']), timings: new Map([['a', { start: 100, end: 250 }]]) }
  assert.deepEqual(cueTiming(cue, adjustment), { start: 100, end: 250 })
})
