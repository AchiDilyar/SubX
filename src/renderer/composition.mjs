import { renderAss, plainAssCues } from '../core/ass.mjs'
import { printTime } from '../core/srt.mjs'

// 项目设置里的淡入淡出：开关打开时返回统一时长（毫秒），否则 false。
export function fadeOf(settings) {
  if (!settings?.fade) return false
  const value = Number(settings.fadeDuration ?? 100)
  return Number.isFinite(value) ? Math.max(0, Math.min(2000, Math.round(value))) : 100
}

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
    if (track.ass && track.cues.length) layers.push({ track, styles, fade: fadeOf(settings), order })
    if (!track.ass && track.cues.length) {
      plain.push(...track.cues)
      plainOrder = Math.max(plainOrder, order)
    }
  }
  if (plain.length) {
    layers.push({ track: { id: 'plain-subtitles', cues: plainAssCues(plain, styles) }, styles, fade: fadeOf(settings), order: plainOrder })
  }
  layers.sort((left, right) => left.order - right.order)
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
  let probeInfo = null
  let probeToken = null
  let probePending = false
  const bitrateRange = get('composition-bitrate-range')
  const bitrateNumber = get('composition-bitrate')
  function syncBitrate(value, source) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    const clamped = Math.max(1, Math.min(100, Math.round(parsed * 2) / 2))
    if (source !== 'range') bitrateRange.value = String(Math.max(1, Math.min(100, Math.round(clamped))))
    if (source !== 'number') bitrateNumber.value = String(clamped)
  }
  bitrateRange.addEventListener('input', () => syncBitrate(bitrateRange.value, 'range'))
  bitrateNumber.addEventListener('input', () => syncBitrate(bitrateNumber.value, 'number'))
  function syncAudioMode() {
    get('composition-audio-bitrate-row').hidden = form.elements.audioMode.value === 'copy'
  }
  form.elements.audioMode.addEventListener('change', syncAudioMode)
  function syncHdrCodec() {
    const preserve = Boolean(probeInfo?.video?.hdr && !get('composition-tonemap').checked)
    const option = form.elements.codec.querySelector('option[value=h264]')
    if (option) option.disabled = preserve
    if (preserve) form.elements.codec.value = 'hevc'
  }
  get('composition-tonemap').addEventListener('change', syncHdrCodec)
  function renderProbe(meta, pending) {
    const list = get('composition-meta')
    list.replaceChildren()
    if (!meta) {
      get('composition-hdr').hidden = true
      get('composition-container').textContent = '源容器'
      get('composition-audio-info').textContent = ''
      syncHdrCodec()
      if (pending) {
        const dt = document.createElement('dt')
        const dd = document.createElement('dd')
        dt.textContent = '源信息'
        dd.textContent = '正在读取…'
        list.append(dt, dd)
      }
      return
    }
    const video = meta.video ?? {}
    const audio = meta.audio ?? {}
    const color = [video.colorSpace, video.colorTransfer, video.colorPrimaries].filter(Boolean).join(' / ') || '未标记'
    const hdr = video.hdr
    const rows = [
      ['容器', meta.container ? meta.container.toUpperCase() : '未知'],
      ['视频', [video.codec?.toUpperCase(), video.width && video.height ? video.width + ' × ' + video.height : '', video.fps ? video.fps + ' fps' : ''].filter(Boolean).join(' · ') || '未知'],
      ['色彩', color],
      ['HDR', hdr ? video.hdrKind : 'SDR'],
      ['音轨', audio.codec ? audio.label + (audio.layout ? ' · ' + audio.layout : audio.channels ? ' · ' + audio.channels + ' 声道' : '') + (audio.atmos ? ' · Dolby Atmos' : '') : '无音轨'],
    ]
    for (const [label, value] of rows) {
      const dt = document.createElement('dt')
      const dd = document.createElement('dd')
      dt.textContent = label
      dd.textContent = value
      list.append(dt, dd)
    }
    get('composition-container').textContent = meta.container ? meta.container.toUpperCase() : '源容器'
    get('composition-hdr').hidden = !hdr
    get('composition-hdr-info').textContent = hdr
      ? '源视频为 ' + video.hdrKind + '，色彩标记 ' + color + '。保留 HDR 时会输出 10-bit；勾选转 SDR 后使用 BT.709。'
      : ''
    if (!hdr) get('composition-tonemap').checked = false
    syncHdrCodec()
    get('composition-audio-info').textContent = audio.codec
      ? '源音轨：' + audio.label + (audio.layout ? ' · ' + audio.layout : audio.channels ? ' · ' + audio.channels + ' 声道' : '') + (audio.atmos ? ' · Dolby Atmos' : '')
      : '源视频没有音轨。'
    syncAudioMode()
  }

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
    const activeProbe = info.token ? probeInfo : null
    const width = activeProbe?.video?.width || info.width
    const height = activeProbe?.video?.height || info.height
    get('composition-info').textContent = ready ? width + ' × ' + height + ' · ' + printTime(Math.round(info.duration * 1000), '.') : ''
    const token = ready ? info.token : null
    if (!token) {
      probeToken = null
      probeInfo = null
      probePending = false
    } else if (token !== probeToken) {
      probeToken = token
      probeInfo = null
      probePending = true
      if (token) {
        api.probeMedia(token).then(meta => {
          if (probeToken !== token) return
          probeInfo = meta
          probePending = false
          if (dialog.open) update()
        }).catch(() => {
          if (probeToken !== token) return
          probePending = false
          if (dialog.open) update()
        })
      }
    }
    renderProbe(activeProbe, probePending)
    if (!running) {
      const hasOutput = count || (project().settings?.watermark && project().settings?.watermarkImage?.path)
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
    options.bitrate = Number(options.bitrate)
    options.tonemap = Boolean(options.tonemap)
    if (info.solid) options.solid = info.solid
    options.layers = compositionLayers(project().tracks, project().styles, project().settings,
      Math.ceil(info.duration * 100) * 10, new Set(selectedTracks().map(track => track.id)))
    const watermark = project().settings?.watermark ? project().settings.watermarkImage : null
    if (watermark?.path) {
      options.watermark = {
        path: watermark.path,
        scale: watermark.scale,
        x: watermark.x,
        y: watermark.y,
        opacity: watermark.opacity,
      }
    }
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
        report('合成完成，视频已保存。')
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
