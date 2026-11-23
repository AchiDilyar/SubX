// WebVTT：解析 WEBVTT 头、cue 标识/时间码/设置行，导出标准 HH:MM:SS.mmm。
// 导入时简单去掉 <i>/<b>/<c>/<v> 等标签；导出保留正文原文。
import { printTime, readTime } from './srt.mjs'

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|nbsp|quot);/g, (_all, name) => ({
    amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', quot: '"',
  })[name])
}

function stripTags(text) {
  return decodeEntities(text.replace(/<[^>]*>/g, '')).trim()
}

function readTimestamp(value) {
  const text = String(value ?? '').trim().replace(',', '.')
  const short = /^(\d{1,2}):(\d{2})\.(\d{3})$/.exec(text)
  if (short) return readTime('00:' + text)
  return readTime(text)
}

export function inspectVtt(source) {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const cues = []
  const issues = []
  let index = 0
  if (/^\s*WEBVTT\b/.test(lines[0] ?? '')) index = 1
  else issues.push('第 1 行缺少 WEBVTT 头')
  while (index < lines.length) {
    while (index < lines.length && !lines[index].trim()) index += 1
    if (index >= lines.length) break
    if (/^(NOTE|STYLE|REGION)\b/i.test(lines[index].trim())) {
      index += 1
      while (index < lines.length && lines[index].trim()) index += 1
      continue
    }
    let timingIndex = index
    if (!lines[index].includes('-->')) timingIndex += 1
    const timing = lines[timingIndex]
    const match = timing?.match(/^\s*(\S+)\s*-->\s*(\S+)(?:\s+.*)?$/)
    if (!match) {
      issues.push('第 ' + (timingIndex + 1) + ' 行缺少有效时间码，已跳过')
      index = timingIndex + 1
      continue
    }
    const start = readTimestamp(match[1])
    const end = readTimestamp(match[2])
    const body = []
    let cursor = timingIndex + 1
    while (cursor < lines.length && lines[cursor].trim()) {
      body.push(lines[cursor])
      cursor += 1
    }
    const text = stripTags(body.join('\n'))
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
      issues.push('第 ' + (timingIndex + 1) + ' 行时间码无效或结束早于开始，已跳过')
    } else if (!text) {
      issues.push('第 ' + (timingIndex + 1) + ' 条字幕正文为空，已跳过')
    } else {
      cues.push({ start, end, text })
    }
    index = cursor
  }
  return { cues, issues }
}

export function readVtt(source) {
  const { cues, issues } = inspectVtt(source)
  if (issues.length) throw new Error(issues[0])
  return cues
}

export function writeVtt(cues) {
  if (cues.some(cue => /\n[ \t]*\n/.test(cue.text) || /^\n|\n$/.test(cue.text))) {
    throw new Error('WebVTT 的空行用于分隔条目。请删掉字幕正文首尾或中间的空行。')
  }
  return 'WEBVTT\n\n' + [...cues].sort((left, right) => left.start - right.start).map(cue =>
    printTime(cue.start, '.') + ' --> ' + printTime(cue.end, '.') + '\n' + cue.text
  ).join('\n\n') + (cues.length ? '\n' : '')
}
