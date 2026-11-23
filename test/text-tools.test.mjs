import assert from 'node:assert/strict'
import test from 'node:test'
import { transformCueTexts, transformText } from '../src/core/text-tools.mjs'

test('changes case without touching ASS override blocks', () => {
  assert.equal(transformText('Hello World', 'upper'), 'HELLO WORLD')
  assert.equal(transformText('Hello World', 'lower'), 'hello world')
  assert.equal(transformText('{\\i1}hello world', 'upper', { maskTags: true }), '{\\i1}HELLO WORLD')
  assert.equal(transformText('{literal} hello', 'upper'), '{LITERAL} HELLO')
})

test('capitalizes words and sentence starts', () => {
  assert.equal(transformText('hello world', 'title'), 'Hello World')
  assert.equal(transformText("don't stop", 'title'), "Don't Stop")
  assert.equal(transformText('hello. next line', 'sentence'), 'Hello. Next line')
  assert.equal(transformText('第一行\nsecond line', 'sentence'), '第一行\nSecond line')
})

test('trims and collapses spaces per line', () => {
  assert.equal(transformText('  hello  \n  world  ', 'trimEnd'), '  hello\n  world')
  assert.equal(transformText('  hello  \n  world  ', 'trim'), 'hello\nworld')
  assert.equal(transformText('hello   world', 'collapse'), 'hello world')
})

test('only returns cues whose text changed', () => {
  const first = { id: 'a', text: 'hello' }
  const second = { id: 'b', text: 'HELLO' }
  const track = { ass: false }
  const changes = transformCueTexts([{ track, cue: first }, { track, cue: second }], 'upper')
  assert.deepEqual(changes, [{ cue: first, text: 'HELLO' }])
  assert.throws(() => transformText('x', 'missing'), /未知的文本工具/)
})
