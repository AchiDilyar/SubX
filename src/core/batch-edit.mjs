// 批量编辑辅助：样式引用去重、共享样式影响范围、统一时长/平移的边界。
export function uniqueStyleIds(cues, fallbackStyleId) {
  const ids = new Set()
  for (const cue of cues) {
    const id = cue.style === undefined || cue.style === null ? fallbackStyleId : cue.style
    if (id !== undefined && id !== null) ids.add(id)
  }
  return [...ids]
}

export function styleUsageCount(project, styleIds) {
  const ids = new Set(styleIds)
  if (!ids.size) return 0
  const defaultStyle = (project.styles ?? []).find(style => style.isProjectDefault)?.id
  let count = 0
  for (const track of project.tracks ?? []) {
    for (const cue of track.cues ?? []) {
      const id = cue.style === undefined || cue.style === null ? defaultStyle : cue.style
      if (ids.has(id)) count += 1
    }
  }
  return count
}

export function clampBatchShift(cues, delta) {
  if (!Number.isFinite(delta) || delta === 0 || !cues.length) return 0
  const earliest = Math.min(...cues.map(cue => cue.start))
  return Math.max(delta, -earliest)
}
