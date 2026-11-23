// 字幕文件编码：导入自动识别 UTF-8 / UTF-16 BOM / GB18030；导出支持常用编码与换行。
import iconv from 'iconv-lite'

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function decodeGb18030(bytes) {
  return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
}

export function decodeSubtitleText(bytes) {
  const buffer = Buffer.from(bytes)
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: decodeUtf8(buffer.subarray(3)), encoding: 'utf-8' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const body = buffer.subarray(2)
    if (body.length % 2) throw new Error('UTF-16LE 字幕文件长度不完整')
    return { text: new TextDecoder('utf-16le', { fatal: true }).decode(body), encoding: 'utf-16le' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = buffer.subarray(2)
    if (body.length % 2) throw new Error('UTF-16BE 字幕文件长度不完整')
    return { text: new TextDecoder('utf-16be', { fatal: true }).decode(body), encoding: 'utf-16be' }
  }
  try {
    const text = decodeUtf8(buffer)
    if (!text.includes('\0')) return { text, encoding: 'utf-8' }
  } catch {}
  try {
    const text = decodeGb18030(buffer)
    if (!text.includes('\0')) return { text, encoding: 'gb18030' }
  } catch {}
  throw new Error('无法解码字幕文件，请另存为 UTF-8 后重试')
}

export function encodeSubtitleText(text, encoding = 'utf-8', newline = 'lf') {
  if (!['utf-8', 'utf-8-bom', 'utf-16le', 'gb18030'].includes(encoding)) throw new Error('不支持的导出编码')
  if (!['lf', 'crlf'].includes(newline)) throw new Error('不支持的换行格式')
  const normalized = String(text).replace(/\r\n?/g, '\n').replace(/\n/g, newline === 'crlf' ? '\r\n' : '\n')
  if (encoding === 'utf-8') return Buffer.from(normalized, 'utf8')
  if (encoding === 'utf-8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(normalized, 'utf8')])
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(normalized, 'utf16le')])
  return iconv.encode(normalized, 'gb18030')
}
