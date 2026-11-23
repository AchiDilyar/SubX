// 批量文本工具：大小写、首字母/句首、空格清理；ASS 覆盖块默认不参与。
import { mapTextSegments } from './text.mjs'

const transforms = {
  upper: text => text.toUpperCase(),
  lower: text => text.toLowerCase(),
  title: text => text.replace(/\p{L}[\p{L}'’]*/gu, word => word[0].toUpperCase() + word.slice(1)),
  sentence: text => text.replace(/(^|[.!?]\s+|\n\s*)(\p{Ll})/gu, (_all, prefix, letter) => prefix + letter.toUpperCase()),
  trimEnd: text => text.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n'),
  trim: text => text.split('\n').map(line => line.trim()).join('\n').trim(),
  collapse: text => text.replace(/[ \t]{2,}/g, ' '),
}

export const TEXT_TOOL_LABELS = {
  upper: '全部大写',
  lower: '全部小写',
  title: '首字母大写',
  sentence: '句首大写',
  trimEnd: '去除行尾空格',
  trim: '去除首尾空格',
  collapse: '合并多余空格',
}

export function transformText(text, kind, { maskTags = false } = {}) {
  const transform = transforms[kind]
  if (!transform) throw new Error('未知的文本工具')
  return maskTags ? mapTextSegments(text, transform) : transform(text)
}

// entries: [{ track, cue }]，返回实际变化的 cue 与目标文本。
export function transformCueTexts(entries, kind) {
  const changes = []
  for (const { track, cue } of entries) {
    const next = transformText(cue.text, kind, { maskTags: Boolean(track.ass || cue.assText) })
    if (next !== cue.text) changes.push({ cue, text: next })
  }
  return changes
}
