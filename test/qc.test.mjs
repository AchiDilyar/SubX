import assert from 'node:assert/strict'
import test from 'node:test'
import { createProject, createTrack, validateProject } from '../src/core/project.mjs'
import { analyzeProject, extendShortCues, fixTrailingSpaces, qcSettings, splitLongCues } from '../src/core/qc.mjs'

function qcProject() {
  const project = createProject()
  const track = createTrack('S1', [
    { start: 1000, end: 1500, text: '短' },
    { start: 2000, end: 10000, text: '这一条字幕非常非常长，观众根本读不完，需要拆分处理。' },
    { start: 9000, end: 11000, text: 'Hello  ' },
    { start: 11000, end: 12000, text: '这是一条语速过快的测试字幕需要读得很快' },
    { start: 12000, end: 13000, text: '结尾标点，' },
    { start: 14000, end: 16000, text: '第一行\n\n第二行' },
  ])
  project.tracks.push(track)
  return { project, track }
}

test('reports reading speed, duration, spacing, overlap and punctuation issues', () => {
  const { project } = qcProject()
  const result = analyzeProject(project)
  const types = new Set(result.issues.map(issue => issue.type))
  for (const type of ['short', 'long', 'cps', 'trailing', 'blank', 'overlap', 'punctuation']) {
    assert(types.has(type), 'missing ' + type)
  }
  assert.equal(result.counts.short, 1)
  assert.equal(result.counts.overlap, 1)
  assert(result.issues.every(issue => issue.cueId && issue.trackId && issue.message))
})

test('reports nested overlaps against the furthest previous end', () => {
  const project = createProject()
  project.tracks.push(createTrack('S1', [
    { start: 0, end: 5000, text: '长' },
    { start: 1000, end: 2000, text: '嵌套一' },
    { start: 3000, end: 4000, text: '嵌套二' },
  ]))
  const result = analyzeProject(project)
  assert.equal(result.counts.overlap, 2)
})

test('uses custom thresholds and defaults', () => {
  const { project } = qcProject()
  assert.equal(qcSettings(project).cps, 17)
  const result = analyzeProject(project, { cps: 100, minDuration: 0, maxDuration: 60000 })
  assert.equal(result.counts.cps, undefined)
  assert.equal(result.counts.short, undefined)
  assert.equal(result.counts.long, undefined)
  project.settings = { fade: false, watermark: false, qc: { cps: 5, minDuration: 500, maxDuration: 7000 } }
  assert.equal(qcSettings(project).cps, 5)
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(project))))
  project.settings.qc.maxDuration = 100
  assert.throws(() => validateProject(project), /质量检查设置无效/)
})

test('fixes trailing spaces and short cues without touching linked cues', () => {
  const { project, track } = qcProject()
  const fixed = fixTrailingSpaces(project)
  assert.equal(fixed.fixed, 1)
  assert.equal(track.cues[2].text, 'Hello')
  const result = extendShortCues(project)
  assert.equal(result.fixed, 0)
  assert.equal(result.skipped, 1)
  assert.equal(track.cues[0].end, 1500)
  const roomy = createProject()
  const roomyTrack = createTrack('S1', [
    { start: 1000, end: 1500, text: '短' },
    { start: 3000, end: 4000, text: '下一条' },
  ])
  roomy.tracks.push(roomyTrack)
  const extended = extendShortCues(roomy)
  assert.equal(extended.fixed, 1)
  assert.equal(roomyTrack.cues[0].end, 2000)
  project.links.push([track.cues[0].id, track.cues[1].id])
  track.cues[0].end = 1500
  const linked = extendShortCues(project)
  assert.equal(linked.fixed, 0)
  assert.equal(linked.skipped, 1)
})

test('splits a long plain cue into two cues', () => {
  const { project, track } = qcProject()
  const before = track.cues.length
  const original = track.cues.find(cue => cue.start === 2000)
  const originalText = original.text
  const result = splitLongCues(project)
  assert.equal(result.fixed, 1)
  assert.equal(track.cues.length, before + 1)
  const first = track.cues.find(cue => cue.id === original.id)
  const second = track.cues.find(cue => cue.id !== original.id && cue.start === first.end)
  assert(second, 'expected a second split cue')
  assert.equal(first.text + second.text, originalText)
  assert(first.end <= second.start)
  assert.deepEqual(track.cues.map(cue => cue.start), [...track.cues.map(cue => cue.start)].sort((a, b) => a - b))
})
