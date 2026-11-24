import assert from 'node:assert/strict'
import test from 'node:test'
import { clampBatchShift, styleUsageCount, uniqueStyleIds } from '../src/core/batch-edit.mjs'
import { createProject, createTrack } from '../src/core/project.mjs'

test('deduplicates style references and counts shared usage', () => {
  const project = createProject()
  project.styles = [
    { id: 'default', isProjectDefault: true, fields: { Name: '默认样式' } },
    { id: 'title', fields: { Name: '标题' } },
  ]
  const track = createTrack('S1', [
    { start: 0, end: 1000, text: 'a', style: 'title' },
    { start: 1000, end: 2000, text: 'b' },
    { start: 2000, end: 3000, text: 'c', style: 'title' },
  ])
  project.tracks.push(track)
  const ids = uniqueStyleIds(track.cues, 'default')
  assert.deepEqual(ids.sort(), ['default', 'title'])
  assert.equal(styleUsageCount(project, ['title']), 2)
  assert.equal(styleUsageCount(project, ['default']), 1)
  assert.equal(styleUsageCount(project, []), 0)
})

test('clamps a negative batch shift at the earliest start', () => {
  assert.equal(clampBatchShift([{ start: 500 }, { start: 2000 }], -800), -500)
  assert.equal(clampBatchShift([{ start: 500 }], 200), 200)
  assert.equal(clampBatchShift([], 200), 0)
})
