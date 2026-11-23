import assert from 'node:assert/strict'
import test from 'node:test'
import { createProject, createTrack } from '../src/core/project.mjs'
import { findMergePartner, mergedExportText, mergeTracks } from '../src/core/merge.mjs'

function projectWithPair() {
  const project = createProject()
  const upper = createTrack('S1 · 中文', [
    { start: 1000, end: 3000, text: '上轨一' },
    { start: 5000, end: 7000, text: '上轨二' },
    { start: 9000, end: 10000, text: '上轨单边' },
  ])
  const lower = createTrack('S0 · English', [
    { start: 1200, end: 3200, text: 'lower one' },
    { start: 4800, end: 6500, text: 'lower two' },
    { start: 11000, end: 12000, text: 'lower single' },
  ])
  project.tracks.push(upper, lower)
  project.links.push([upper.cues[0].id, lower.cues[0].id], [upper.cues[1].id, lower.cues[1].id])
  return { project, upper, lower }
}

test('merges linked pairs with upper-first text and intersected timing', () => {
  const { project, upper, lower } = projectWithPair()
  const result = mergeTracks(project, lower, upper)
  assert.equal(result.upper, upper)
  assert.equal(result.lower, lower)
  assert.equal(result.pairs, 2)
  assert.equal(result.singles, 2)
  assert.deepEqual(result.cues.map(cue => [cue.start, cue.end, cue.text]), [
    [1200, 3000, '上轨一\nlower one'],
    [5000, 6500, '上轨二\nlower two'],
    [9000, 10000, '上轨单边'],
    [11000, 12000, 'lower single'],
  ])
  assert.equal(result.emptyOverlap, 0)
  assert.equal(result.preview, '上轨一 / lower one')
})

test('keeps the upper timing when a linked pair has no overlap', () => {
  const { project, upper, lower } = projectWithPair()
  project.links = [[upper.cues[2].id, lower.cues[2].id]]
  const result = mergeTracks(project, upper, lower)
  assert.equal(result.pairs, 1)
  assert.equal(result.emptyOverlap, 1)
  const merged = result.cues.find(cue => cue.text.includes('lower single'))
  assert.equal(merged.start, 9000)
  assert.equal(merged.end, 10000)
  assert.equal(merged.text, '上轨单边\nlower single')
})

test('exports merged SRT and ASS text', () => {
  const { project, upper, lower } = projectWithPair()
  const srt = mergedExportText(project, lower, upper, 'srt')
  assert.match(srt.text, /上轨一\r?\nlower one/)
  assert.match(srt.text, /上轨二\r?\nlower two/)
  assert.equal(srt.pairs, 2)
  const ass = mergedExportText(project, upper, lower, 'ass', { fade: 100 })
  assert.match(ass.text, /\[Events\]/)
  assert.match(ass.text, /Dialogue: .*上轨一\\Nlower one/)
  assert.match(ass.text, /PlayResX: 1920/)
})

test('preserves literal SRT braces and escapes them only for ASS', () => {
  const project = createProject()
  const upper = createTrack('S1', [{ start: 1000, end: 3000, text: '{音乐} 你好' }])
  const lower = createTrack('S0', [{ start: 1000, end: 3000, text: 'Hello' }])
  project.tracks.push(upper, lower)
  project.links.push([upper.cues[0].id, lower.cues[0].id])
  const srt = mergedExportText(project, upper, lower, 'srt')
  assert.match(srt.text, /\{音乐\} 你好/)
  const ass = mergedExportText(project, upper, lower, 'ass')
  assert.ok(ass.text.includes('\\{音乐\\} 你好\\NHello'))
})

test('strips ASS tags when exporting a merged SRT', () => {
  const project = createProject()
  const upper = createTrack('S1', [{ start: 1000, end: 3000, text: '{\\i1}Hello', assText: true }])
  upper.ass = { lines: [], newline: '\n', resolution: { width: 1920, height: 1080 } }
  const lower = createTrack('S0', [{ start: 1000, end: 3000, text: '你好' }])
  project.tracks.push(upper, lower)
  project.links.push([upper.cues[0].id, lower.cues[0].id])
  const srt = mergedExportText(project, upper, lower, 'srt')
  assert.match(srt.text, /Hello\r?\n你好/)
  assert.doesNotMatch(srt.text, /\\i1/)
})

test('uses the project default style for merged ASS from plain tracks', () => {
  const project = createProject()
  project.styles = [{ id: 'default-style', fields: { Name: 'Default', Fontname: 'MyFont', Fontsize: '60' }, isProjectDefault: true }]
  const upper = createTrack('S1', [{ start: 1000, end: 3000, text: '你好' }])
  const lower = createTrack('S0', [{ start: 1000, end: 3000, text: 'Hello' }])
  project.tracks.push(upper, lower)
  project.links.push([upper.cues[0].id, lower.cues[0].id])
  const ass = mergedExportText(project, upper, lower, 'ass')
  assert.match(ass.text, /Style: Default/)
  assert.match(ass.text, /MyFont/)
})

test('handles mixed plain and ASS source tracks', () => {
  const project = createProject()
  const upper = createTrack('S1', [{ start: 1000, end: 3000, text: '{音乐}' }])
  const lower = createTrack('S0', [{ start: 1000, end: 3000, text: '{\\i1}Hello', assText: true }])
  lower.ass = { lines: [], newline: '\n', resolution: { width: 1280, height: 720 } }
  project.tracks.push(upper, lower)
  project.links.push([upper.cues[0].id, lower.cues[0].id])
  const srt = mergedExportText(project, upper, lower, 'srt')
  assert.match(srt.text, /\{音乐\}/)
  assert.match(srt.text, /Hello/)
  assert.doesNotMatch(srt.text, /\\i1/)
  const ass = mergedExportText(project, upper, lower, 'ass')
  assert.ok(ass.text.includes('\\{音乐\\}'))
  assert.ok(ass.text.includes('{\\i1}Hello'))
  assert.match(ass.text, /PlayResX: 1280/)
})

test('rejects a merge with no non-empty text', () => {
  const project = createProject()
  const upper = createTrack('S1', [{ start: 1000, end: 3000, text: '  ' }])
  const lower = createTrack('S0', [{ start: 1000, end: 3000, text: '' }])
  project.tracks.push(upper, lower)
  project.links.push([upper.cues[0].id, lower.cues[0].id])
  assert.throws(() => mergedExportText(project, upper, lower, 'srt'), /没有可导出/)
})

test('finds the most-linked partner and rejects tracks without links', () => {
  const { project, upper, lower } = projectWithPair()
  assert.equal(findMergePartner(project, upper).partner, lower)
  assert.equal(findMergePartner(project, upper).count, 2)
  const lonely = createTrack('S2 · 无链接', [{ start: 0, end: 1000, text: 'x' }])
  project.tracks.push(lonely)
  assert.equal(findMergePartner(project, lonely), null)
  assert.throws(() => mergeTracks(project, lonely, upper), /没有可合并/)
})
