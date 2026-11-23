// Windows .subx 文件关联：HKCU 注册，安装/更新时写入，卸载时清理。
import { execFileSync } from 'node:child_process'

const CLASSES = 'HKCU\\Software\\Classes'
const PROG_ID = 'SubX.Project'

export function associationEntries(exe = process.execPath) {
  return [
    [CLASSES + '\\.subx', '', PROG_ID],
    [CLASSES + '\\' + PROG_ID, '', 'SubX 工程'],
    [CLASSES + '\\' + PROG_ID + '\\DefaultIcon', '', '"' + exe + '",0'],
    [CLASSES + '\\' + PROG_ID + '\\shell\\open\\command', '', '"' + exe + '" "%1"'],
  ]
}

export function associationArgs(key, name, value) {
  return name
    ? ['ADD', key, '/v', name, '/d', value, '/f']
    : ['ADD', key, '/ve', '/d', value, '/f']
}

export function parseRegDefault(output) {
  const match = String(output).match(/REG_SZ\s+(.+)\s*$/m)
  return match ? match[1].trim() : null
}

function queryDefault(key) {
  try {
    return parseRegDefault(execFileSync('reg.exe', ['QUERY', key, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
}

export function fileAssociationOwned() {
  return queryDefault(CLASSES + '\\.subx') === PROG_ID
}

export function registerFileAssociation(exe = process.execPath) {
  for (const [key, name, value] of associationEntries(exe)) {
    execFileSync('reg.exe', associationArgs(key, name, value), { stdio: 'ignore' })
  }
}

export function ensureFileAssociation(exe = process.execPath) {
  const current = queryDefault(CLASSES + '\\.subx')
  if (current && current !== PROG_ID) return false
  registerFileAssociation(exe)
  return true
}

export function unregisterFileAssociation() {
  if (!fileAssociationOwned()) return false
  for (const key of [CLASSES + '\\' + PROG_ID, CLASSES + '\\.subx']) {
    try {
      execFileSync('reg.exe', ['DELETE', key, '/f'], { stdio: 'ignore' })
    } catch {}
  }
  return true
}
