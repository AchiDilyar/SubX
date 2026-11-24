// 发布包静态检查：应用入口、asar、内置 FFmpeg/字体、版本与签名。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const target = process.argv[2] ?? 'out/SubX-darwin-arm64/SubX.app'
const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const failures = []
const passes = []
const check = (condition, message) => {
  if (condition) passes.push(message)
  else failures.push(message)
}
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const executable = file => {
  try { execFileSync(file, ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}

if (target.endsWith('.app')) {
  const contents = join(target, 'Contents')
  const app = join(contents, 'MacOS', 'SubX')
  const resources = join(contents, 'Resources')
  const asar = join(resources, 'app.asar')
  check(existsSync(app), 'macOS executable exists')
  check(existsSync(asar), 'app.asar exists')
  check(existsSync(join(resources, 'ffmpeg')) && executable(join(resources, 'ffmpeg')), 'bundled ffmpeg runs')
  check(existsSync(join(resources, 'ffprobe')) && executable(join(resources, 'ffprobe')), 'bundled ffprobe runs')
  check(existsSync(join(resources, 'SubXProjectFile.icns')), 'project document icon exists')
  try {
    const version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(contents, 'Info.plist')], { encoding: 'utf8' }).trim()
    check(version === packageJson.version, 'Info.plist version matches package.json (' + version + ')')
  } catch {
    failures.push('could not read Info.plist version')
  }
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', target], { stdio: 'ignore' })
    passes.push('codesign verification passed')
  } catch {
    failures.push('codesign verification failed')
  }
  if (existsSync(asar)) {
    const info = await stat(asar)
    check(info.size > 1024 * 1024, 'app.asar is non-trivial (' + Math.round(info.size / 1024) + ' KB)')
    console.log('app.asar sha256 ' + await digest(asar))
  }
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const file = join(resources, tool)
    if (existsSync(file)) console.log(tool + ' sha256 ' + await digest(file))
  }
} else {
  check(existsSync(target), 'Windows executable exists')
  const root = target.replace(/[\\/][^\\/]+$/, '')
  check(existsSync(join(root, 'resources', 'ffmpeg.exe')), 'bundled ffmpeg.exe exists')
  check(existsSync(join(root, 'resources', 'ffprobe.exe')), 'bundled ffprobe.exe exists')
}

for (const line of passes) console.log('PASS ' + line)
for (const line of failures) console.error('FAIL ' + line)
if (failures.length) process.exit(1)
console.log('Release package checks passed for ' + target)
