import { printTime } from './srt.mjs'
import { cueTiming, addTopTrack, trackIndex } from './project.mjs'

const styleFields = [
  'Name', 'Fontname', 'Fontsize', 'PrimaryColour', 'SecondaryColour', 'OutlineColour', 'BackColour',
  'Bold', 'Italic', 'Underline', 'StrikeOut', 'ScaleX', 'ScaleY', 'Spacing', 'Angle', 'BorderStyle',
  'Outline', 'Shadow', 'Alignment', 'MarginL', 'MarginR', 'MarginV', 'Encoding',
]
const eventFields = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text']
const defaults = ['Default', 'Noto Sans SC', '36', '&H00FFFFFF', '&H000000FF', '&H00000000', '&H00000000',
  '0', '0', '0', '0', '100', '100', '0', '0', '1', '2', '0', '2', '20', '20', '24', '1']
const overrideTags = /(\\[ \t]*)([^\\(]*)(\([^)]*(?:\)|$))?/g

export function newStyle(name = 'Default', source = {}) {
  return { id: crypto.randomUUID(), fields: { ...completeStyle(source), Name: name } }
}

function completeStyle(fields) {
  return Object.fromEntries(styleFields.map((key, index) => [key, field(fields, key) ?? defaults[index]]))
}

function getKey(fields, name) {
  return Object.keys(fields).find(key => key.toLowerCase() === name.toLowerCase()) ?? name
}

export function field(fields, name) {
  return fields[getKey(fields, name)]
}

export function setField(fields, name, value) {
  fields[getKey(fields, name)] = value
}

function readFormat(line) {
  return line.match(/^\s*Format:\s*(.*)$/i)?.[1].split(',').map(name => name.trim())
}

function parseRow(text, format) {
  const columns = text.split(',')
  if (columns.length < format.length) return null
  const index = format.findIndex(name => name.toLowerCase() === 'text')
  if (columns.length > format.length) {
    if (index === -1) return null
    columns.splice(index, columns.length - format.length + 1, columns.slice(index, columns.length - format.length + index + 1).join(','))
  }
  return Object.fromEntries(format.map((key, position) => [key, columns[position]]))
}

function readAssTime(value) {
  // 少数工具只写 1 位百分秒（0:00:01.5），按 VSFilter / libass 的口径当成 5 厘秒。
  const time = value?.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/)
  if (!time) return NaN
  const [, h, m, s, fraction] = time
  // 百分秒字段按十进制小数理解：.5 就是 0.5 秒，和两位写法 .50 保持一致。
  const milliseconds = ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 +
    Math.round(Number(fraction) * (fraction.length === 1 ? 100 : 10))
  return m < 60 && s < 60 && Number.isSafeInteger(milliseconds) ? milliseconds : NaN
}

function assTime(time) {
  return printTime(time, '.').replace(/^0(\d:)/, '$1').slice(0, -1)
}

export function readAss(source) {
  const text = source.replace(/^\uFEFF/, '')
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const styles = []
  const cues = []
  const issues = []
  const formats = new Map()
  const resolution = { width: 384, height: 288 }
  let section = ''
  for (const [index, line] of lines.entries()) {
    const header = line.trim().match(/^\[([^\]]+)\]$/)
    if (header) section = header[1].toLowerCase()
    const format = readFormat(line)
    if (format) formats.set(section, format)
    const dimension = line.match(/^\s*PlayRes([XY]):\s*(\d+)/i)
    if (section === 'script info' && dimension && Number(dimension[2]) > 0) {
      resolution[dimension[1].toUpperCase() === 'X' ? 'width' : 'height'] = Number(dimension[2])
    }
    const row = line.match(/^(\s*(Dialogue|Style):\s*)(.*)$/i)
    const kind = row?.[2].toLowerCase()
    if (kind === 'style' && section === 'v4+ styles') {
      const columns = formats.get(section) ?? styleFields
      const fields = parseRow(row[3], columns)
      if (!fields || !field(fields, 'Name')?.trim()) {
        issues.push('第 ' + (index + 1) + ' 行的样式字段不足，已跳过')
        continue
      }
      styles.push({ id: crypto.randomUUID(), fields, line: index, prefix: row[1], columns })
    }
    if (kind === 'dialogue' && section === 'events') {
      const columns = formats.get(section) ?? eventFields
      const fields = parseRow(row[3], columns)
      const start = readAssTime(fields && field(fields, 'Start'))
      const end = readAssTime(fields && field(fields, 'End'))
      const raw = fields && field(fields, 'Text')
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || raw === undefined) {
        // 单条事件坏掉不应该让整份 ASS 导入失败：跳过并交给导入确认窗口说明。
        issues.push('第 ' + (index + 1) + ' 行的事件时间码无效或时长为零，已跳过')
        continue
      }
      cues.push({
        start, end, text: raw.replace(/\\N/g, '\n'),
        ass: { line: index, prefix: row[1], columns, fields },
      })
    }
  }
  if (!/^[ \t]*\[Events\][ \t]*\r?$/mi.test(text)) throw new Error('ASS 文件缺少 Events 段')
  for (const cue of cues) {
    cue.style = styles.find(style => field(style.fields, 'Name').trim() === field(cue.ass.fields, 'Style')?.trim())?.id
  }
  return { lines, newline, resolution, styles, cues, issues }
}

function rowText(fields, columns) {
  return columns.map(key => field(fields, key) ?? '').join(',')
}

function addAssEvents(lines, cues, styles, layer) {
  if (!cues.length) return
  const events = lines.findLastIndex(line => /^\s*\[Events\]\s*$/i.test(line))
  const nextSection = lines.findIndex((line, index) => index > events && /^\s*\[[^\]]+\]\s*$/.test(line))
  let end = nextSection < 0 ? lines.length : nextSection
  while (end > events + 1 && !lines[end - 1].trim()) end--
  let columns = eventFields
  let inEvents = false
  for (let index = 0; index < end; index++) {
    const line = lines[index]
    const section = line.trim().match(/^\[([^\]]+)\]$/)
    if (section) inEvents = section[1].toLowerCase() === 'events'
    if (inEvents) columns = readFormat(line) ?? columns
  }
  const rows = cues.map(cue => {
    const style = styles.find(item => item.id === cue.style)
    const [start, finish] = quantize(cue.start, cue.end)
    return 'Dialogue: ' + rowText({
      ...eventAppearance(cue, layer), Start: assTime(start), End: assTime(finish),
      Style: style ? field(style.fields, 'Name').trim() : 'Default',
      Text: cue.text.replace(/\n/g, '\\N'),
    }, columns)
  })
  lines.splice(end, 0, ...rows)
}

function withoutRemovedEvents(lines, cues, indices) {
  const retained = new Set(cues.map(cue => cue.ass?.line))
  let inEvents = false
  return lines.filter((line, index) => {
    const section = line.trim().match(/^\[([^\]]+)\]$/)
    if (section) inEvents = section[1].toLowerCase() === 'events'
    const keep = !inEvents || !/^\s*Dialogue:/i.test(line) || retained.has(index)
    if (keep && indices) indices.set(index, indices.size)
    return keep
  })
}

export function writeAss(track, styles, fade = false, layer) {
  const source = track.ass
  if (!source) return renderAss({ ...track, cues: plainAssCues(track.cues, styles), layer }, styles, undefined, fade)
  let lines = [...source.lines]
  const scoped = styles.filter(style => style.trackId === track.id)
  for (const style of scoped) {
    lines[style.line] = style.prefix + rowText(style.fields, style.columns)
  }
  for (const cue of track.cues) {
    if (!cue.ass) continue
    const { line, prefix, columns, fields: original } = cue.ass
    const fields = { ...original }
    const originalLayer = field(original, 'Layer')
    if (layer !== undefined && originalLayer !== undefined && Number(originalLayer) !== layer) {
      setField(fields, 'Layer', String(layer))
    }
    const [start, end] = quantize(cue.start, cue.end)
    if (start !== readAssTime(field(original, 'Start'))) setField(fields, 'Start', assTime(start))
    if (end !== readAssTime(field(original, 'End'))) setField(fields, 'End', assTime(end))
    const text = dialogueText(cue, start, end, fade)
    if (text !== dialogueText({ text: field(original, 'Text').replace(/\\N/g, '\n') }, start, end)) setField(fields, 'Text', text)
    const style = styles.find(item => item.id === cue.style)
    const name = style ? field(style.fields, 'Name').trim() : cue.style === null ? 'Default' : undefined
    if (name && name !== field(original, 'Style')?.trim()) setField(fields, 'Style', name)
    if (Object.keys(fields).some(key => fields[key] !== original[key])) lines[line] = prefix + rowText(fields, columns)
  }

  lines = withoutRemovedEvents(lines, track.cues)

  const scriptNames = new Set()
  for (const line of lines) {
    const match = /^\s*Style:\s*([^,]*)/i.exec(line)
    if (match) scriptNames.add(match[1].trim().toLowerCase())
  }
  const shared = applicableStyles(track, styles).filter(style => style.trackId === undefined &&
    !scriptNames.has(field(style.fields, 'Name').trim().toLowerCase()))
  const needsDefault = track.cues.some(cue => cue.style === null || (!cue.ass && !cue.style))
  if (needsDefault && !scriptNames.has('default') &&
      ![...scoped, ...shared].some(style => field(style.fields, 'Name').trim().toLowerCase() === 'default')) {
    shared.unshift(newStyle())
  }
  if (shared.length) {
    const index = lines.findIndex(line => /^\s*\[V4\+ Styles\]\s*$/i.test(line))
    const start = index + 1
    const bodyEnd = lines.findIndex((line, i) => i >= start && /^\s*\[.*\]\s*$/.test(line))
    const insert = bodyEnd < 0 ? lines.length : bodyEnd
    const format = index < 0 ? undefined : lines.slice(start, insert).findLast(line => readFormat(line))
    const columns = format ? readFormat(format) : styleFields
    const added = shared.map(style => 'Style: ' + rowText({ ...completeStyle(style.fields), ...style.fields }, columns))
    if (index < 0) {
      const events = lines.findIndex(line => /^\s*\[Events\]/i.test(line))
      lines.splice(events, 0, '[V4+ Styles]', 'Format: ' + columns.join(', '), ...added, '')
    } else {
      if (!format) added.unshift('Format: ' + columns.join(', '))
      lines.splice(insert, 0, ...added, '')
    }
  }

  addAssEvents(lines, track.cues.filter(cue => !cue.ass).map(cue => {
    const [start, end] = quantize(cue.start, cue.end)
    return { ...cue, text: dialogueText(cue, start, end, fade) }
  }), styles, layer)
  if (layer !== undefined) {
    let inEvents = false
    let missingLayer = false
    lines = lines.map(line => {
      const section = line.trim().match(/^\[([^\]]+)\]$/)
      if (section) {
        inEvents = section[1].toLowerCase() === 'events'
        missingLayer = false
      }
      if (!inEvents) return line
      const columns = readFormat(line)
      if (columns) {
        missingLayer = !columns.some(column => column.toLowerCase() === 'layer')
        return missingLayer ? 'Format: Layer, ' + columns.join(', ') : line
      }
      return missingLayer ? line.replace(/^(\s*(Dialogue|Comment):\s*)/i,
        (_, prefix, type) => prefix + (type.toLowerCase() === 'dialogue' ? layer : 0) + ',') : line
    })
  }
  return lines.join(source.newline)
}

function quantize(start, end) {
  const opening = Math.round(start / 10) * 10
  return [opening, Math.max(opening + 10, Math.round(end / 10) * 10)]
}

function applicableStyles(track, styles) {
  const scoped = styles.filter(style => style.trackId !== undefined && style.trackId === track.id)
  const scopedNames = new Set(scoped.map(style => field(style.fields, 'Name').trim().toLowerCase()))
  const ids = new Set(track.cues.map(cue => cue.style))
  const resetText = track.cues.filter(cue => (track.ass || cue.assText) && cue.text.includes('\\r'))
  const shared = styles.filter(style => {
    if (style.trackId !== undefined) return false
    if (ids.has(style.id)) return true
    const name = field(style.fields, 'Name').trim()
    return !scopedNames.has(name.toLowerCase()) && resetText.some(cue => renameAssStyleReset(cue.text, name, '') !== cue.text)
  })
  return [...shared, ...scoped]
}

function eventStyleName(cue) {
  return (cue.style === null ? 'Default' : field(cue.ass?.fields ?? {}, 'Style')?.trim()) ?? 'Default'
}

export function fallbackAssStyle(track, cue, styles) {
  const applicable = applicableStyles(track, styles)
  const name = eventStyleName(cue)
  const named = target => applicable.findLast(style => field(style.fields, 'Name').trim().toLowerCase() === target.toLowerCase())
  return named(name) ?? named('Default')
}

export function assStyleResetCues(project, style) {
  const name = field(style.fields, 'Name').trim()
  return project.tracks.flatMap(track => {
    if (!track.ass) return style.trackId === undefined ? track.cues.filter(cue => cue.assText) : []
    const scoped = project.styles.findLast(item =>
      item.trackId === track.id && field(item.fields, 'Name').trim().toLowerCase() === name.toLowerCase())
    return (scoped ? scoped.id === style.id : style.trackId === undefined) ? track.cues : []
  })
}

export function renameAssStyleReset(text, previous, name) {
  return text.replace(/\{([^{}]*)\}/g, (_block, tags) => {
    const updated = tags.replace(overrideTags, (tag, prefix, head, args) => {
      if (!head.startsWith('r')) return tag
      if (args) {
        if (head.trimEnd() !== 'r' || !args.endsWith(')')) return tag
        const [, leading, value, trailing] = args.slice(1, -1).match(/^([ \t]*)(.*?)([ \t]*)$/s)
        return value.toLowerCase() === previous.toLowerCase() ? (name ? `${prefix}${head}(${leading}${name}${trailing})` : prefix + 'r') : tag
      }
      const value = head.slice(1).replace(/[ \t]+$/, '')
      return value.toLowerCase() === previous.toLowerCase() ? `${prefix}r${name}${head.slice(1 + value.length)}` : tag
    })
    return '{' + updated + '}'
  })
}

function scriptInfo(source) {
  if (!source) return []
  const end = source.lines.findIndex(line => /^\s*\[(?!Script Info\])[\w +]+\]/i.test(line))
  return end < 0 ? source.lines : source.lines.slice(0, end)
}

function* dialogueTags(tags, insideTransform = false) {
  for (const [, , head, args] of tags.matchAll(overrideTags)) {
    // libass applies p and q inside a transform without interpolating their values.
    if (!insideTransform && head.trimEnd() === 't' && args) {
      const transform = /^\([ \t]*(?:[^,\\)]*,[ \t]*){0,3}(\\[\s\S]*)\)$/.exec(args)
      if (transform) yield* dialogueTags(transform[1], true)
    } else {
      yield [head, args]
    }
  }
}

function plainDialogue(text, scriptWrap) {
  let wrap = scriptWrap
  let drawing = false
  let output = ''
  for (const [token, escape, tags] of text.matchAll(/\\([{}Nnh])|\{([^}]*)\}|[^{\\]+|[\\{]/g)) {
    if (tags !== undefined) {
      for (const [head, args] of dialogueTags(tags)) {
        const match = /^([pq])(?:[ \t]*([+-]?\d+))?[ \t]*$/.exec(head)
        if (!match) continue
        const [, tag, bare] = match
        const argument = args?.endsWith(')') ? args.slice(1, -1).trim() : bare
        const value = /^[-+]?\d+$/.test(argument ?? '') ? Number(argument) : undefined
        if (tag === 'p') drawing = (value ?? 0) > 0
        else wrap = value >= 0 && value <= 3 ? value : scriptWrap
      }
    } else if (!drawing) {
      if (escape === 'h') output += '\u00a0'
      else if (escape === 'n') output += wrap === 2 ? '\n' : ' '
      else if (escape === 'N') output += '\n'
      else output += escape ?? token
    }
  }
  return output.split('\n').filter(line => line.trim()).join('\n')
}

const wrapCache = new WeakMap()
function scriptWrap(track) {
  const source = track?.ass
  if (!source) return 0
  const cached = wrapCache.get(source)
  if (cached !== undefined) return cached
  const wrap = scriptInfo(source).reduce((value, line) => {
    const match = /^\s*WrapStyle:\s*([0-3])\s*$/i.exec(line)
    return match ? Number(match[1]) : value
  }, 0)
  wrapCache.set(source, wrap)
  return wrap
}

export function plainCueText(track, cue) {
  return track.ass || cue.assText ? plainDialogue(cue.text, scriptWrap(track)) : cue.text
}

export function assSafeCueText(track, cue) {
  if (track.ass || cue.assText) return cue.text
  // SRT escape sequences and literal braces have no override semantics in ASS.
  return cue.text.replace(/\\(?=[Nnh{}])/g, '\\\u200b').replace(/[{}]/g, '\\$&')
}

export function assTextCues(track, mixed = false) {
  const wrap = scriptWrap(track)
  return track.cues.map(cue => ({ ...cue, text: !mixed || cue.assText ? plainDialogue(cue.text, wrap) : cue.text })).filter(cue => cue.text.trim())
}

function dialogueText(cue, start, end, fade = false) {
  const text = cue.text.replace(/\n/g, '\\N')
  if (!fade || [...text.matchAll(/(?<!\\)\{([^{}]*)\}/g)].some(([, tags]) =>
    [...dialogueTags(tags)].some(([name, args]) => args && /^(?:fad|fade)\s*$/.test(name)))) return text
  // fade 可以是 true（旧行为）或具体毫秒数；入场和出场用同一时长。
  const duration = Math.max(0, Math.round(typeof fade === 'number' ? fade : 100))
  if (!duration) return text
  return `{\\fad(${duration},${duration})}` + text
}

export function plainAssCues(cues, styles) {
  const defaultStyle = styles.find(style => style.isProjectDefault)
  return cues.map(cue => ({
    ...cue,
    style: cue.style ?? defaultStyle?.id,
    // SRT escape sequences and literal braces have no override semantics.
    text: cue.assText ? cue.text : cue.text.replace(/\\(?=[Nnh{}])/g, '\\\u200b').replace(/[{}]/g, '\\$&'),
  }))
}

function eventAppearance(cue, layer) {
  const original = cue.ass?.fields ?? cue.assFields ?? {}
  return {
    Layer: layer === undefined ? field(original, 'Layer') ?? '0' : String(layer),
    Name: field(original, 'Name') ?? '',
    MarginL: field(original, 'MarginL') ?? '0',
    MarginR: field(original, 'MarginR') ?? '0',
    MarginV: field(original, 'MarginV') ?? '0',
    Effect: field(original, 'Effect') ?? '',
  }
}

export function captureCue(track, cue, styles) {
  const assText = Boolean(track.ass || cue.assText)
  const base = styles.find(style => style.id === cue.style) ??
    (track.ass ? fallbackAssStyle(track, cue, styles) ?? newStyle() : styles.find(style => style.isProjectDefault) ?? newStyle())
  const resets = assText ? applicableStyles(track, styles).filter(style => {
    const name = field(style.fields, 'Name').trim()
    return renameAssStyleReset(cue.text, name, '') !== cue.text
  }).reverse() : []
  return structuredClone({
    text: cue.text, duration: cue.end - cue.start, assText, base, resets,
    assFields: assText ? eventAppearance(cue) : undefined,
  })
}

export function pasteCue(destination, clipboard, start, styles) {
  const nameOf = style => field(style.fields, 'Name').trim()
  const used = new Set(styles.map(style => nameOf(style).toLowerCase()))
  const names = new Map()
  function transfer(source) {
    if (names.has(source.id)) return names.get(source.id)
    const name = nameOf(source)
    const fields = completeStyle(source.fields)
    const equalAppearance = style => Object.entries(completeStyle(style.fields))
      .every(([key, value]) => key === 'Name' || fields[key] === value)
    // 一个工程等于一个 ASS 文件：样式名全工程唯一，同名样式直接复用（必要时改成全局样式）。
    const matchingName = candidate => {
      const lower = candidate.toLowerCase()
      return styles.find(style => nameOf(style).toLowerCase() === lower)
    }
    let result = matchingName(name)
    if (!result || !equalAppearance(result)) {
      let unique = name
      if (result || name.toLowerCase() === 'default') {
        for (let copy = 1; ; copy++) {
          unique = name + ' 副本' + (copy > 1 ? ' ' + copy : '')
          const previousCopy = matchingName(unique)
          if (previousCopy && equalAppearance(previousCopy)) {
            result = previousCopy
            break
          }
          if (!used.has(unique.toLowerCase())) {
            result = undefined
            break
          }
        }
      }
      if (!result) {
        result = newStyle(unique, source.fields)
        used.add(unique.toLowerCase())
        styles.push(result)
      }
    }
    if (result.trackId !== undefined) {
      result.trackId = undefined
      delete result.line
      delete result.prefix
      delete result.columns
    }
    names.set(source.id, result)
    return result
  }

  const base = transfer(clipboard.base)
  let text = clipboard.text
  const seen = new Set()
  for (const style of clipboard.resets) {
    const name = nameOf(style)
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const replacement = nameOf(transfer(style))
    if (replacement !== name) text = renameAssStyleReset(text, name, replacement)
  }
  if (destination.ass && !clipboard.assText) text = plainAssCues([{ text }], [])[0].text
  return {
    id: crypto.randomUUID(), start, end: start + clipboard.duration, text, style: base.id,
    assText: Boolean(destination.ass || clipboard.assText), assFields: clipboard.assFields,
  }
}

export function groupAssLayers(cues) {
  const groups = new Map()
  for (const cue of cues) {
    const index = Number(eventAppearance(cue).Layer)
    if (!Number.isSafeInteger(index) || index > 999) {
      throw new Error('ASS Layer 超出可导入的轨道范围（S0–S999）。')
    }
    const layer = Math.max(0, index)
    if (!groups.has(layer)) groups.set(layer, [])
    groups.get(layer).push(cue)
  }
  if (!groups.size) groups.set(0, [])
  return groups
}

function adoptAssSource(track, ass, styles, projectStyles, project) {
  track.ass = { lines: [...ass.lines], resolution: ass.resolution, newline: ass.newline, sourceName: ass.sourceName, indexed: true }
  const ids = new Map()
  for (const style of styles) {
    const name = field(style.fields, 'Name').trim().toLowerCase()
    const existing = projectStyles.find(item => field(item.fields, 'Name').trim().toLowerCase() === name)
    if (existing) {
      // ASS 样式名唯一：同名样式用新定义覆盖，并改成全局样式供多条轨道共用。
      // 原轨道与新轨道里的样式行都清空，导出时由共享样式统一写回，避免同名定义出现两次。
      if (existing.trackId !== undefined) {
        const owner = project.tracks.find(item => item.id === existing.trackId)
        if (owner?.ass && Number.isSafeInteger(existing.line) && owner.ass.lines[existing.line] !== undefined) {
          owner.ass.lines[existing.line] = ''
        }
      }
      if (Number.isSafeInteger(style.line) && track.ass.lines[style.line] !== undefined) track.ass.lines[style.line] = ''
      existing.fields = structuredClone(style.fields)
      existing.trackId = undefined
      delete existing.line
      delete existing.prefix
      delete existing.columns
      ids.set(style.id, existing.id)
      continue
    }
    const id = crypto.randomUUID()
    ids.set(style.id, id)
    projectStyles.push({ ...structuredClone(style), id, trackId: track.id })
  }
  return ids
}

export function importAssLayers(project, ass, groups, sourceName) {
  const highest = Math.max(...groups.keys())
  while (project.tracks.length <= highest) addTopTrack(project.tracks)
  const source = { ass, id: crypto.randomUUID() }
  const sourceStyles = ass.styles.map(style => ({ ...style, trackId: source.id }))
  for (const [index, cues] of groups) {
    const track = project.tracks.at(-index - 1)
    if (!track.ass && !track.cues.length) {
      const indices = new Map()
      const lines = withoutRemovedEvents(ass.lines, cues, indices)
      const scoped = ass.styles.map(style => ({ ...style, line: indices.get(style.line) }))
      const ids = adoptAssSource(track, { ...ass, lines, sourceName }, scoped, project.styles, project)
      track.cues = cues.map(cue => ({
        ...cue, id: crypto.randomUUID(), style: ids.get(cue.style), ass: { ...cue.ass, line: indices.get(cue.ass.line) },
      }))
    } else {
      for (const cue of cues) {
        track.cues.push(pasteCue(track, captureCue({ ...source, cues: [cue] }, cue, sourceStyles), cue.start, project.styles))
      }
    }
  }
  return project.tracks.at(-highest - 1)
}

export function moveCuesToTrack(project, source, destination, cues) {
  const localStyles = project.styles.filter(style => style.trackId === source.id)
  const ids = source.ass && !destination.ass && !destination.cues.length
    ? adoptAssSource(destination, source.ass, localStyles, project.styles) : null
  const moving = new Set(cues.map(cue => cue.id))
  for (const cue of cues) {
    if (ids) {
      const style = ids.get(cue.style) ?? cue.style
      destination.cues.push({ ...cue, style })
    } else {
      const transferred = pasteCue(destination, captureCue({ ...source, cues: [cue] }, cue, project.styles), cue.start, project.styles)
      if (transferred.assFields) transferred.assFields.Layer = String(trackIndex(project.tracks, destination))
      destination.cues.push({ ...transferred, id: cue.id, splitNeedsReview: cue.splitNeedsReview })
    }
  }
  source.cues = source.cues.filter(cue => !moving.has(cue.id))
  const colocated = new Set(destination.cues.map(cue => cue.id))
  project.links = project.links.filter(pair => !pair.every(id => colocated.has(id)))
}

export function renderAss(track, styles, adjustment, fade = false) {
  const source = track.ass
  const resolution = source?.resolution ?? { width: 1920, height: 1080 }
  const script = scriptInfo(source)
  const applicable = applicableStyles(track, styles)
  const hasDefault = applicable.some(style => field(style.fields, 'Name').trim().toLowerCase() === 'default')
  if (!hasDefault) applicable.unshift(newStyle())
  const styleLines = applicable.map(style => 'Style: ' + rowText(completeStyle(style.fields), styleFields))
  const names = new Map(applicable.map(style => [style.id, field(style.fields, 'Name').trim()]))
  const events = track.cues.map(cue => {
    const timing = cueTiming(cue, adjustment)
    const [start, end] = quantize(timing.start, timing.end)
    const values = {
      ...eventAppearance(cue, track.layer),
      Start: assTime(start),
      End: assTime(end),
      Style: names.get(cue.style) ?? eventStyleName(cue),
      Text: dialogueText(cue, start, end, fade),
    }
    return 'Dialogue: ' + rowText(values, eventFields)
  })
  const settings = source ? script.filter(line => /^\s*(?:WrapStyle|ScaledBorderAndShadow|YCbCr Matrix|LayoutResX|LayoutResY):/i.test(line)) : ['ScaledBorderAndShadow: yes']
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: ' + resolution.width, 'PlayResY: ' + resolution.height,
    ...settings, '', '[V4+ Styles]', 'Format: ' + styleFields.join(', '), ...styleLines, '',
    '[Events]', 'Format: ' + eventFields.join(', '), ...events, '',
  ].join('\n')
}
