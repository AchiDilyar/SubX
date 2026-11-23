import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSubtitleText, encodeSubtitleText } from '../src/core/encoding.mjs'

test('detects UTF-8 and UTF-16 BOM subtitle files', () => {
  assert.deepEqual(decodeSubtitleText(Buffer.from('你好')), { text: '你好', encoding: 'utf-8' })
  assert.deepEqual(decodeSubtitleText(Buffer.from('\ufeff你好', 'utf8')), { text: '你好', encoding: 'utf-8' })
  assert.deepEqual(decodeSubtitleText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好', 'utf16le')])), { text: '你好', encoding: 'utf-16le' })
  assert.throws(() => decodeSubtitleText(Buffer.from([0xff, 0xfe, 0x31])), /UTF-16LE/)
})

test('falls back to GB18030 for Chinese legacy files', () => {
  const bytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a])
  assert.deepEqual(decodeSubtitleText(bytes), { text: '你好\n', encoding: 'gb18030' })
  assert.throws(() => decodeSubtitleText(Buffer.from([0xff, 0xff, 0xff])), /无法解码/)
})

test('encodes UTF-8 BOM, UTF-16LE and GB18030 with CRLF', () => {
  const bom = encodeSubtitleText('你好\n世界', 'utf-8-bom', 'crlf')
  assert.deepEqual([...bom.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.equal(bom.subarray(3).toString('utf8'), '你好\r\n世界')
  const utf16 = encodeSubtitleText('你好', 'utf-16le')
  assert.deepEqual([...utf16.subarray(0, 2)], [0xff, 0xfe])
  const gbk = encodeSubtitleText('你好', 'gb18030')
  assert.deepEqual([...gbk], [0xc4, 0xe3, 0xba, 0xc3])
  assert.throws(() => encodeSubtitleText('x', 'utf-32'), /不支持的导出编码/)
  assert.throws(() => encodeSubtitleText('x', 'utf-8', 'cr'), /不支持的换行格式/)
})
