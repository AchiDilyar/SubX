// 字幕质量检查：语速、时长、空行/空正文、行尾空格、同轨重叠与行尾标点。
import { plainCueText } from './ass.mjs'

export const QC_DEFAULTS = { cps: 17, minDuration: 1000, maxDuration: 7000 }

export function qcSettings(project) {
  return { ...QC_DEFAULTS, ...(project.settings?.qc ?? {}) }
}

function visibleText(track, cue) {
  return plainCueText(track, cue)
}

function trackOrder(project) {
  const order = new Map()
  for (const [index, track] of project.tracks.entries()) order.set(track.id, index)
  return order
}

export function analyzeProject(project, settings = qcSettings(project)) {
  const issues = []
  const order = trackOrder(project)
  const push = (type, track, cue, message, extra = {}) => {
    issues.push({
      id: type + ':' + cue.id,
      type,
      trackId: track.id,
      cueId: cue.id,
      start: cue.start,
      end: cue.end,
      message,
      ...extra,
    })
  }
  for (const track of project.tracks) {
    const ordered = [...track.cues].sort((left, right) => left.start - right.start)
    let maxEnd = -Infinity
    let maxEndCue
    for (const cue of ordered) {
      const text = visibleText(track, cue)
      const trimmed = text.trim()
      const duration = cue.end - cue.start
      const chars = text.replace(/\s+/g, '').length
      const cps = duration > 0 ? chars / (duration / 1000) : 0
      if (!trimmed) push('empty', track, cue, '正文为空')
      if (duration < settings.minDuration) push('short', track, cue, '时长 ' + (duration / 1000).toFixed(2) + ' 秒，低于 ' + (settings.minDuration / 1000).toFixed(1) + ' 秒')
      if (duration > settings.maxDuration) push('long', track, cue, '时长 ' + (duration / 1000).toFixed(2) + ' 秒，高于 ' + (settings.maxDuration / 1000).toFixed(1) + ' 秒')
      if (trimmed && cps > settings.cps) push('cps', track, cue, '语速 ' + cps.toFixed(1) + ' 字/秒，高于 ' + settings.cps)
      if (/[ \t]+$/m.test(text)) push('trailing', track, cue, '行尾有空格')
      if (/\n[ \t]*\n/.test(text)) push('blank', track, cue, '正文中有空行')
      if (/[,，;；:：、]\s*$/.test(trimmed)) push('punctuation', track, cue, '行尾标点未收束')
      if (cue.start < maxEnd) {
        push('overlap', track, cue, '与前面的字幕重叠 ' + ((maxEnd - cue.start) / 1000).toFixed(2) + ' 秒', {
          previousCueId: maxEndCue?.id,
        })
      }
      if (cue.end > maxEnd) {
        maxEnd = cue.end
        maxEndCue = cue
      }
    }
  }
  issues.sort((left, right) =>
    (order.get(left.trackId) ?? 0) - (order.get(right.trackId) ?? 0) ||
    left.start - right.start ||
    left.type.localeCompare(right.type))
  const counts = {}
  for (const issue of issues) counts[issue.type] = (counts[issue.type] ?? 0) + 1
  return { issues, counts, settings }
}

function linkedIds(project) {
  return new Set((project.links ?? []).flat())
}

function boundIds(project) {
  return new Set((project.bindings ?? []).flat())
}

export function fixTrailingSpaces(project) {
  let fixed = 0
  let skipped = 0
  for (const track of project.tracks) {
    if (track.locked) {
      skipped += track.cues.filter(cue => /[ \t]+$/m.test(cue.text)).length
      continue
    }
    for (const cue of track.cues) {
      const next = cue.text.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n')
      if (next !== cue.text) {
        cue.text = next
        fixed += 1
      }
    }
  }
  return { fixed, skipped }
}

export function extendShortCues(project, settings = qcSettings(project)) {
  const linked = linkedIds(project)
  const bound = boundIds(project)
  let fixed = 0
  let skipped = 0
  for (const track of project.tracks) {
    if (track.locked) {
      skipped += track.cues.filter(cue => cue.end - cue.start < settings.minDuration).length
      continue
    }
    const ordered = [...track.cues].sort((left, right) => left.start - right.start)
    for (const [index, cue] of ordered.entries()) {
      const duration = cue.end - cue.start
      if (duration >= settings.minDuration) continue
      if (linked.has(cue.id) || bound.has(cue.id)) {
        skipped += 1
        continue
      }
      const next = ordered[index + 1]
      const limit = next ? Math.min(cue.start + settings.minDuration, next.start - 1) : cue.start + settings.minDuration
      // 间隙不足时不要制造“看起来修好、实际仍过短”的结果。
      if (limit <= cue.end || limit - cue.start < settings.minDuration) {
        skipped += 1
        continue
      }
      cue.end = limit
      fixed += 1
    }
  }
  return { fixed, skipped }
}

function splitText(text) {
  const trimmed = text.trim()
  if (trimmed.length < 4) return null
  const middle = Math.floor(trimmed.length / 2)
  let index = trimmed.lastIndexOf(' ', middle)
  if (index < 1) index = trimmed.indexOf(' ', middle)
  if (index < 1) index = middle
  const first = trimmed.slice(0, index).trim()
  const second = trimmed.slice(index).trim()
  return first && second ? [first, second] : null
}

export function splitLongCues(project, settings = qcSettings(project)) {
  const linked = linkedIds(project)
  const bound = boundIds(project)
  let fixed = 0
  let skipped = 0
  for (const track of project.tracks) {
    if (track.ass) continue
    if (track.locked) {
      skipped += track.cues.filter(cue => cue.end - cue.start > settings.maxDuration).length
      continue
    }
    const ordered = [...track.cues].sort((left, right) => left.start - right.start)
    for (const cue of ordered) {
      if (cue.end - cue.start <= settings.maxDuration) continue
      if (linked.has(cue.id) || bound.has(cue.id) || cue.scriptLine || cue.ass || cue.assText) {
        skipped += 1
        continue
      }
      const parts = splitText(cue.text)
      if (!parts) {
        skipped += 1
        continue
      }
      const middle = Math.round((cue.start + cue.end) / 2)
      if (middle <= cue.start || middle >= cue.end) {
        skipped += 1
        continue
      }
      const second = {
        ...cue,
        id: crypto.randomUUID(),
        start: middle,
        end: cue.end,
        text: parts[1],
      }
      cue.end = middle
      cue.text = parts[0]
      track.cues.push(second)
      fixed += 1
    }
    track.cues.sort((left, right) => left.start - right.start)
  }
  return { fixed, skipped }
}
