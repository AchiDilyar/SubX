// 字体检查：工程样式引用的字体是否在系统已安装字体族中。
export function normalizeFontName(name) {
  return String(name ?? '').trim().replace(/^@/, '').toLowerCase()
}

export function missingStyleFonts(styles, installed) {
  const available = new Set((installed ?? []).map(normalizeFontName))
  const missing = []
  const seen = new Set()
  for (const style of styles ?? []) {
    const font = String(style.fields?.Fontname ?? style.font ?? '').trim()
    const key = normalizeFontName(font)
    if (!font || available.has(key) || seen.has(key)) continue
    seen.add(key)
    missing.push({ styleId: style.id, styleName: String(style.fields?.Name ?? style.name ?? '未命名样式'), font })
  }
  return missing
}

export function fontCheckSummary(missing, styleCount) {
  if (!missing.length) return styleCount ? '所有样式字体均已安装' : '当前工程没有样式'
  return missing.length + ' 个字体缺失，涉及 ' + missing.length + ' 个样式'
}
