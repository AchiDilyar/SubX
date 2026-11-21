import { renderAss, plainAssCues, watermarkLayer } from '../core/ass.mjs'
import { printTime } from '../core/srt.mjs'

export function assLayers(tracks, styles, settings, duration, draft, selectedTracks) {
  const layers = []
  const plain = []
  let plainOrder = -1
  for (const [index, original] of tracks.entries()) {
    if (selectedTracks ? !selectedTracks.has(original.id) : !original.visible) continue
    const order = tracks.length - 1 - index
    const track = {
      ...original,
      layer: original.ass?.indexed ? order : undefined,
      cues: original.cues.map(cue => cue.id === draft?.id ? { ...cue, text: draft.text } : cue),
    }
    if (track.ass && track.cues.length) layers.push({ track, styles, fade: settings?.fade, order })
    if (!track.ass && track.cues.length) {
      plain.push(...track.cues)
      plainOrder = Math.max(plainOrder, order)
    }
  }
  if (plain.length) {
    layers.push({ track: { id: 'plain-subtitles', cues: plainAssCues(plain, styles) }, styles, fade: settings?.fade, order: plainOrder })
  }
  layers.sort((left, right) => left.order - right.order)
  if (settings?.watermark && duration > 0) {
    const { track, style } = watermarkLayer(duration)
    layers.push({ track, styles: [style] })
  }
  return layers
}

export function compositionLayers(tracks, styles, settings, duration = 0, selected) {
  const nonempty = tracks.map(track => ({ ...track, cues: track.cues.filter(cue => cue.text.trim()) }))
  return assLayers(nonempty, styles, settings, duration, undefined, selected)
    .map(({ track, styles, fade }) => renderAss(track, styles, undefined, fade))
}

export function bindComposition({ project, currentTrack, hasDraft, report, media }) {
  const get = id => document.getElementById(id)
  const api = window.subx
  const dialog = get('composition-dialog')
  const form = get('composition-form')
  const start = get('composition-start')
  const cancel = get('composition-cancel')
  const message = get('composition-message')
  const progress = get('composition-progress')
  const scope = form.elements.scope
  let running = false

  function candidateTracks() {
    const active = scope.value === 'active'
    return project().tracks.filter(track => active ? currentTrack() === track : track.visible)
  }

  // 锁定轨道不参与合成输出。
  function selectedTracks() {
    return candidateTracks().filter(track => !track.locked)
  }

  function update() {
    const tracks = selectedTracks()
    const skipped = candidateTracks().length - tracks.length
    const count = tracks.reduce((sum, track) => sum + track.cues.filter(cue => cue.text.trim()).length, 0)
    get('composition-cues').textContent = tracks.length + ' 条轨道 · ' + count + ' 条非空字幕' +
      (skipped ? ' · 跳过 ' + skipped + ' 条锁定轨道' : '')
    const info = media()
    const ready = info.ready
    get('composition-source').textContent = ready ? info.name : '请先打开视频'
    get('composition-info').textContent = ready ? info.width + ' × ' + info.height + ' · ' + printTime(Math.round(info.duration * 1000), '.') : ''
    if (!running) {
      const hasOutput = count || project().settings?.watermark
      message.textContent = hasDraft() ? '请先应用或取消编辑区的草稿。' : !hasOutput ? '所选范围内还没有字幕正文。' : ''
      start.disabled = !ready || !hasOutput || hasDraft()
    }
  }

  get('compose-video').addEventListener('click', () => {
    media().pause()
    update()
    dialog.showModal()
  })
  scope.addEventListener('change', update)
  get('video').addEventListener('loadeddata', () => { if (dialog.open) update() })
  get('video').addEventListener('error', () => { if (dialog.open) update() })
  cancel.addEventListener('click', async () => {
    if (!running) return dialog.close()
    cancel.disabled = true
    message.textContent = '正在取消合成…'
    try { await api.cancelCompose() } catch (error) { message.textContent = error.message }
  })
  dialog.addEventListener('cancel', event => { if (running) event.preventDefault() })
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (running || start.disabled) return
    const info = media()
    const options = Object.fromEntries(new FormData(form))
    delete options.scope
    options.crf = Number(options.crf)
    if (info.solid) options.solid = info.solid
    options.layers = compositionLayers(project().tracks, project().styles, project().settings,
      Math.ceil(info.duration * 100) * 10, new Set(selectedTracks().map(track => track.id)))
    running = true
    form.querySelector('fieldset').disabled = true
    start.disabled = true
    cancel.textContent = '取消合成'
    progress.hidden = false
    progress.removeAttribute('value')
    message.textContent = '正在准备输出文件…'
    const unsubscribe = api.onComposeProgress(seconds => {
      progress.value = Math.min(0.99, seconds / info.duration)
      message.textContent = '正在编码 · ' + Math.floor(progress.value * 100) + '%'
    })
    try {
      if (await api.composeVideo(options)) {
        dialog.close()
        report('合成完成，MP4 视频已保存。')
      } else {
        message.textContent = '已取消合成。'
      }
    } catch (error) {
      message.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    } finally {
      unsubscribe()
      running = false
      form.querySelector('fieldset').disabled = false
      start.disabled = false
      cancel.disabled = false
      cancel.textContent = '关闭'
      progress.hidden = true
    }
  })
}
