import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isSolidMedia } from '../core/project.mjs'

const inspect = promisify(execFile)
const codecs = new Map([['h264', 'libx264'], ['hevc', 'libx265']])

function validWatermark(watermark) {
  return watermark === undefined || watermark === null || (typeof watermark === 'object' &&
    typeof watermark.path === 'string' && watermark.path.length > 0 && !watermark.path.includes('\0') &&
    Number.isFinite(watermark.scale) && watermark.scale >= 1 && watermark.scale <= 100 &&
    Number.isFinite(watermark.x) && watermark.x >= 0 && watermark.x <= 100 &&
    Number.isFinite(watermark.y) && watermark.y >= 0 && watermark.y <= 100 &&
    Number.isFinite(watermark.opacity) && watermark.opacity >= 0 && watermark.opacity <= 100)
}

export function validateComposition(options) {
  if (!options || !validWatermark(options.watermark) || !codecs.has(options.codec) || !['fast', 'medium', 'slow'].includes(options.preset) ||
      !Number.isInteger(options.crf) || options.crf < 0 || options.crf > 51 ||
      !['source', '720', '1080', '2160'].includes(options.height) ||
      !['source', '24', '25', '30', '60'].includes(options.fps) || !['128', '192', '320', 'none'].includes(options.audio) ||
      (options.solid !== undefined && !isSolidMedia(options.solid)) ||
      !Array.isArray(options.layers) || options.layers.some(layer => typeof layer !== 'string' || layer.includes('\0'))) {
    throw new Error('无效的视频合成设置。')
  }
}

function ffmpegDirectories() {
  const directories = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  if (process.platform === 'darwin') {
    directories.push('/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin', '/opt/homebrew/bin', '/usr/local/bin')
  }
  return directories
}

// 随应用打包的 FFmpeg：打包后在 Resources 下，开发时在仓库 resources/ 下。
export function bundledEncoders() {
  const binary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const list = []
  if (process.resourcesPath) list.push(join(process.resourcesPath, binary))
  try { list.push(fileURLToPath(new URL('../../resources/' + binary, import.meta.url))) } catch {}
  return list
}

export async function findEncoder(options, savedPath, signal, selectedPath) {
  const binary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = selectedPath ? [selectedPath] :
    [process.env.SUBX_FFMPEG_PATH, savedPath, ...bundledEncoders(), ...ffmpegDirectories().map(dir => join(dir, binary))]
  const probe = { encoding: 'utf8', windowsHide: true, timeout: 5000, signal }
  for (const file of new Set(candidates)) {
    signal.throwIfAborted()
    if (!file || !isAbsolute(file) || basename(file).toLowerCase() !== binary) continue
    try {
      await access(file, constants.X_OK)
      if (!options) return file
      const { stdout } = await inspect(file, ['-hide_banner', '-encoders'], probe)
      if (!stdout.includes(' ' + codecs.get(options.codec) + ' ') ||
          (options.audio !== 'none' && !stdout.includes(' aac '))) continue
      if (options.layers.length) {
        const filters = await inspect(file, ['-hide_banner', '-filters'], probe)
        if (!/^\s*\S+\s+ass\s+V->V/m.test(filters.stdout)) continue
      }
      return file
    } catch {
      signal.throwIfAborted()
    }
  }
  return null
}

function runEncoder(file, args, cwd, signal, progress) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const abort = () => child.kill('SIGKILL')
    signal.addEventListener('abort', abort, { once: true })
    let failure
    let diagnostic = ''
    let pending = ''
    child.on('error', error => { failure = error })
    child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-1800) })
    child.stdout.setEncoding('utf8').on('data', chunk => {
      const lines = (pending + chunk).split('\n')
      pending = lines.pop()
      for (const line of lines) {
        const match = /^out_time_us=(\d+)\s*$/.exec(line)
        if (match) progress(Number(match[1]) / 1e6)
      }
    })
    child.on('close', (code, reason) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (failure) reject(failure)
      else if (code !== 0) reject(new Error('FFmpeg 合成失败。' + (diagnostic.trim() || reason || '退出码 ' + code)))
      else resolve()
    })
  })
}

async function destinationState(file, source) {
  let info
  try {
    info = await lstat(file, { bigint: true })
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!info.isFile()) throw new Error('请选择普通 MP4 文件作为输出。')
  if (source && info.dev === source.dev && info.ino === source.ino) throw new Error('输出文件和源视频相同，请选择其他文件名。')
  return info
}

export async function encodeVideo({ binary, source, solid, destination, options, signal, progress = () => {} }) {
  validateComposition(options)
  signal.throwIfAborted()
  if (extname(destination).toLowerCase() !== '.mp4') throw new Error('请将输出文件保存为 .mp4。')
  const sourceInfo = solid ? null : await stat(source, { bigint: true })
  const original = solid ? null : await destinationState(destination, sourceInfo)
  const work = await mkdtemp(join(dirname(destination), '.subx-video-'))
  try {
    const filters = []
    if (options.fps !== 'source') filters.push('fps=' + options.fps)
    if (options.height === 'source') filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2')
    else filters.push('scale=-2:' + options.height)
    if (options.layers.length) {
      await mkdir(join(work, 'fonts'))
      const font = await readFile(new URL('../assets/NotoSansSC.ttf', import.meta.url))
      await writeFile(join(work, 'fonts', 'NotoSansSC.ttf'), font)
    }
    for (const [index, layer] of options.layers.entries()) {
      signal.throwIfAborted()
      const name = 'track-' + index + '.ass'
      await writeFile(join(work, name), layer)
      filters.push('ass=' + name + ':fontsdir=fonts')
    }
    // 空白视频用 lavfi 的纯色源生成画面，不依赖任何媒体文件。
    const input = solid
      ? ['-f', 'lavfi', '-i', 'color=c=0x' + solid.color.slice(1) + ':s=' + solid.width + 'x' + solid.height +
        ':r=' + solid.fps + ':d=' + solid.duration / 1000]
      : ['-protocol_whitelist', 'file', '-f', /\.(webm|mkv)$/i.test(source) ? 'matroska' : 'mov', '-i', resolve(source)]
    const watermark = options.watermark
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...input]
    if (watermark) {
      // 水印图片作为第二路输入：按画面宽度的百分比缩放，再按百分比定位叠加。
      args.push('-i', resolve(watermark.path))
      const graph = [
        filters.length ? '[0:v]' + filters.join(',') + '[base]' : '[0:v]null[base]',
        '[1:v]format=rgba,colorchannelmixer=aa=' + (watermark.opacity / 100).toFixed(3) + '[wma]',
        '[wma][base]scale2ref=w=ref_w*' + (watermark.scale / 100).toFixed(4) + ':h=ow/mdar[wm][base2]',
        '[base2][wm]overlay=x=main_w*' + (watermark.x / 100).toFixed(4) + ':y=main_h*' +
          (watermark.y / 100).toFixed(4) + ':format=auto:eof_action=repeat[out]',
      ].join(';')
      args.push('-filter_complex', graph, '-map', '[out]')
    } else {
      args.push('-map', '0:V:0', '-vf', filters.join(','))
    }
    args.push('-c:v', codecs.get(options.codec), '-preset', options.preset,
      '-crf', String(options.crf), '-pix_fmt', 'yuv420p')
    if (options.codec === 'hevc') args.push('-tag:v', 'hvc1')
    if (solid || options.audio === 'none') args.push('-an')
    else args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', options.audio + 'k')
    args.push('-movflags', '+faststart', '-f', 'mp4', 'output.mp4')
    await runEncoder(binary, args, work, signal, progress)
    const output = join(work, 'output.mp4')
    if (original && process.platform !== 'win32') await chmod(output, Number(original.mode & 0o777n))
    if (!solid) {
      const latest = await destinationState(destination, sourceInfo)
      if (['dev', 'ino', 'size', 'ctimeNs'].some(key => original?.[key] !== latest?.[key])) {
        throw new Error('目标文件已变化，请重新选择输出文件。')
      }
    }
    signal.throwIfAborted()
    await rename(output, destination)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// Stream low-rate float PCM and retain extrema over at most 24,000 time bins.
export async function readWaveform(binary, source, duration, signal) {
  const rate = 8000
  const stride = Math.max(80, Math.ceil(duration * rate / 24000))
  const peaks = new Float32Array(Math.ceil(duration * rate / stride))
  const demuxer = /\.(webm|mkv)$/i.test(source) ? 'matroska' : 'mov'
  signal.throwIfAborted()
  const child = spawn(binary, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file',
    '-f', demuxer, '-i', resolve(source), '-map', '0:a:0', '-vn',
    '-af', 'aresample=8000:async=1:first_pts=0', '-ac', '2', '-ar', String(rate),
    '-t', String(duration), '-f', 'f32le', 'pipe:1',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], signal })
  const done = new Promise(resolve => {
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
  let sample = 0
  let remainder = Buffer.alloc(0)
  for await (const chunk of child.stdout) {
    const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk
    const end = data.length - data.length % 8
    for (let offset = 0; offset < end; offset += 8, sample++) {
      const bin = Math.floor(sample / stride)
      if (bin < peaks.length) peaks[bin] = Math.max(peaks[bin], Math.min(1, Math.max(Math.abs(data.readFloatLE(offset)), Math.abs(data.readFloatLE(offset + 4)))))
    }
    remainder = data.subarray(end)
  }
  if (!await done || signal.aborted) return null
  return { peaks, step: stride * 1000 / rate }
}

export async function readFrameTimes(savedPath, source, signal) {
  const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const preferred = [process.env.SUBX_FFMPEG_PATH, savedPath, ...bundledEncoders()]
    .filter(file => file && isAbsolute(file)).map(file => dirname(file))
  let probe
  for (const directory of new Set([...preferred, ...ffmpegDirectories()])) {
    signal.throwIfAborted()
    const candidate = join(directory, name)
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
      probe = candidate
      break
    }
  }
  if (!probe) return null
  const demuxer = /\.(webm|mkv)$/i.test(source) ? 'matroska' : 'mov'
  const base = ['-v', 'error', '-protocol_whitelist', 'file', '-f', demuxer, '-select_streams', 'V:0',
    '-of', 'compact=p=1:nk=0', '-i', resolve(source)]
  const options = { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 64 * 1024 * 1024, signal }
  function collect(stdout, pattern) {
    const origin = Number(/^format\|start_time=(-?\d+(?:\.\d+)?)/m.exec(stdout)?.[1] ?? 0)
    const timestamps = new Set()
    for (const [, timestamp] of stdout.matchAll(pattern)) {
      const microseconds = Math.round((Number(timestamp) - origin) * 1e6)
      if (Number.isSafeInteger(microseconds) && microseconds >= 0) timestamps.add(microseconds)
    }
    return [...timestamps].sort((a, b) => a - b)
  }
  // 先用 packet 时间戳：不解析每一帧，长视频也只要零点几秒。
  const packets = await inspect(probe, ['-show_entries', 'packet=pts_time:format=start_time', ...base], options)
  const packetTimes = collect(packets.stdout, /^packet\|pts_time=(-?\d+(?:\.\d+)?)/gm)
  if (packetTimes.length) return Float64Array.from(packetTimes, value => value / 1000)
  // 极少数文件没有 packet pts：退回逐帧解析。
  const frames = await inspect(probe, ['-show_entries', 'frame=best_effort_timestamp_time:format=start_time', ...base], options)
  return Float64Array.from(collect(frames.stdout, /^frame\|best_effort_timestamp_time=(-?\d+(?:\.\d+)?)/gm), value => value / 1000)
}
