// 读取系统已安装字体族；结果按进程缓存。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
let cached

async function macFonts() {
  const { stdout } = await run('system_profiler', ['SPFontsDataType', '-json'], { maxBuffer: 64 * 1024 * 1024 })
  const data = JSON.parse(stdout)
  const names = new Set()
  for (const font of data.SPFontsDataType ?? []) {
    for (const face of font.typefaces ?? []) {
      if (face.family) names.add(String(face.family).trim())
    }
  }
  return [...names].filter(Boolean).sort((left, right) => left.localeCompare(right))
}

async function windowsFonts() {
  const { stdout } = await run('reg.exe', ['QUERY', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'], { maxBuffer: 16 * 1024 * 1024 })
  const names = new Set()
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(.+?)\s+REG_SZ\s+/)
    if (!match) continue
    const name = match[1].replace(/\s+\((?:TrueType|OpenType|Type 1|All res|VGA res)\)\s*$/i, '').trim()
    if (!name) continue
    names.add(name)
    const family = name.replace(/\s+(?:Bold|Italic|Oblique|Light|Regular|Medium|Black|Semibold|SemiBold|Thin|Heavy|ExtraBold|Condensed|Narrow).*$/i, '').trim()
    if (family && family !== name) names.add(family)
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

export async function installedFontFamilies(platform = process.platform) {
  if (cached) return cached
  if (platform === 'darwin') cached = await macFonts()
  else if (platform === 'win32') cached = await windowsFonts()
  else cached = []
  return cached
}
