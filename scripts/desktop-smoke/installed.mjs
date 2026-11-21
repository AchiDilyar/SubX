import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { readAss } from '../../src/core/ass.mjs'
import { createProject, createTrack, splitTrack } from '../../src/core/project.mjs'
import { readSrt } from '../../src/core/srt.mjs'

const executable = process.argv[2]
assert(executable, 'Provide the path to the installed SubX executable')
const profile = await mkdtemp(join(tmpdir(), 'subx-installed-'))
const fixture = name => fileURLToPath(new URL('./fixtures/' + name, import.meta.url))
let child
let exited
let socket

async function waitFor(description, predicate) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await predicate()
    if (value) return value
    await delay(100)
  }
  throw Error('Timed out: ' + description)
}

async function openWorkspace() {
  const portFile = join(profile, 'DevToolsActivePort')
  return waitFor('installed window', async () => {
    if (child.exitCode !== null) throw Error('SubX exited with code ' + child.exitCode)
    const contents = await readFile(portFile, 'utf8').catch(() => '')
    const port = Number(contents.split('\n')[0])
    if (!port) return
    const pages = await fetch('http://127.0.0.1:' + port + '/json/list', {
      signal: AbortSignal.timeout(1000),
    }).then(response => response.json()).catch(() => [])
    return pages.find(page => page.url === 'subx://app/renderer/index.html')
  })
}

try {
  const project = createProject()
  project.media = fixture('video.mp4')
  const ffmpeg = process.env.SUBX_FFMPEG_PATH
  if (ffmpeg) {
    const withAudio = join(profile, 'waveform.mp4')
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', project.media, '-f', 'lavfi',
      '-i', 'aevalsrc=0.8*sin(2*PI*440*t)|-0.8*sin(2*PI*440*t):d=5',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', withAudio,
    ])
    project.media = withAudio
  }
  project.settings = { fade: true, watermark: true }
  const srt = createTrack('Bilingual', readSrt(await readFile(fixture('input.srt'), 'utf8')))
  project.tracks.push(srt)
  splitTrack(project, srt.id, false)
  let inputAss = await readFile(fixture('styles.ass'), 'utf8')
  const checkFonts = process.platform === 'darwin'
  if (checkFonts) {
    const fontProbeStyle = inputAss.match(/^Style: Default,.*$/m)[0].replace('Default,Noto Sans SC', 'FontProbe,Courier New')
    inputAss = inputAss.replace('[Events]', fontProbeStyle + '\n\n[Events]')
    inputAss += [
      String.raw`Dialogue: 0,0:00:00.00,0:00:00.50,,FontProbe,0,0,0,,{\an5\fad(0,0)}iiiiiiiiiiiiiiiiiiii`,
      String.raw`Dialogue: 0,0:00:00.50,0:00:01.00,,FontProbe,0,0,0,,{\an5\fad(0,0)\fnGeorgia}iiiiiiiiiiiiiiiiiiii`,
      '',
    ].join('\n')
  }
  const { cues, styles, ...ass } = readAss(inputAss)
  const track = createTrack('Positioned ASS', cues)
  track.ass = ass
  project.tracks.push(track)
  project.styles = styles.map(style => ({ ...style, trackId: track.id }))

  const projectPath = join(profile, 'bundle-check.subx')
  await writeFile(projectPath, JSON.stringify(project), 'utf8')
  await writeFile(join(profile, 'recent-projects.json'), JSON.stringify([projectPath]), 'utf8')

  child = spawn(executable, [
    '--user-data-dir=' + profile,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
  ], { stdio: 'inherit' })
  exited = once(child, 'close')
  await once(child, 'spawn')
  const target = await openWorkspace()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')

  let nextId = 0
  async function evaluate(expression) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(3000)
      function receive(event) {
        const reply = JSON.parse(event.data)
        if (reply.id !== id) return
        signal.removeEventListener('abort', timeout)
        socket.removeEventListener('message', receive)
        const error = reply.error?.message || reply.result?.exceptionDetails?.text
        if (error) reject(Error(error))
        else resolve(reply.result.result.value)
      }
      function timeout() {
        socket.removeEventListener('message', receive)
        reject(Error('Renderer evaluation timed out'))
      }
      signal.addEventListener('abort', timeout, { once: true })
      socket.addEventListener('message', receive)
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    })
  }

  await waitFor('workspace initialization', () => evaluate('document.querySelector("#ruler")?.children.length > 0'))
  await waitFor('new project layout', () => evaluate(`document.querySelectorAll('.track-lane').length === 2 &&
    document.querySelector('.style-list-item')?.title === '默认样式' &&
    document.querySelector('.end-tick')?.textContent === '00:00:10'`))
  assert(await evaluate(`(() => {
    const zoom = document.querySelector('#zoom')
    zoom.value = 160
    zoom.dispatchEvent(new Event('input'))
    const track = document.querySelector('#track-data')
    return parseFloat(track.style.getPropertyValue('--timeline-end')) === 1600 && track.clientWidth === 1920
  })()`), 'The empty project has ten seconds of content and two seconds of scrollable tail')
  await evaluate('document.querySelector("#recent-projects").click()')
  await waitFor('recent project', () => evaluate('document.querySelector("#recent-list button")?.textContent === "bundle-check.subx"'))
  await evaluate('document.querySelector("#recent-list button").click()')
  await waitFor('4K video decode', () => evaluate('document.querySelector("video").readyState >= 2 && document.querySelector("video").videoWidth === 3840'))
  await waitFor('frame analysis', () => evaluate(`document.querySelector('#ruler').dataset.frameIndex !== 'loading'`))
  if (await evaluate(`document.querySelector('#ruler').dataset.frameIndex === 'ready'`)) {
    await evaluate(`document.querySelector('#ruler').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
    await waitFor('one-frame playhead advance', () => evaluate(`document.querySelector('#timecode').value === '00:00:00.167'`))
  }
  if (ffmpeg) {
    await waitFor('symmetric audio peaks', () => evaluate(`(() => {
      const canvas = document.querySelector('#waveform')
      if (canvas.dataset.hasAudio !== 'true') return false
      const { width, height } = canvas
      const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data
      for (let x = 4; x < Math.min(80, width); x++) {
        const peaks = []
        for (let y = 0; y < height; y++) {
          const index = (y * width + x) * 4
          if (pixels[index] === 85 && pixels[index + 1] === 100 && pixels[index + 2] === 116) peaks.push(y)
        }
        if (peaks.length > height / 3 && Math.abs((peaks[0] + peaks.at(-1)) / 2 - (height - 1) / 2) < 1.5) return true
      }
      return false
    })()`))
    console.log('PASS bundle draws stereo peaks symmetrically around the timeline centerline')
  }
  if (checkFonts) {
    const glyphWidth = `(() => {
      const canvas = document.querySelector('.ass-layer:not(.generated-layer)')
      if (canvas?.dataset.ready !== 'true' || !canvas.width) return 0
      const { width, height } = canvas
      const data = canvas.getContext('2d').getImageData(0, 0, width, height).data
      let left = width, right = -1
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] <= 80) continue
        const x = ((i - 3) / 4) % width
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
      return Math.max(0, right - left + 1)
    })()`
    await evaluate('document.querySelector("video").currentTime = .3')
    const courierWidth = await waitFor('Courier New rendered in the ASS canvas', () => evaluate(glyphWidth))
      .catch(async error => {
        const state = await evaluate(`(() => {
          const canvas = document.querySelector('.ass-layer:not(.generated-layer)')
          const video = document.querySelector('video')
          return { ready: canvas?.dataset.ready, size: [canvas?.width, canvas?.height],
            time: video.currentTime, seeking: video.seeking, status: document.querySelector('#status').textContent }
        })()`)
        throw new Error(error.message + ' ' + JSON.stringify(state))
      })
    await evaluate('document.querySelector("video").currentTime = .8')
    const georgiaWidth = await waitFor('Georgia inline override changes the actual glyph width', async () => {
      const georgiaWidth = await evaluate(glyphWidth)
      return georgiaWidth > 0 && georgiaWidth < courierWidth * .8 ? georgiaWidth : 0
    })
    await evaluate('document.querySelector("video").currentTime = .3')
    await waitFor('restore the Courier New glyph run before editing the style', async () => await evaluate(glyphWidth) === courierWidth)
    await evaluate(`(() => {
      const style = [...document.querySelectorAll('.style-list-item')].find(row => row.title === 'FontProbe')
      style.querySelector('[aria-label=编辑]').click()
      const font = [...document.querySelectorAll('#style-editor input')].find(input => input.value === 'Courier New')
      font.value = 'Georgia Bold'
      font.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor('editing the style to an installed full face name refreshes the canvas', async () => {
      const width = await evaluate(glyphWidth)
      return width > georgiaWidth * .8 && width < georgiaWidth * 1.4
    })
    await evaluate('document.querySelector("#style-editor .discard-draft").click()')
    console.log('PASS ASS uses installed families, inline overrides and full face names during style edits')
  }
  await evaluate('document.querySelector("video").currentTime = 2')
  await waitFor('bilingual libass overlay and watermark', () => evaluate(`(() => {
    const hasPixels = selector => {
      const canvas = document.querySelector(selector)
      return canvas?.dataset.ready === 'true' && canvas.width > 0 &&
        canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
          .some((value, i) => i % 4 === 3 && value > 50)
    }
    return hasPixels('[data-layer="plain-subtitles"]') && hasPixels('[data-layer="watermark"]') &&
      document.querySelector('#project-fade').checked && document.querySelector('#project-watermark').checked
  })()`))
  await waitFor('ASS bitmap', () => evaluate(`(() => {
    const canvas = document.querySelector(".ass-layer:not(.generated-layer)")
    if (canvas?.dataset.ready !== "true") return false
    const pixels = canvas.getContext("2d").getImageData(canvas.width * .35, canvas.height * .05, canvas.width * .30, canvas.height * .25).data
    return pixels.some((value, i) => i % 4 === 3 && value > 180)
  })()`))
  console.log('PASS SubX bundle opens a project and renders bilingual subtitles, ASS positioning and the watermark')
} finally {
  socket?.close()
  if (child?.pid) {
    child.kill()
    await exited
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 8 })
}
