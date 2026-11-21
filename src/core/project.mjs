export function createTrack(name, cues = []) {
  return {
    id: crypto.randomUUID(),
    name,
    visible: true,
    cues: cues.map(cue => ({ ...cue, id: crypto.randomUUID() })),
  }
}

// The array is in display order, with S0 at the bottom.
export function trackIndex(tracks, track) {
  return tracks.length - 1 - tracks.indexOf(track)
}

export function addTopTrack(tracks, cues = []) {
  const track = createTrack('S' + tracks.length, cues)
  tracks.unshift(track)
  return track
}

export function createProject() {
  return { version: 1, media: null, tracks: [], links: [], styles: [], markers: [] }
}

// 纯色空白视频：不依赖真实文件，预览由渲染进程画，合成时用 FFmpeg lavfi 生成画面。
export function createSolidMedia({ color, width, height, fps, duration }) {
  return { kind: 'solid', color, width, height, fps, duration }
}

export function isSolidMedia(media) {
  return Boolean(media) && typeof media === 'object' && media.kind === 'solid' &&
    typeof media.color === 'string' && /^#[0-9a-f]{6}$/i.test(media.color) &&
    Number.isSafeInteger(media.width) && media.width >= 16 && media.width <= 7680 && media.width % 2 === 0 &&
    Number.isSafeInteger(media.height) && media.height >= 16 && media.height <= 7680 && media.height % 2 === 0 &&
    Number.isSafeInteger(media.fps) && media.fps >= 1 && media.fps <= 120 &&
    Number.isSafeInteger(media.duration) && media.duration >= 100 && media.duration <= 86400000
}

export function validScript(script) {
  if (!script || typeof script.bilingual !== 'boolean' || !Array.isArray(script.lines)) return false
  const ids = new Set()
  for (const line of script.lines) {
    if (!line || typeof line.id !== 'string' || ids.has(line.id) || typeof line.text !== 'string') return false
    if (line.second !== null && typeof line.second !== 'string') return false
    if (script.bilingual && typeof line.second !== 'string') return false
    ids.add(line.id)
  }
  if (script.tracks !== undefined) {
    if (!script.tracks || typeof script.tracks !== 'object' || Array.isArray(script.tracks)) return false
    if (script.tracks.first !== undefined && typeof script.tracks.first !== 'string') return false
    if (script.tracks.second !== undefined && typeof script.tracks.second !== 'string') return false
  }
  if (script.order !== undefined && !['first', 'reverse'].includes(script.order)) return false
  return true
}

export function validateProject(project) {
  if (project?.version !== 1 || !Array.isArray(project.tracks) || !Array.isArray(project.links) ||
      (project.media !== null && typeof project.media !== 'string' && !isSolidMedia(project.media))) {
    throw new Error('不支持的 SubX 工程格式')
  }
  if (project.script !== undefined && !validScript(project.script)) {
    throw new Error('工程中的文稿数据无效')
  }
  if (project.settings !== undefined && (!project.settings ||
      typeof project.settings.fade !== 'boolean' || typeof project.settings.watermark !== 'boolean')) {
    throw new Error('工程设置无效')
  }
  if (project.markers !== undefined && (!Array.isArray(project.markers) ||
      !project.markers.every(mark => Number.isSafeInteger(mark) && mark >= 0))) {
    throw new Error('工程中的标记无效')
  }
  const styles = Object.hasOwn(project, 'styles') ? project.styles : []
  if (!Array.isArray(styles)) throw new Error('工程中的样式列表无效')
  const styleIds = new Set()
  const ids = new Set()
  const tracks = new Set()
  const linked = new Set()
  const cueTracks = new Map()
  for (const track of project.tracks) {
    if (!track || typeof track.id !== 'string' || tracks.has(track.id) ||
        typeof track.name !== 'string' || typeof track.visible !== 'boolean' || !Array.isArray(track.cues) ||
        (track.locked !== undefined && typeof track.locked !== 'boolean')) {
      throw new Error('工程中的轨道数据无效')
    }
    tracks.add(track.id)
    if (track.ass && (!Array.isArray(track.ass.lines) ||
        !track.ass.lines.every(line => typeof line === 'string') ||
        !['\n', '\r\n'].includes(track.ass.newline) ||
        !Number.isSafeInteger(track.ass.resolution?.width) || track.ass.resolution.width < 1 ||
        !Number.isSafeInteger(track.ass.resolution?.height) || track.ass.resolution.height < 1)) {
      throw new Error('工程中的 ASS 脚本无效')
    }
    const sourceRows = new Set()
    for (const cue of track.cues) {
      if (!cue || typeof cue.id !== 'string' || ids.has(cue.id) ||
          typeof cue.text !== 'string' || !Number.isSafeInteger(cue.start) ||
          !Number.isSafeInteger(cue.end) || cue.start < 0 || cue.end <= cue.start) {
        throw new Error('工程中的字幕数据无效')
      }
      if (cue.ass && (!track.ass || !validAssRow(cue.ass, track.ass.lines.length) || sourceRows.has(cue.ass.line))) {
        throw new Error('工程中的 ASS 事件无效')
      }
      if (cue.assFields !== undefined && !validFields(cue.assFields)) throw new Error('工程中的 ASS 事件属性无效')
      if (cue.scriptLine !== undefined && typeof cue.scriptLine !== 'string') throw new Error('工程中的文稿关联无效')
      if (cue.ass) sourceRows.add(cue.ass.line)
      ids.add(cue.id)
      cueTracks.set(cue.id, track.id)
    }
  }
  for (const style of styles) {
    const track = project.tracks.find(item => item.id === style?.trackId)
    if (!style || typeof style.id !== 'string' || styleIds.has(style.id) ||
        !validFields(style.fields) ||
        !Object.entries(style.fields).some(([key, value]) => key.toLowerCase() === 'name' && value.trim()) ||
        (style.trackId !== undefined && (!track?.ass || !validAssRow(style, track.ass.lines.length)))) {
      throw new Error('工程中的 ASS 样式无效')
    }
    styleIds.add(style.id)
  }
  for (const track of project.tracks) {
    for (const cue of track.cues) {
      if (cue.style != null && !styles.some(style => style.id === cue.style &&
          (style.trackId === undefined || style.trackId === track.id))) {
        throw new Error('工程中的样式引用无效')
      }
    }
  }
  for (const pair of project.links) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(id => !ids.has(id) || linked.has(id)) ||
        cueTracks.get(pair[0]) === cueTracks.get(pair[1])) {
      throw new Error('工程中的字幕链接无效')
    }
    pair.forEach(id => linked.add(id))
  }
}

function validFields(fields) {
  return fields && typeof fields === 'object' && !Array.isArray(fields) &&
    Object.values(fields).every(value => typeof value === 'string')
}

function validAssRow(row, length) {
  return Number.isSafeInteger(row.line) && row.line >= 0 && row.line < length && typeof row.prefix === 'string' &&
    Array.isArray(row.columns) && row.columns.every(column => typeof column === 'string') &&
    validFields(row.fields) && row.columns.every(column => Object.hasOwn(row.fields, column))
}

export function findCue(project, id) {
  for (const track of project.tracks) {
    const cue = track.cues.find(item => item.id === id)
    if (cue) return cue
  }
  return undefined
}

export function removeCue(project, id) {
  const track = project.tracks.find(item => item.cues.some(cue => cue.id === id))
  if (!track) return false
  track.cues = track.cues.filter(cue => cue.id !== id)
  project.links = project.links.filter(pair => !pair.includes(id))
  return true
}

export function linkedIds(project, id) {
  return project.links.find(pair => pair.includes(id)) ?? [id]
}

export function moveDelta(cues, requested) {
  return Math.max(-cues.reduce((earliest, cue) => Math.min(earliest, cue.start), Infinity), Math.round(requested))
}

export function trimDelta(cue, edge, requested) {
  const delta = Math.round(requested)
  const duration = cue.end - cue.start
  if (edge === 'start') return Math.max(-cue.start, Math.min(duration - 1, delta))
  return Math.max(1 - duration, delta)
}

export function cueTiming(cue, adjustment) {
  if (!adjustment?.ids.has(cue.id)) return cue
  if (adjustment.timings?.has(cue.id)) return adjustment.timings.get(cue.id)
  const { delta, edge } = adjustment
  return {
    start: cue.start + (edge === 'end' ? 0 : delta),
    end: cue.end + (edge === 'start' ? 0 : delta),
  }
}

export function inspectTrackSplit(project, track) {
  const linked = new Set(project.links.flat())
  return track.cues.map(cue => {
    if (linked.has(cue.id)) return { cue, reason: '已有链接' }
    if (cue.ass || cue.assFields) return { cue, reason: 'ASS 事件' }
    const lines = cue.text.split('\n')
    if (lines.length !== 2) return { cue, reason: `${lines.length} 行正文` }
    if (lines.some(line => !line.trim())) return { cue, reason: '有空白行' }
    return { cue, lines }
  })
}

export function splitTrack(project, trackId, reverse) {
  const index = project.tracks.findIndex(track => track.id === trackId)
  if (index < 0) throw new Error('请先选择一条字幕轨')
  const source = project.tracks[index]
  if (source.ass) throw new Error('双语拆分适用于 SRT 轨道')
  const entries = inspectTrackSplit(project, source)
  if (!entries.some(entry => entry.lines)) return
  const top = createTrack(source.name + ' · 上轨')
  const bottom = createTrack(source.name + ' · 下轨')
  top.visible = bottom.visible = source.visible
  for (const { cue, lines } of entries) {
    if (lines) {
      const first = { ...cue, text: lines[reverse ? 1 : 0] }
      delete first.splitNeedsReview
      const other = { ...first, id: crypto.randomUUID(), text: lines[reverse ? 0 : 1] }
      top.cues.push(first)
      bottom.cues.push(other)
      project.links.push([cue.id, other.id])
    } else {
      top.cues.push({ ...cue, splitNeedsReview: true })
    }
  }
  project.tracks.splice(index, 1, bottom)
  project.tracks.unshift(top)
}
