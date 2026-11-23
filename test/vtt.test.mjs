import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectVtt, readVtt, writeVtt } from '../src/core/vtt.mjs'

const sample = 'WEBVTT\n\nNOTE comment\n\n1\n00:00:01.000 --> 00:00:02.500 align:start\nHello <i>world</i>\n\n00:03.000 --> 00:00:04.000\n第二行 &amp; 更多\n'

test('parses headers, identifiers, settings and short timestamps', () => {
  const { cues, issues } = inspectVtt(sample)
  assert.deepEqual(issues, [])
  assert.deepEqual(cues, [
    { start: 1000, end: 2500, text: 'Hello world' },
    { start: 3000, end: 4000, text: '第二行 & 更多' },
  ])
})

test('reports a missing header and invalid cues', () => {
  const { cues, issues } = inspectVtt('00:00:01.000 --> 00:00:00.500\nbad\n\n00:00:02.000 --> 00:00:03.000\n\n')
  assert.equal(cues.length, 0)
  assert(issues.some(issue => issue.includes('WEBVTT')))
  assert(issues.some(issue => issue.includes('结束早于开始')))
  assert(issues.some(issue => issue.includes('正文为空')))
})

test('writes standard WebVTT and round-trips text and timing', () => {
  const text = writeVtt([
    { start: 1000, end: 2500, text: 'Hello' },
    { start: 3000, end: 4000, text: '第二行' },
  ])
  assert.match(text, /^WEBVTT\n\n00:00:01\.000 --> 00:00:02\.500\nHello/)
  assert.deepEqual(readVtt(text), [
    { start: 1000, end: 2500, text: 'Hello' },
    { start: 3000, end: 4000, text: '第二行' },
  ])
  assert.throws(() => writeVtt([{ start: 0, end: 1000, text: 'a\n\nb' }]), /空行/)
})
