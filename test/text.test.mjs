import assert from 'node:assert/strict'
import test from 'node:test'
import { findTextMatches, replaceTextAt, replaceTextMatches } from '../src/core/text.mjs'

test('finds literal text case-insensitively by default', () => {
  assert.deepEqual(findTextMatches('Hello hello HELLO', 'hello').map(match => match.index), [0, 6, 12])
  assert.deepEqual(findTextMatches('Hello hello', 'hello', { caseSensitive: true }).map(match => match.index), [6])
  assert.deepEqual(findTextMatches('a.b a.b', 'a.b').map(match => match.index), [0, 4])
  assert.deepEqual(findTextMatches('abc', ''), [])
})

test('finds and replaces with regular expressions and captures', () => {
  assert.deepEqual(findTextMatches('a1 b22', '[0-9]+', { regex: true }).map(match => match.text), ['1', '22'])
  assert.deepEqual(replaceTextMatches('a1 b22', '([0-9]+)', 'num-$1', { regex: true }), { text: 'anum-1 bnum-22', count: 2 })
  assert.deepEqual(replaceTextMatches('Hello', 'hello', 'Hi'), { text: 'Hi', count: 1 })
  assert.throws(() => findTextMatches('x', '[', { regex: true }))
})

test('keeps ASS override blocks untouched by default', () => {
  const text = '{\\i1}Hello {\\b1}world'
  assert.deepEqual(findTextMatches(text, 'Hello', { maskTags: true }).map(match => match.index), [5])
  assert.deepEqual(findTextMatches(text, 'i1', { maskTags: true }), [])
  assert.deepEqual(replaceTextMatches(text, 'o', '0', { maskTags: true }), { text: '{\\i1}Hell0 {\\b1}w0rld', count: 2 })
  assert.deepEqual(replaceTextMatches(text, 'i1', 'x', { maskTags: true }), { text, count: 0 })
  assert.deepEqual(replaceTextMatches(text, 'i1', 'x'), { text: '{\\x}Hello {\\b1}world', count: 1 })
  assert.deepEqual(replaceTextAt(text, 'world', 'W', 16, { maskTags: true }), { text: '{\\i1}Hello {\\b1}W', count: 1 })
})

test('replaces only the requested match for the current-result action', () => {
  const text = 'one two one two'
  assert.deepEqual(replaceTextAt(text, 'one', '1', 8), { text: 'one two 1 two', count: 1 })
  assert.deepEqual(replaceTextAt(text, 'one', '1', 0), { text: '1 two one two', count: 1 })
  assert.deepEqual(replaceTextAt(text, 'missing', '1', 0), { text, count: 0 })
  assert.deepEqual(replaceTextAt('abc123', '([0-9]+)', 'num-$1', 3, { regex: true }), { text: 'abcnum-123', count: 1 })
})

test('replaces trailing whitespace with a regex', () => {
  assert.deepEqual(replaceTextMatches('hello  ', '\\s+$', '', { regex: true }), { text: 'hello', count: 1 })
  assert.deepEqual(findTextMatches('a[b', '[').map(match => match.index), [1])
})

test('does not treat the replacement text as a regular expression', () => {
  assert.deepEqual(replaceTextMatches('a.b', 'a.b', '$&$&'), { text: 'a.ba.b', count: 1 })
})

test('skips zero-length matches and follows native replacement tokens', () => {
  assert.deepEqual(replaceTextMatches('ba', 'a*', 'X', { regex: true }), { text: 'bX', count: 1 })
  assert.deepEqual(replaceTextMatches('{t}ba', 'a*', 'X', { regex: true, maskTags: true }), { text: '{t}bX', count: 1 })
  assert.deepEqual(replaceTextMatches('abc', '(b)', '[$0][$1][$2]', { regex: true }), { text: 'a[$0][b][$2]c', count: 1 })
  assert.deepEqual(replaceTextMatches('ab', '(a)(b)', '$12', { regex: true }), { text: 'a2', count: 1 })
  assert.deepEqual(replaceTextMatches('abc', '(?<mid>b)', '[$<mid>]', { regex: true }), { text: 'a[b]c', count: 1 })
})
