// 下载随包分发的 FFmpeg / FFprobe 内核到 resources/，供 npm run package 打进应用。
// 目前只内置 macOS Apple Silicon 的静态构建；其他平台请手动把二进制放进 resources/。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const resources = join(root, 'resources')
const targets = {
  'darwin-arm64': [
    { name: 'ffmpeg', url: 'https://www.osxexperts.net/ffmpeg902arm.zip', sha256: '6deb2860c3dc0c08e0f96bab119196c024103046fa3cc7ef72e3a77797d8553c' },
    { name: 'ffprobe', url: 'https://www.osxexperts.net/ffprobe902arm.zip', sha256: '8d56278ec2ba80f35138e7dceccb1a72eff951156691d8c733066ebd7628d3f2' },
  ],
}

const key = process.platform + '-' + process.arch
const downloads = targets[key]
if (!downloads) {
  console.error('没有 ' + key + ' 的内置下载源。请手动把 ffmpeg / ffprobe 放到 resources/（Windows 为 .exe）。')
  process.exit(1)
}
await mkdir(resources, { recursive: true })
for (const download of downloads) {
  const target = join(resources, download.name)
  if (existsSync(target) && !process.argv.includes('--force')) {
    console.log(download.name + ' 已存在，跳过。')
    continue
  }
  const archive = join(resources, download.name + '.zip')
  const unpacked = join(resources, download.name + '-unpacked')
  console.log('下载 ' + download.url)
  const response = await fetch(download.url)
  if (!response.ok) throw new Error('下载失败：HTTP ' + response.status)
  const bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(archive, bytes)
  execFileSync('ditto', ['-x', '-k', archive, unpacked])
  const binary = (await readdir(unpacked)).find(name => name === download.name)
  if (!binary) throw new Error('压缩包里没有 ' + download.name)
  // 校验解压出来的可执行文件（发布方给的是二进制哈希，不是压缩包哈希）。
  const digest = createHash('sha256').update(await readFile(join(unpacked, binary))).digest('hex')
  if (digest !== download.sha256) throw new Error(download.name + ' 校验失败：' + digest)
  // Apple Silicon 只运行已签名文件，这里做一次 ad-hoc 签名。
  if (process.platform === 'darwin') execFileSync('codesign', ['-s', '-', '-f', join(unpacked, binary)], { stdio: 'ignore' })
  await rename(join(unpacked, binary), target)
  await chmod(target, 0o755)
  await rm(archive, { force: true })
  await rm(unpacked, { recursive: true, force: true })
  console.log(download.name + ' 已就绪（' + Math.round(bytes.length / 1024 / 1024) + ' MB）')
}
