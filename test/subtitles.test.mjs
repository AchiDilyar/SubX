import assert from 'node:assert/strict'
import test from 'node:test'
import { createProject, createTrack, cueTiming, moveDelta, removeCue, splitTrack, trimDelta, validateProject } from '../src/core/project.mjs'
import { readSrt, writeSrt } from '../src/core/srt.mjs'
import { assTextCues, captureCue, pasteCue, groupAssLayers, importAssLayers, moveCuesToTrack, readAss, renameAssStyleReset, renderAss, writeAss } from '../src/core/ass.mjs'

test('imports multiline UTF-8 SRT, keeps overlaps and reports invalid timestamps', () => {
  const source = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\n你好\r\nHello\r\n\r\n2\r\n00:00:02,750 --> 00:00:04,000\r\n单行\r\n'
  const cues = readSrt(source)
  assert.equal(cues[0].text, '你好\nHello')
  assert.deepEqual(readSrt(writeSrt(cues)), cues)
  assert.throws(() => readSrt('1'), /第 1 条字幕/)
  assert.throws(() => readSrt('1\n00:00:61,000 --> 00:00:01,000\nx'), /第 1 条字幕/)
})

test('imports SRT with consecutive whitespace separators and reports the source line of invalid timing', () => {
  const source = '\uFEFF \r\n1\r\n00:00:01,000 --> 00:00:02,000\r\n第一条  \r\n \r\n\t\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n第二条\r\n'
  assert.deepEqual(readSrt(source), [
    { start: 1000, end: 2000, text: '第一条  ' }, { start: 3000, end: 4000, text: '第二条' },
  ])
  assert.throws(() => readSrt(source + '\r\n7\r\n时间有误\r\n第三条'), /第 3 条字幕.*第 12 行/)
  const terminalSpaces = [{ start: 1000, end: 2000, text: '正文\n  ' }]
  assert.deepEqual(readSrt(writeSrt(terminalSpaces)), terminalSpaces)
  assert.deepEqual(readSrt(' \r\n\t\r\n'), [])
})

test('bilingual split links matching lines and preserves malformed cues', () => {
  const project = createProject()
  const track = createTrack('bilingual', [
    { start: 1000, end: 3000, text: '你好\nHello' },
    { start: 2750, end: 4000, text: '单行' },
    { start: 6000, end: 8000, text: '第一行\n第二行\n第三行' },
  ])
  track.visible = false
  project.tracks.push(track)
  splitTrack(project, track.id, true)
  const [top, bottom] = project.tracks
  assert.equal(top.visible, false)
  assert.equal(bottom.visible, false)
  assert.deepEqual(top.cues.map(cue => cue.text), ['Hello', '单行', '第一行\n第二行\n第三行'])
  assert.deepEqual(bottom.cues.map(cue => cue.text), ['你好'])
  assert.equal(top.cues[1].splitNeedsReview, true)
  assert.equal(top.cues[2].splitNeedsReview, true)
  assert.deepEqual(project.links[0], [top.cues[0].id, bottom.cues[0].id])
  assert.equal(moveDelta([top.cues[0], bottom.cues[0]], -2000), -1000)
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(project))))
  const locked = structuredClone(project)
  locked.tracks[0].locked = true
  assert.doesNotThrow(() => validateProject(locked))
  locked.tracks[0].locked = 'yes'
  assert.throws(() => validateProject(locked), /轨道数据无效/)
  const invalid = { ...project, links: [[top.cues[0].id, top.cues[1].id]] }
  assert.throws(() => validateProject(invalid), /链接无效/)
  const before = structuredClone(project)
  splitTrack(project, top.id, false)
  assert.deepEqual(project, before, 'A track with no eligible cues is left intact')
})

test('successfully splitting a corrected bilingual cue clears its review mark', () => {
  const project = createProject()
  const track = createTrack('corrected', [{ start: 1000, end: 2000, text: '中文\nEnglish', splitNeedsReview: true }])
  project.tracks.push(track)
  splitTrack(project, track.id, false)
  assert.deepEqual(project.tracks.map(item => item.cues[0].text), ['中文', 'English'])
  assert(project.tracks.every(item => !item.cues[0].splitNeedsReview))
})

test('ASS round trip preserves comments, source field order, tags and commas', () => {
  const script = [
    '[Script Info]', 'PlayResX: 1920', 'PlayResY: 1080', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize', 'Style: Default,Arial,50', '',
    '[Events]', 'Format: Layer, Start, End, Name, Style, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Speaker,Default,1,2,3,,{\\pos(100,200)}你好, world\\NHello',
    'Comment: 0,0:00:02.00,0:00:03.00,,Default,0,0,0,,NOTE', '',
  ].join('\r\n')
  const result = readAss(script)
  assert.deepEqual(result.resolution, { width: 1920, height: 1080 })
  assert.equal(result.cues[0].text, '{\\pos(100,200)}你好, world\nHello')
  const track = createTrack('styles.ass', result.cues)
  track.ass = { lines: result.lines, resolution: result.resolution, newline: result.newline }
  const styles = result.styles.map(style => ({ ...style, trackId: track.id }))
  assert.equal(writeAss(track, styles), script)
  track.cues[0].start = 1450
  assert.equal(writeAss(track, styles), script.replace('0:00:01.00', '0:00:01.45'))
})

test('ASS style renames replace only exact named resets in override blocks', () => {
  const unchanged = String.raw`\rNotes {\rNotes-alt}丙{\r}丁{\fn(\rNotes)}戊{\rNotes)}己{\rNotes(unclosed}庚`
  const text = String.raw`{\rNotes \bord4}甲{\r( Notes )\i1}乙` + unchanged
  const renamed = String.raw`{\rReview Notes \bord4}甲{\r( Review Notes )\i1}乙` + unchanged
  assert.equal(renameAssStyleReset(text, 'Notes', 'Review Notes'), renamed)
})

test('ASS to SRT retains dialogue timing and readable text without exporting drawings', () => {
  const cues = [
    { start: 1000, end: 2500, text: String.raw`{note}{\p1}m 0 0 l 5 5{\p0\an8}甲\h\{字面\}\n乙{\q0}\n丙\N\N丁` },
    { start: 2000, end: 2200, text: String.raw`{\p1}m 1 1 l 5 5` },
    { start: 2200, end: 2300, text: String.raw`{comment}\N\h` },
    { start: 3000, end: 4000, text: String.raw`{\pos(10,20)\fn(\p1)\pbo4}保留\n文字` },
    { start: 5000, end: 6000, text: String.raw`{\t(0,100,\p1)}m 0 0 l 5 5` },
  ]
  const track = { ass: { lines: ['[Script Info]', 'WrapStyle: 2', '[Events]'] }, cues }
  assert.deepEqual(readSrt(writeSrt(assTextCues(track))), [
    { start: 1000, end: 2500, text: '甲\u00a0{字面}\n乙 丙\n丁' },
    { start: 3000, end: 4000, text: '保留\n文字' },
  ])
  assert.equal(track.cues.length, 5)
  assert.equal(assTextCues({ ...track, cues: [cues[1]] }).length, 0)
})

test('short cues export as valid ASS and explicit default replaces imported style', () => {
  const source = [
    '[Script Info]', 'PlayResX: 1920', 'PlayResY: 1080',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize',
    'Style: Top,Arial,52', 'Style: Default,Arial,42',
    '[Events]', 'Format: Layer, Start, End, Style, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Top,A\\nB\\NC', '',
  ].join('\n')
  const project = createProject()
  const ass = readAss(source)
  const track = createTrack('styles.ass', ass.cues)
  track.ass = { lines: ass.lines, resolution: ass.resolution, newline: ass.newline }
  project.tracks.push(track)
  project.styles = ass.styles.map(style => ({ ...style, trackId: track.id }))
  const cue = track.cues[0]
  cue.end = 1004
  cue.style = null
  cue.text += '\nD'
  const encoded = writeAss(track, project.styles)
  assert.match(encoded, /0:00:01\.00,0:00:01\.01,Default,A\\nB\\NC\\ND/)
  assert.equal(readAss(encoded).cues[0].end, 1010)
  assert.doesNotThrow(() => validateProject(project))
  assert.throws(() => validateProject({ ...project, styles: null }), /样式列表无效/)
  assert.throws(() => splitTrack(project, track.id), /适用于 SRT/)
})

test('SRT keeps trailing spaces and rejects edits that introduce ambiguous blank lines', () => {
  const cues = readSrt('1\n00:00:00,000 --> 00:00:01,000\nLast  \n')
  assert.equal(cues[0].text, 'Last  ')
  assert.equal(readSrt(writeSrt(cues))[0].text, 'Last  ')
  assert.throws(() => writeSrt([{ ...cues[0], text: 'A\n\nB' }]), /空行/)
})

test('removing one cue clears its link and preserves its former partner', () => {
  const project = createProject()
  const first = createTrack('上轨', [{ start: 1000, end: 3000, text: '上轨' }])
  const second = createTrack('下轨', [{ start: 1200, end: 3500, text: '下轨' }])
  project.tracks.push(first, second)
  project.links.push([first.cues[0].id, second.cues[0].id])
  assert(removeCue(project, first.cues[0].id))
  assert.equal(first.cues.length, 0)
  assert.equal(second.cues.length, 1)
  assert.equal(project.links.length, 0)
  assert.doesNotThrow(() => validateProject(project))
})

test('ASS adds and removes events while preserving original field order and unrelated sections', () => {
  const comment = 'Comment: 0,0:00:00.00,NOTE,0:00:00.50,Default'
  const retain = 'Dialogue: 0,0:00:04.00,Keep,0:00:05.00,Default'
  const source = [
    '[Script Info]', 'PlayResX: 1920', 'PlayResY: 1080', '[V4+ Styles]',
    '[Events]', 'Format: Layer, Start, Text, End, Style',
    'Dialogue: 0,0:00:01.00,Delete,0:00:02.00,Default', comment, '',
    '[Events]', retain, '',
    '[Unknown]', 'Custom: keep unchanged', '',
  ].join('\n')
  const { cues, styles, ...ass } = readAss(source)
  const track = createTrack('edits.ass', cues)
  track.ass = ass
  track.cues.shift()
  track.cues.push({ id: 'new-cue', start: 2200, end: 3800, text: '新建, 字幕\nNew' })
  const exported = writeAss(track, styles)
  assert(!exported.includes('Delete'))
  assert(exported.includes(comment))
  assert(exported.includes(retain))
  assert(exported.includes('Dialogue: 0,0:00:02.20,新建, 字幕\\NNew,0:00:03.80,Default\n\n[Unknown]'))
  const reopened = readAss(exported)
  assert.deepEqual(reopened.cues.map(({ text }) => text), ['Keep', '新建, 字幕\nNew'])
  assert.equal(reopened.styles[0].fields.Name, 'Default')
  assert.equal(reopened.cues[1].style, reopened.styles[0].id)
})

test('edge trims clamp the selected cue and leave its linked partner alone', () => {
  const cue = { id: 'top', start: 1000, end: 3000, text: '上轨' }
  const partner = { id: 'bottom', start: 1200, end: 3400, text: '下轨' }
  const ids = new Set([cue.id])
  const start = { ids, edge: 'start', delta: trimDelta(cue, 'start', -4000) }
  const end = { ids, edge: 'end', delta: trimDelta(cue, 'end', -4000) }
  assert.deepEqual(cueTiming(cue, start), { start: 0, end: 3000 })
  assert.deepEqual(cueTiming(cue, end), { start: 1000, end: 1001 })
  assert.equal(cueTiming(partner, end), partner)
  assert.match(renderAss({ id: 'track', cues: [cue] }, [], { ...end, delta: -500 }), /0:00:01\.00,0:00:02\.50/)
  assert.equal(cue.end, 3000)
})

test('project fades serialize as ASS tags without overriding an existing fade', () => {
  const source = [
    '[Script Info]', '[V4+ Styles]', '[Events]', 'Format: Layer, Start, End, Style, Text',
    String.raw`Dialogue: 0,0:00:00.00,0:00:00.10,Default,{\an8}Short`,
    String.raw`Dialogue: 0,0:00:00.20,0:00:02.00,Default,{\fad(40,80)}Custom`,
    '',
  ].join('\n')
  const { cues, styles, ...ass } = readAss(source)
  const track = { ass, cues }
  assert.equal(writeAss(track, styles), source)
  for (const script of [writeAss(track, styles, true), renderAss(track, styles, undefined, true)]) {
    const output = readAss(script).cues
    assert.equal(output[0].text, String.raw`{\fad(100,100)}{\an8}Short`)
    assert.equal(output[1].text, String.raw`{\fad(40,80)}Custom`)
  }
  // 渐入渐出时长按设置统一写入，入场和出场一致。
  assert.equal(readAss(writeAss(track, styles, 250)).cues[0].text, String.raw`{\fad(250,250)}{\an8}Short`)
})

test('generated ASS includes styles referenced by override resets and preserves mixed SRT text', () => {
  const accent = { id: 'accent', fields: { Name: 'Accent', Fontname: 'Arial', Fontsize: '42' } }
  const track = { cues: [
    { start: 0, end: 1000, assText: true, text: String.raw`{\rAccent\an8}Top\NSecond` },
    { start: 1000, end: 2000, text: String.raw`{literal}\N` },
  ] }
  const script = writeAss(track, [accent])
  assert.match(script, /Style: Accent,Arial,42,&H00FFFFFF,/)
  assert.match(script, /\{\\rAccent\\an8\}Top\\NSecond/)
  assert.deepEqual(assTextCues(track, true).map(cue => cue.text), ['Top\nSecond', String.raw`{literal}\N`])
})

test('pasting an ASS event preserves duration, appearance and tags across conflicting track styles', () => {
  const fixture = (size, text) => readAss([
    '[Script Info]', 'PlayResX: 1920', 'PlayResY: 1080', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize', `Style: Speaker,Arial,${size}`,
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 2,0:00:01.00,0:00:02.40,Speaker,Actor,15,20,25,,${text}`,
  ].join('\n'))
  const project = createProject()
  const add = (name, { cues, styles, ...ass }) => {
    const track = { ...createTrack(name, cues), ass }
    project.tracks.push(track)
    project.styles.push(...styles.map(style => ({ ...style, trackId: track.id })))
    return track
  }
  const originalText = String.raw`{\rSpeaker\i1}字幕\NSubtitle`
  const source = add('source.ass', fixture(42, originalText))
  const target = add('target.ass', fixture(22, 'Existing'))
  const clipboard = captureCue(source, source.cues[0], project.styles)
  const copy = pasteCue(target, clipboard, 3000, project.styles)
  const repeat = pasteCue(target, clipboard, 6000, project.styles)
  target.cues.push(copy, repeat)
  assert.deepEqual([copy.start, copy.end, copy.ass, repeat.style], [3000, 4400, undefined, copy.style])
  assert.equal(project.styles.length, 3)
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(project))))
  const output = writeAss(target, project.styles)
  assert.match(output, /Style: Speaker 副本,Arial,42/)
  assert.match(output, /Dialogue: 2,0:00:03\.00,0:00:04\.40,Speaker 副本,Actor,15,20,25,,\{\\rSpeaker 副本\\i1\}字幕\\NSubtitle/)
  assert.equal(writeAss(source, project.styles), source.ass.lines.join('\n'))
})

test('sparse ASS layers fill bottom-up indexed tracks and export the layer after a move', () => {
  const ass = readAss([
    '[Script Info]', 'PlayResX: 640', 'PlayResY: 360', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize', 'Style: Speaker,Arial,40',
    '[Events]', 'Format: Layer, Start, End, Style, Text',
    'Dialogue: 5,0:00:01.00,0:00:02.40,Speaker,Lower',
    String.raw`Dialogue: 7,0:00:01.30,0:00:02.10,Speaker,{\pos(160,45)}Upper`,
  ].join('\n'))
  const project = createProject()
  project.tracks = [createTrack('S1'), createTrack('S0')]
  const starterIds = project.tracks.map(track => track.id)
  const selected = importAssLayers(project, ass, groupAssLayers(ass.cues), 'sparse.ass')
  assert.equal(selected, project.tracks[0])
  assert.deepEqual(project.tracks.map(track => track.name), ['S7', 'S6', 'S5', 'S4', 'S3', 'S2', 'S1', 'S0'])
  assert.deepEqual(project.tracks.slice(-2).map(track => track.id), starterIds)
  assert.deepEqual(project.tracks.map(track => track.cues.length), [1, 0, 1, 0, 0, 0, 0, 0])
  assert.doesNotMatch(selected.ass.lines.join('\n'), /Dialogue: 5/)
  const original = selected.cues[0]
  const destination = project.tracks[1]
  moveCuesToTrack(project, selected, destination, [original])
  const pasted = destination.cues[0]
  assert.deepEqual([pasted.id, pasted.start, pasted.end, pasted.text], [original.id, 1300, 2100, original.text])
  assert.equal(selected.cues.length, 0)
  const output = writeAss(destination, project.styles, false, 6)
  assert.match(output, /PlayResX: 640/)
  assert.match(output, /Dialogue: 6,0:00:01\.30,0:00:02\.10,Speaker,\{\\pos\(160,45\)\}Upper/)
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(project))))
})

test('same-layer imports merge without overwriting existing cues', () => {
  const load = (label, font) => readAss([
    '[Script Info]', '[V4+ Styles]', 'Format: Name, Fontname, Fontsize', `Style: Default,${font},42`,
    '[Events]', 'Format: Layer, Start, End, Style, Text', `Dialogue: 0,0:00:01.00,0:00:02.00,Default,${label}`,
  ].join('\n'))
  const project = createProject()
  for (const [label, font] of [['Original', 'Arial'], ['Added', 'Helvetica']]) {
    const ass = load(label, font)
    importAssLayers(project, ass, groupAssLayers(ass.cues), label)
  }
  const [track] = project.tracks
  assert.equal(project.tracks.length, 1)
  assert.equal(track.cues.length, 2)
  const exported = writeAss(track, project.styles, false, 0)
  assert.match(exported, /Style: Default 副本,Helvetica,42/)
  assert.match(exported, /Dialogue: 0,0:00:01\.00,0:00:02\.00,Default 副本,Added/)
  assert.doesNotThrow(() => validateProject(project))
})

test('reads SRT timestamps with a single-digit hour', () => {
  assert.deepEqual(readSrt('1\n0:00:01,000 --> 0:00:02,500\n短句\n'), [{ start: 1000, end: 2500, text: '短句' }])
  assert.deepEqual(readSrt('1\n1:02:03.004 --> 1:02:05.000\n长片\n'), [{ start: 3723004, end: 3725000, text: '长片' }])
})

const assScript = (rows, style = 'Style: Default,Arial,42') => [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
  '[V4+ Styles]', 'Format: Name, Fontname, Fontsize', style, '',
  '[Events]', 'Format: Layer, Start, End, Style, Text', ...rows,
].join('\n')

test('reads ASS centiseconds written with a single digit', () => {
  const ass = readAss(assScript(['Dialogue: 0,0:00:01.5,0:00:02.5,Default,短句']))
  assert.deepEqual([ass.cues[0].start, ass.cues[0].end], [1500, 2500])
})

test('skips malformed ASS rows and reports them instead of failing the import', () => {
  const ass = readAss(assScript([
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,保留',
    'Dialogue: 0,0:00:03.00,0:00:03.00,Default,零时长',
    'Dialogue: 0,坏时间,0:00:05.00,Default,时间码',
    'Dialogue: 0,0:00:06.00',
  ]))
  assert.deepEqual(ass.cues.map(cue => cue.text), ['保留'])
  assert.equal(ass.issues.length, 3)
  assert.match(ass.issues[0], /第 13 行的事件时间码无效或时长为零/)
})

test('skips an ASS style row with too few columns and still imports its events', () => {
  const ass = readAss(assScript(['Dialogue: 0,0:00:01.00,0:00:02.00,Default,正文'], 'Style: 坏样式'))
  assert.equal(ass.styles.length, 0)
  assert.equal(ass.cues.length, 1)
  assert.match(ass.issues[0], /第 8 行的样式字段不足/)
})

