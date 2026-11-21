import { renderAss } from '../core/ass.mjs'

function fontKey(name = '') {
  return name.trim().replace(/^@/, '').normalize('NFC').toLowerCase()
}

function requestedFonts(content) {
  const names = new Set()
  for (const [, name] of content.matchAll(/^Style: [^,]*,([^,]*)/gm)) names.add(fontKey(name))
  for (const [, block] of content.matchAll(/(?<!\\)\{([^{}]*)\}/g)) {
    for (const [, name] of block.matchAll(/\\fn([^\\)}]+)/gi)) names.add(fontKey(name))
  }
  names.delete('')
  return [...names].sort()
}

export function createAssPreview(host, reportFailure, redraw) {
  const layers = new Map()
  const faceData = new WeakMap()
  let localFonts

  async function loadFonts(names) {
    localFonts ??= window.queryLocalFonts?.().catch(() => []) ?? Promise.resolve([])
    const requested = new Set(names)
    const matches = (await localFonts).filter(face =>
      [face.family, face.fullName, face.postscriptName].some(name => requested.has(fontKey(name))))
    const blobs = await Promise.all(matches.map(face => {
      if (!faceData.has(face)) faceData.set(face, face.blob().catch(() => null))
      return faceData.get(face)
    }))
    return blobs.filter(Boolean)
  }

  function releaseUrls(layer) {
    for (const url of layer.fontUrls) URL.revokeObjectURL(url)
    layer.fontUrls = []
  }

  function disposePlayer(layer) {
    layer.player?.dispose()
    layer.player = undefined
    releaseUrls(layer)
  }

  async function syncFonts(layer, names) {
    const key = names.join('\n')
    if (key === layer.fontKey) return
    layer.fontKey = key
    const revision = Symbol()
    layer.fontRevision = revision
    const fonts = await loadFonts(names)
    if (layers.get(layer.track.id) !== layer || layer.fontRevision !== revision) return
    if (layer.player && layer.fonts.length === fonts.length && fonts.every((font, index) => layer.fonts[index] === font)) return
    disposePlayer(layer)
    const { canvas, content } = layer
    delete canvas.dataset.ready
    canvas.hidden = false
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
    layer.fonts = fonts
    layer.fontUrls = fonts.map(blob => URL.createObjectURL(blob))
    layer.previewContent = content
    layer.width = layer.height = layer.time = undefined
    try {
      const player = new window.SubtitlesOctopus({
        canvas,
        subContent: content,
        workerUrl: '/libass/subtitles-octopus-worker.js',
        fonts: layer.fontUrls,
        fallbackFont: '/assets/NotoSansSC.ttf',
        libassMemoryLimit: 96,
        libassGlyphLimit: 24,
        onError: () => {
          if (layer.player !== player) return
          // Octopus disposes its worker after calling onError.
          layer.player = undefined
          releaseUrls(layer)
          canvas.dataset.ready = 'false'
          canvas.hidden = true
          reportFailure('ASS 渲染器未能启动，已改用基础文本预览。')
          redraw()
        },
      })
      layer.player = player
      // Octopus reports ready before font preloads finish. Reading the parsed
      // styles uses the worker's runtime queue and also works while paused.
      const { worker } = player
      function stylesReady(event) {
        if (event.data.target !== 'get-styles') return
        worker.removeEventListener('message', stylesReady)
        if (layer.player !== player) return
        canvas.dataset.ready = 'true'
        redraw()
      }
      worker.addEventListener('message', stylesReady)
      worker.postMessage({ target: 'get-styles' })
    } catch (error) {
      releaseUrls(layer)
      reportFailure('无法初始化 ASS 渲染器。' + error.message)
    }
  }

  function sync(scripts) {
    for (const [id, layer] of layers) {
      if (scripts.some(({ track }) => track.id === id)) continue
      disposePlayer(layer)
      layer.canvas.remove()
      layers.delete(id)
    }
    for (const [index, { track, styles, fade }] of scripts.entries()) {
      const content = renderAss(track, styles, undefined, fade)
      let layer = layers.get(track.id)
      if (!layer) {
        const canvas = document.createElement('canvas')
        canvas.className = track.ass ? 'ass-layer' : 'ass-layer generated-layer'
        canvas.dataset.layer = track.id
        host.append(canvas)
        layer = { canvas, fontUrls: [], fonts: [] }
        layers.set(track.id, layer)
      }
      Object.assign(layer, { track, styles, fade, content })
      layer.canvas.style.zIndex = String(index)
      void syncFonts(layer, requestedFonts(content))
    }
  }

  function draw(milliseconds, drag) {
    const w = Math.round(host.clientWidth * devicePixelRatio)
    const h = Math.round(host.clientHeight * devicePixelRatio)
    if (!w || !h) return
    for (const layer of layers.values()) {
      if (layer.canvas.dataset.ready !== 'true') continue
      const changed = drag?.delta && layer.track.cues.some(cue => drag.ids.has(cue.id))
      const content = changed
        ? renderAss(layer.track, layer.styles, drag, layer.fade)
        : layer.content
      if (content !== layer.previewContent) {
        // A new libass track with no active images may not send a clearing frame.
        layer.canvas.getContext('2d').clearRect(0, 0, layer.canvas.width, layer.canvas.height)
        layer.player.setTrack(content)
        layer.previewContent = content
        layer.time = undefined
      }
      if (w !== layer.width || h !== layer.height) {
        layer.player.resize(w, h)
        layer.width = w
        layer.height = h
        layer.time = undefined
      }
      if (layer.time !== milliseconds) {
        layer.player.setCurrentTime(milliseconds / 1000)
        layer.time = milliseconds
      }
    }
  }

  return { sync, draw, ready: id => layers.get(id)?.canvas.dataset.ready === 'true' }
}
