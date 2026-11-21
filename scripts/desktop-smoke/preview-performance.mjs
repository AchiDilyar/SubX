import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// This function runs inside the Electron renderer through executeJavaScript.
async function sampleQuality(divisor) {
  const video = document.querySelector('#video')
  const quality = document.querySelector('#quality')
  const canvas = document.querySelector('#preview-canvas')
  const durations = []
  const intervals = []
  const draws = []
  const frame = document.querySelector('#frame')
  const originalDraw = CanvasRenderingContext2D.prototype.drawImage
  let measure = false
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    if (this.canvas !== canvas || !measure) return originalDraw.apply(this, args)
    const started = performance.now()
    const result = originalDraw.apply(this, args)
    draws.push(performance.now() - started)
    return result
  }

  let callback
  try {
    video.pause()
    await new Promise(resolve => {
      video.addEventListener('seeked', resolve, { once: true })
      video.currentTime = 0
    })
    const bounds = frame.getBoundingClientRect()
    quality.value = String(divisor)
    quality.dispatchEvent(new Event('change'))
    await video.play()

    const samples = await new Promise((resolve, reject) => {
      let first
      let last
      const timeout = setTimeout(() => reject(Error('Video did not reach the end of the measurement interval')), 10000)
      const observe = (_now, metadata) => {
        if (metadata.mediaTime >= 0.4) {
          if (!first) {
            first = video.getVideoPlaybackQuality()
            measure = true
          }
          if (last !== undefined) intervals.push(metadata.presentationTime - last)
          if (Number.isFinite(metadata.processingDuration)) durations.push(metadata.processingDuration * 1000)
          last = metadata.presentationTime
          if (metadata.mediaTime >= 3.0) {
            clearTimeout(timeout)
            const end = video.getVideoPlaybackQuality()
            resolve({
              totalFrames: end.totalVideoFrames - first.totalVideoFrames,
              droppedFrames: end.droppedVideoFrames - first.droppedVideoFrames,
            })
            return
          }
        }
        callback = video.requestVideoFrameCallback(observe)
      }
      callback = video.requestVideoFrameCallback(observe)
    })
    return {
      divisor, ...samples, intervals, durations, draws,
      width: divisor === 1 ? video.videoWidth : canvas.width,
      height: divisor === 1 ? video.videoHeight : canvas.height,
      showCanvas: !canvas.hidden,
      pictureUnchanged: ['x', 'y', 'width', 'height'].every(key => bounds[key] === frame.getBoundingClientRect()[key]),
    }
  } finally {
    video.cancelVideoFrameCallback(callback)
    video.pause()
    CanvasRenderingContext2D.prototype.drawImage = originalDraw
  }
}

function p95(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2))
}

export async function verifyPreviewPerformance({ directory, click, exec, expect, chooseExport }) {
  await click('open-media')
  await expect('document.querySelector("#video").readyState >= 2', 'decode performance sample')
  const media = await exec(`(() => {
    const video = document.querySelector('#video')
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration }
  })()`)
  assert(media.width >= 3840 && media.height >= 2160 && media.duration >= 4, 'Provide a 4K video at least four seconds long')
  await click('import-subtitles')
  await expect('document.querySelectorAll(".track-lane").length === 1', 'load the SRT overlay track')
  await click('import-subtitles')
  await expect('document.querySelector(".ass-layer:not(.generated-layer)")?.dataset.ready === "true"', 'load the ASS overlay track')

  async function exportAss(name) {
    await chooseExport('ass')
    const file = join(directory, name)
    for (let i = 0; i < 100; i++) {
      try {
        return await readFile(file)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await delay(50)
      }
    }
    const status = await exec('document.querySelector("#status").textContent')
    throw Error('Subtitle export missing: ' + name + ' (' + status + ')')
  }

  const before = await exportAss('before.ass')
  await click('play')
  await expect('document.querySelector("#video").currentTime > 0.1', 'play before switching preview quality')
  await exec(`(() => {
    const video = document.querySelector('#video')
    const quality = document.querySelector('#quality')
    const time = video.currentTime
    const source = video.currentSrc
    for (const divisor of [2, 4, 1]) {
      quality.value = String(divisor)
      quality.dispatchEvent(new Event('change'))
      if (video.paused || video.seeking || video.currentSrc !== source || Math.abs(video.currentTime - time) > 0.1) {
        throw Error('Quality switch changed video playback or source')
      }
    }
  })()`)
  await click('play')

  const runs = []
  for (const divisors of [[1, 2, 4], [4, 1, 2], [2, 4, 1]]) {
    for (const divisor of divisors) {
      const run = await exec('(' + sampleQuality.toString() + ')(' + divisor + ')')
      assert.equal(run.width, Math.round(media.width / divisor))
      assert.equal(run.height, Math.round(media.height / divisor))
      assert.equal(run.showCanvas, divisor !== 1)
      assert(run.pictureUnchanged, 'Video and overlay bounds changed')
      assert(run.intervals.length > 0, 'No frames were sampled')
      runs.push(run)
    }
  }

  const activeTrack = await exec('document.querySelector(".track-heading.active .track-name")?.title')
  assert.equal(activeTrack, 'styles.ass', 'Preview tests must keep the imported ASS track active')
  const after = await exportAss('after.ass')
  assert.deepEqual(after, before, 'Changing preview quality altered subtitle exports')
  const summary = [1, 2, 4].map(divisor => {
    const group = runs.filter(run => run.divisor === divisor)
    return {
      divisor,
      output: group[0].width + '×' + group[0].height,
      frames: group.reduce((sum, run) => sum + run.totalFrames, 0),
      dropped: group.reduce((sum, run) => sum + run.droppedFrames, 0),
      frameIntervalP95Ms: p95(group.flatMap(run => run.intervals)),
      decodePipelineP95Ms: p95(group.flatMap(run => run.durations)),
      canvasDrawCallP95Ms: p95(group.flatMap(run => run.draws)),
    }
  })
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, electron: process.versions.electron, media, summary }, null, 2))
}
