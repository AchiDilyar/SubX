const srtTime = /(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})/
const timingLine = new RegExp('^(' + srtTime.source + ')\\s*-->\\s*(' + srtTime.source + ')(?:\\s.*)?$')

export function readTime(value) {
  const match = value.trim().match(new RegExp('^' + srtTime.source + '$'))
  if (!match) return NaN
  const [, hours, minutes, seconds, milliseconds] = match.map(Number)
  if (minutes > 59 || seconds > 59) return NaN
  const time = ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds
  return Number.isSafeInteger(time) ? time : NaN
}

export function printTime(time, separator = ',') {
  const pad = (value, length = 2) => String(value).padStart(length, '0')
  return [
    pad(Math.floor(time / 3600000)),
    pad(Math.floor(time / 60000) % 60),
    pad(Math.floor(time / 1000) % 60),
  ].join(':') + separator + pad(time % 1000, 3)
}

export function inspectSrt(source) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r\n?|\n/)
  const cues = []
  const issues = []
  let last = lines.length - 1
  while (lines[last] === '') last--
  let first = 0
  for (let index = 0; index <= last + 1; index++) {
    // Preserve a final spaces-only body line that the SRT writer can emit.
    if (index <= last && (!/^[ \t]*$/.test(lines[index]) || (index === last && first < index))) continue
    const blockStart = first
    first = index + 1
    if (blockStart === index) continue
    const timingIndex = blockStart + Number(/^\d+$/.test(lines[blockStart].trim()))
    const timing = timingIndex < index ? lines[timingIndex].trim().match(timingLine) : null
    const start = timing ? readTime(timing[1]) : NaN
    const end = timing ? readTime(timing[6]) : NaN
    let reason
    if (timingIndex === index) reason = '缺少时间码'
    else if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) reason = '时间码格式或数值无效'
    else if (end <= start) reason = '结束时间须晚于开始时间'
    if (reason) {
      const entry = cues.length + issues.length + 1
      const line = Math.min(timingIndex, index - 1) + 1
      issues.push(`第 ${entry} 条字幕（第 ${line} 行）${reason}`)
    } else {
      cues.push({ start, end, text: lines.slice(timingIndex + 1, index).join('\n') })
    }
  }
  return { cues, issues }
}

export function readSrt(source) {
  const { cues, issues } = inspectSrt(source)
  if (issues.length) throw new Error(issues[0])
  return cues
}

export function writeSrt(cues) {
  if (cues.some(cue => /\n[ \t]*\n/.test(cue.text) || /^\n|\n$/.test(cue.text))) {
    throw new Error('SRT 的空行用于分隔条目。请删掉字幕正文首尾或中间的空行。')
  }
  return [...cues].sort((a, b) => a.start - b.start).map((cue, index) =>
    [index + 1, printTime(cue.start) + ' --> ' + printTime(cue.end), cue.text].join('\n')
  ).join('\n\n') + (cues.length ? '\n' : '')
}
