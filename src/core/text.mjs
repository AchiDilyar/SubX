// 字幕正文的查找/替换：ASS 覆盖块 {...} 默认视为不可编辑区域。
// 这样正则替换不会把 \i1、\pos(...) 之类的标签改坏；SRT 文本由调用方关闭 maskTags。

function splitSegments(text) {
  const segments = []
  let index = 0
  const pattern = /\{[^}]*\}/g
  let match
  while ((match = pattern.exec(text))) {
    if (match.index > index) segments.push({ tag: false, text: text.slice(index, match.index), start: index })
    segments.push({ tag: true, text: match[0], start: match.index })
    index = match.index + match[0].length
  }
  if (index < text.length) segments.push({ tag: false, text: text.slice(index), start: index })
  return segments
}

function compile(query, { regex = false, caseSensitive = false } = {}) {
  if (!query) return null
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(source, caseSensitive ? 'g' : 'gi')
}

// String.replace 的回调参数：match, p1..pn, offset, string[, groups]。
function callbackMatch(args) {
  const match = args[0]
  const rest = args.slice(1)
  const groups = rest.length && typeof rest[rest.length - 1] === 'object' ? rest.pop() : undefined
  const input = rest.pop()
  const index = rest.pop()
  const result = [match, ...rest]
  result.input = input
  result.index = index
  result.groups = groups
  return result
}

function replaceSegment(text, pattern, replacement) {
  let count = 0
  const next = text.replace(pattern, (...args) => {
    // 与查找结果保持一致：零长度匹配不产生替换，也不计入替换数。
    if (!args[0].length) return args[0]
    count += 1
    return expandReplacement(replacement, callbackMatch(args))
  })
  return { text: next, count }
}

// 与原生 String.replace 一致的替换语法：$$、$&、$`、$'、$n、$<name>；$0 保持字面量。
function expandReplacement(replacement, match) {
  return String(replacement).replace(/\$(\$|&|`|'|<([^>]+)>|\d{1,2})/g, (all, token, name) => {
    if (token === '$') return '$'
    if (token === '&') return match[0]
    if (token === '`') return match.input.slice(0, match.index)
    if (token === "'") return match.input.slice(match.index + match[0].length)
    if (name !== undefined) return match.groups && Object.hasOwn(match.groups, name) ? match.groups[name] : all
    const group = Number(token)
    if (group === 0) return all
    if (group >= match.length) {
      const first = Number(String(token)[0])
      if (first > 0 && first < match.length) return (match[first] ?? '') + String(token).slice(1)
      return all
    }
    return match[group] ?? ''
  })
}

// 返回匹配位置（相对原始正文），方便 UI 定位并高亮。
export function findTextMatches(text, query, options = {}) {
  const pattern = compile(query, options)
  if (!pattern) return []
  const segments = options.maskTags ? splitSegments(text) : [{ tag: false, text, start: 0 }]
  const matches = []
  for (const segment of segments) {
    if (segment.tag) continue
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(segment.text))) {
      if (!match[0].length) {
        pattern.lastIndex += 1
        continue
      }
      matches.push({ index: segment.start + match.index, length: match[0].length, text: match[0] })
    }
  }
  return matches.sort((left, right) => left.index - right.index)
}

// 替换全部匹配；replacement 支持 $&、$1 等原生替换语法。
export function replaceTextMatches(text, query, replacement, options = {}) {
  const pattern = compile(query, options)
  if (!pattern) return { text, count: 0 }
  if (!options.maskTags) return replaceSegment(text, compile(query, options), replacement)
  const segments = splitSegments(text)
  let count = 0
  const next = segments.map(segment => {
    if (segment.tag) return segment.text
    const result = replaceSegment(segment.text, compile(query, options), replacement)
    count += result.count
    return result.text
  }).join('')
  return { text: next, count }
}

// 只替换指定位置的一个匹配，用于“替换当前”。
export function replaceTextAt(text, query, replacement, targetIndex, options = {}) {
  const pattern = compile(query, options)
  if (!pattern) return { text, count: 0 }
  const segments = options.maskTags ? splitSegments(text) : [{ tag: false, text, start: 0 }]
  for (const segment of segments) {
    if (segment.tag) continue
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(segment.text))) {
      if (!match[0].length) {
        pattern.lastIndex += 1
        continue
      }
      const index = segment.start + match.index
      if (index === targetIndex) {
        const expanded = expandReplacement(replacement, match)
        return { text: text.slice(0, index) + expanded + text.slice(index + match[0].length), count: 1 }
      }
      if (index > targetIndex) break
    }
  }
  return { text, count: 0 }
}
