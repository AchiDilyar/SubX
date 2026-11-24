// 生成发布包 SHA-256 清单，供发布说明与 Release 资产核对。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const target = process.argv[2] ?? 'out/SubX-darwin-arm64/SubX.app'
if (!existsSync(target)) throw new Error('Release target not found: ' + target)
const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const files = []
const add = async (label, file) => {
  if (!existsSync(file)) return
  const info = await stat(file)
  files.push({ label, path: file, bytes: info.size, sha256: await digest(file) })
}
if (target.endsWith('.app')) {
  const resources = join(target, 'Contents', 'Resources')
  await add('app.asar', join(resources, 'app.asar'))
  await add('ffmpeg', join(resources, 'ffmpeg'))
  await add('ffprobe', join(resources, 'ffprobe'))
} else {
  const root = dirname(target)
  await add('app', target)
  await add('ffmpeg', join(root, 'resources', 'ffmpeg.exe'))
  await add('ffprobe', join(root, 'resources', 'ffprobe.exe'))
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const manifest = {
  product: packageJson.productName,
  version: packageJson.version,
  target,
  platform: process.platform,
  arch: process.arch,
  commit,
  generatedAt: new Date().toISOString(),
  files,
}
await mkdir('out', { recursive: true })
await writeFile('out/release-manifest.json', JSON.stringify(manifest, null, 2) + '\n')
console.log('Wrote out/release-manifest.json')
for (const file of files) console.log(file.label + ' ' + file.sha256)
