import assert from 'node:assert/strict'
import test from 'node:test'
import { formatTimecode, parseTimecode } from '../src/core/timecode.mjs'

test('formats and parses milliseconds', () => {
  assert.equal(formatTimecode(3723456, 30, 'milliseconds'), '01:02:03.456')
  assert.equal(parseTimecode('01:02:03.456', 30, 'milliseconds'), 3723456)
})

test('formats non-drop frame timecode at 24 and 30 fps', () => {
  assert.equal(formatTimecode(1000, 24, 'frames'), '00:00:01:00')
  assert.equal(formatTimecode(1042, 24, 'frames'), '00:00:01:01')
  assert.equal(parseTimecode('00:00:01:01', 24, 'frames'), 1000 + 1000 / 24)
  assert.equal(formatTimecode(60000, 30, 'frames'), '00:01:00:00')
})

test('formats and parses 29.97 drop-frame timecode', () => {
  assert.equal(formatTimecode(600000, 29.97, 'drop'), '00:10:00;00')
  const parsed = parseTimecode('00:10:00;00', 29.97, 'drop')
  assert(Math.abs(parsed - 600000) < 2, 'parsed ' + parsed)
  assert.equal(formatTimecode(60000, 29.97, 'drop'), '00:00:59;28')
  assert.equal(formatTimecode(600000, 29.97, 'frames'), '00:09:59:12')
})

test('formats 59.94 drop-frame timecode', () => {
  assert.equal(formatTimecode(600000, 59.94, 'drop'), '00:10:00;00')
  assert.equal(formatTimecode(60000, 59.94, 'drop'), '00:00:59;56')
})

test('rejects malformed timecode', () => {
  assert(Number.isNaN(parseTimecode('bad', 30, 'frames')))
  assert(Number.isNaN(parseTimecode('00:00:00:99', 30, 'frames')))
  assert(Number.isNaN(parseTimecode('', 30, 'frames')))
})
