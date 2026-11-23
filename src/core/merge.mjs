// 双语合并导出：把当前轨道与链接对端轨道的字幕按“上轨在前、时间取交集”合成双行。
// 未链接的字幕保留为单行；无重叠的链接对按上轨时间输出并计数。

import { assSafeCueText, plainCueText, renderAss } from './ass.mjs'
import { writeSrt } from './srt.mjs'
import { writeVtt } from './vtt.mjs'

export function findMergePartner(project, track) {
  if (!track) return null
  const ids = new Set(track.cues.map(cue => cue.id))
  const counts = new Map()
  for (const pair of project.links ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const otherId = ids.has(pair[0]) ? pair[1] : ids.has(pair[1]) ? pair[0] : null
    if (!otherId || ids.has(otherId)) continue
    const owner = project.tracks.find(item => item.id !== track.id && item.cues.some(cue => cue.id === otherId))
    if (owner) counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1)
  }
  const best = [...counts].sort((left, right) => right[1] - left[1])[0]
  return best ? { partner: project.tracks.find(item => item.id === best[0]), count: best[1] } : null
}

function mergeText(upper, lower) {
  return [upper, lower].map(text => String(text ?? '').trim()).filter(Boolean).join('\n')
}

function sourceText(track, cue, textMode) {
  if (textMode === 'srt') return plainCueText(track, cue)
  if (textMode === 'ass') return assSafeCueText(track, cue)
  return cue.text
}

export function mergeTracks(project, current, partner, { textMode = 'raw' } = {}) {
  if (!current || !partner || current === partner) throw new Error('请选择两条不同的轨道')
  const currentIndex = project.tracks.indexOf(current)
  const partnerIndex = project.tracks.indexOf(partner)
  if (currentIndex < 0 || partnerIndex < 0) throw new Error('要合并的轨道不存在')
  const upper = currentIndex < partnerIndex ? current : partner
  const lower = upper === current ? partner : current
  const upperById = new Map(upper.cues.map(cue => [cue.id, cue]))
  const lowerById = new Map(lower.cues.map(cue => [cue.id, cue]))
  const pairs = []
  const used = new Set()
  for (const pair of project.links ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const upperCue = upperById.get(pair[0]) ?? upperById.get(pair[1])
    const lowerCue = lowerById.get(pair[0]) ?? lowerById.get(pair[1])
    if (!upperCue || !lowerCue) continue
    pairs.push({ upper: upperCue, lower: lowerCue })
    used.add(upperCue.id)
    used.add(lowerCue.id)
  }
  if (!pairs.length) throw new Error('当前轨道没有可合并的链接字幕')
  const cues = []
  let emptyOverlap = 0
  let skipped = 0
  for (const { upper: upperCue, lower: lowerCue } of pairs) {
    const start = Math.max(upperCue.start, lowerCue.start)
    const end = Math.min(upperCue.end, lowerCue.end)
    const overlap = end > start
    if (!overlap) emptyOverlap += 1
    const text = mergeText(sourceText(upper, upperCue, textMode), sourceText(lower, lowerCue, textMode))
    if (!text) {
      skipped += 1
      continue
    }
    cues.push({ ...upperCue, start: overlap ? start : upperCue.start, end: overlap ? end : upperCue.end, text })
  }
  let singles = 0
  for (const track of [upper, lower]) {
    for (const cue of track.cues) {
      if (used.has(cue.id)) continue
      const text = String(sourceText(track, cue, textMode) ?? '').trim()
      if (!text) {
        skipped += 1
        continue
      }
      cues.push({ ...cue, text: sourceText(track, cue, textMode) })
      singles += 1
    }
  }
  cues.sort((left, right) => left.start - right.start || left.end - right.end)
  return {
    upper,
    lower,
    cues,
    pairs: pairs.length,
    singles,
    emptyOverlap,
    skipped,
    preview: cues[0]?.text.replace(/\n/g, ' / ') ?? '',
  }
}

// 生成可直接交给保存对话框的 SRT / ASS 文本。
export function mergedExportText(project, current, partner, format, { fade = false } = {}) {
  const textMode = format === 'ass' ? 'ass' : (format === 'srt' || format === 'vtt') ? 'srt' : null
  if (!textMode) throw new Error('不支持的导出格式')
  const merged = mergeTracks(project, current, partner, { textMode })
  if (!merged.cues.length) throw new Error('合并结果没有可导出的字幕')
  if (format === 'srt') return { ...merged, text: writeSrt(merged.cues) }
  if (format === 'vtt') return { ...merged, text: writeVtt(merged.cues) }
  const defaultStyle = project.styles.find(style => style.isProjectDefault)
  // 分辨率优先取上轨；上轨是纯文本时用下轨 ASS 的 PlayRes，避免下轨覆盖标签坐标错位。
  const assSource = merged.upper.ass ?? merged.lower.ass
  const track = {
    ...merged.upper,
    ass: assSource ? { ...assSource, lines: [] } : undefined,
    cues: merged.cues.map(cue => ({ ...cue, style: cue.style ?? defaultStyle?.id })),
  }
  return { ...merged, text: renderAss(track, project.styles, undefined, fade) }
}
