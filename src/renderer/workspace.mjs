import { createProject, createSolidMedia, createTrack, addTopTrack, isSolidMedia, trackIndex, cueTiming, findCue, inspectTrackSplit, linkedIds, moveDelta, normalizeStyleNames, removeCue, shiftTiming, splitTrack, trimDelta, clampShiftDelta } from '../core/project.mjs'
import { alignCue, frameBoundaries, nearestBoundary } from '../core/frame-grid.mjs'
import { inspectSrt, printTime, readTime, writeSrt } from '../core/srt.mjs'
import { assStyleResetCues, assTextCues, captureCue, pasteCue, groupAssLayers, importAssLayers, moveCuesToTrack, fallbackAssStyle, field, newStyle, readAss, renameAssStyleReset, setField, writeAss } from '../core/ass.mjs'
import { findMergePartner, mergedExportText, mergeTracks } from '../core/merge.mjs'
import { analyzeProject, extendShortCues, fixTrailingSpaces, qcSettings, splitLongCues } from '../core/qc.mjs'
import { findTextMatches, replaceTextAt, replaceTextMatches } from '../core/text.mjs'

import { assLayers, bindComposition, fadeOf } from './composition.mjs'
import { createAssPreview } from './ass-preview.mjs'

const $ = id => document.getElementById(id)
const video = $('video')
const scroll = $('timeline-scroll')
const zoomBar = $('timeline-zoom')
const zoomThumb = $('zoom-thumb')
const zoomPlayhead = $('zoom-playhead')
const canvas = $('preview-canvas')
const frame = $('frame')
const stage = $('monitor-stage')
const monitor = document.querySelector('.monitor')
const playheadMargin = 8
const timelineTail = 2000
const frameTickSpacing = 12
// 缩放条滑块的最小视觉宽度；低于这个宽度时两个圆形把柄会挤在一起。
const ZOOM_THUMB_MIN = 24
const app = window.subx
document.documentElement.classList.toggle('inset-window-controls', app.hasInsetWindowControls)
const emptyDuration = 10000
function newWorkspaceProject() {
  const next = createProject()
  next.tracks = ['S1', 'S0'].map(name => ({ ...createTrack(name), starter: true }))
  next.styles = [{ ...newStyle('默认样式'), isProjectDefault: true }]
  return next
}

let project = newWorkspaceProject()
let currentTrack
let selected
let selectedCues = new Set()
let toolMode = 'select'
let waveformMode = 'symmetric'
let clipboard
let selectedStyle
let linkStart
let linkMode = false
let snapping = true
// 拖动播放头时命中的字幕块边缘，用于显示吸附参考线。
let playheadSnapTime
let time = 0
let presentedFrameTime = null
let frameRequest
let frameGeneration = 0
let pixelsPerSecond = Number($('zoom').value)
let drag
let dragFrame = 0
let rows = []
let reviewCues = []
let mediaDuration = 0
// none：没有媒体；missing：工程引用的视频找不到；error：视频无法解码。
let mediaState = 'none'
let frameTimes
let frameGap = Infinity
let rulerFrame
let fitZoom = false
let waveform
let waveformMedia
let solidMedia = null
let solidPlaying = false
let solidTimer = 0
let solidStartedAt = 0
let solidStartTime = 0
let scriptIndex = 0
let punch = null
let projectDocument = null
let projectDisplayName = ''
let projectBusy = false
let switchingProject = false
let projectSavePending = false
let watermarkCache = { path: '', url: '', tried: false }
let revision = Symbol()
let savedVersion = { revision, media: project.media }
const dirty = () => revision !== savedVersion.revision || project.media !== savedVersion.media
const cueDrafts = new Map()
const styleDrafts = new Map()
const inspectorForms = new WeakMap()
const hasPendingForm = () => cueDrafts.size > 0 || styleDrafts.size > 0
const undo = []
const redo = []
const UNDO_LIMIT = 70
const UNDO_BYTES = 48 * 1024 * 1024
let undoBytes = 0
let redoBytes = 0
function projectBytes(value) {
  try { return JSON.stringify(value).length * 2 } catch { return 0 }
}
function trimHistory(stack) {
  // 至少保留最近一步；单个超大快照也不至于让本次编辑完全不可撤销。
  while (stack.length > 1 && (stack.length > UNDO_LIMIT || (stack === undo ? undoBytes : redoBytes) > UNDO_BYTES)) {
    const removed = stack.shift()
    if (stack === undo) undoBytes -= removed.bytes ?? 0
    else redoBytes -= removed.bytes ?? 0
  }
}
let autosaveTimer = 0
let autosaveWrite = null
let autosaveQueued = false
let autosaveErrorShown = false
let pendingEditorDraft = null
const width = timeMs => timeMs * pixelsPerSecond / 1000
const deltaFor = px => Math.round(px * 1000 / pixelsPerSecond)
// 标尺刻度按帧率取档：帧、秒、分逐级放大；标签在有帧率时显示「时:分:秒.帧」。
function rulerFps() {
  if (solidMedia) return solidMedia.fps
  if (frameTimes?.length && Number.isFinite(frameGap) && frameGap > 0) {
    const fps = Math.round(1000 / frameGap)
    if (fps >= 1 && fps <= 240) return fps
  }
  // 空白工程没有媒体，用 30 fps 作为默认时间基准。
  if (!project.media) return 30
  return null
}
function rulerSteps() {
  const fps = rulerFps()
  const candidates = []
  if (fps) {
    const frame = 1000 / fps
    for (const frames of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 60]) candidates.push(frames * frame)
    for (const seconds of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]) candidates.push(seconds * 1000)
  } else {
    for (const step of [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000, 900000]) candidates.push(step)
  }
  candidates.sort((left, right) => left - right)
  const major = candidates.find(step => width(step) >= 95) ?? 3600000
  const frame = fps ? 1000 / fps : 0
  const majorFrames = fps ? Math.round(major / frame) : 0
  const minor = fps
    ? (majorFrames <= 10 ? frame : (width(major / 5) >= 6 ? major / 5 : major))
    : (width(major / 5) >= 6 ? major / 5 : major)
  return { fps, major, minor, frameTicks: Boolean(fps) && majorFrames <= 10 }
}
function rulerMinor() {
  return rulerSteps().minor
}
// 返回最后一条 start <= time 的下标；数组按 start 升序。
function lastCueStartingAt(ordered, time) {
  let low = 0
  let high = ordered.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (ordered[mid].start <= time) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  return found
}

// 预览时间码：有帧率时显示「时:分:秒.帧」，没有帧率时退回毫秒。
function printTimecode(milliseconds) {
  const fps = rulerFps()
  return fps ? rulerLabel(Math.max(0, milliseconds), fps, 1000) : printTime(Math.max(0, milliseconds), '.')
}
function rulerLabel(milliseconds, fps, major) {
  if (!fps) {
    const text = printTime(Math.round(milliseconds), '.')
    return text.slice(0, major < 1000 ? 12 : 8)
  }
  const perSecond = Math.max(1, Math.round(fps))
  const frames = Math.max(0, Math.round(milliseconds / (1000 / fps)))
  const totalSeconds = Math.floor(frames / perSecond)
  const pad = value => String(value).padStart(2, '0')
  return pad(Math.floor(totalSeconds / 3600)) + ':' + pad(Math.floor(totalSeconds / 60) % 60) + ':' +
    pad(totalSeconds % 60) + '.' + pad(frames % perSecond)
}
// 字幕块视觉高度等于轨道行高（CSS 的 .cue 高度与此保持一致）。
const CUE_HEIGHT = 32
const CUE_LANE_GAP = 0
const CUE_LANE_PADDING = 0
// 字幕块的内边距加边框约 20px；低于这个宽度时按真实时长画紧凑块，否则块会撑到 20px 并盖住右边的块。
const DENSE_CUE_WIDTH = 20
const trackFor = id => project.tracks.find(track => track.cues.some(cue => cue.id === id))
const track = () => project.tracks.find(track => track.id === currentTrack)
const trackLabel = track => 'S' + trackIndex(project.tracks, track)
const styleFor = id => project.styles.find(style => style.id === id)
const bindingGroupOf = id => (project.bindings ?? []).find(group => group.includes(id))
function expandBindings(ids) {
  const result = new Set(ids)
  for (const id of ids) for (const member of bindingGroupOf(id) ?? []) result.add(member)
  return result
}
const styleName = style => field(style.fields, 'Name').trim()

// 状态栏按语义着色：成功（已…）、警告（重叠/请先…）、错误（异常与失败）分开表达。
function status(message, tone) {
  const node = $('status')
  const text = String(message ?? '')
  // 警告词优先于“已…”的成功推断，避免“已保存，但仍有未保存修改”被误判为成功。
  const level = tone ?? (/(重叠|请先|注意|尚未|未保存|不可用|无法播放)/.test(text) ? 'warn'
    : /^已/.test(text) ? 'success' : 'info')
  node.textContent = text
  node.dataset.tone = level
}
// 主进程抛出的错误会带 Electron 的 IPC 前缀，展示前统一去掉。
function errorText(error) {
  return String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

function element(tag, className, value) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (value !== undefined) node.textContent = value
  return node
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(svg.namespaceURI, 'use')
  use.setAttribute('href', '#i-' + name)
  svg.append(use)
  return svg
}

const headingAddTrack = element('button', 'heading-add-track')
headingAddTrack.id = 'add-track'
headingAddTrack.type = 'button'
headingAddTrack.title = '添加轨道'
headingAddTrack.setAttribute('aria-label', '添加轨道')
headingAddTrack.append(icon('track'))
document.querySelector('.tool-stash').append(headingAddTrack)

const headingResizer = element('div', 'heading-resizer')
headingResizer.id = 'heading-resizer'
headingResizer.tabIndex = 0
headingResizer.setAttribute('role', 'separator')
headingResizer.setAttribute('aria-orientation', 'vertical')
headingResizer.setAttribute('aria-label', '调整轨道信息栏宽度')
headingResizer.title = '拖动调整轨道信息栏宽度'

function applyHeadingWidth(pixels) {
  const value = Math.max(96, Math.min(280, Math.round(pixels)))
  document.documentElement.style.setProperty('--heading-width', value + 'px')
  try { localStorage.setItem('subx.headingWidth', String(value)) } catch {}
  renderViewport()
}

try {
  const savedHeadingWidth = Number(localStorage.getItem('subx.headingWidth'))
  if (Number.isFinite(savedHeadingWidth) && savedHeadingWidth >= 96 && savedHeadingWidth <= 280) {
    document.documentElement.style.setProperty('--heading-width', savedHeadingWidth + 'px')
  }
} catch {}

headingResizer.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  headingResizer.setPointerCapture(event.pointerId)
})
headingResizer.addEventListener('pointermove', event => {
  if (!headingResizer.hasPointerCapture(event.pointerId)) return
  applyHeadingWidth(event.clientX - $('track-headings').getBoundingClientRect().left)
})
headingResizer.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const current = $('track-headings').offsetWidth
  applyHeadingWidth(current + (event.key === 'ArrowRight' ? 8 : -8))
})
headingResizer.addEventListener('click', event => event.stopPropagation())

function action(id, callback) {
  $(id).addEventListener('click', async () => {
    try {
      await callback()
    } catch (error) {
      status(errorText(error), 'error')
    }
  })
}

// Use an in-app tooltip for icon-only controls, including disabled buttons.
const iconTooltip = element('div', 'icon-tooltip')
iconTooltip.setAttribute('role', 'tooltip')
iconTooltip.hidden = true
document.body.append(iconTooltip)
let tooltipTarget
let tooltipTimer
function hideIconTooltip() {
  clearTimeout(tooltipTimer)
  tooltipTarget = undefined
  iconTooltip.hidden = true
}
document.addEventListener('pointermove', event => {
  const button = event.target.closest?.('button')
  if (button === tooltipTarget) return
  hideIconTooltip()
  if (!button?.querySelector('svg') || button.textContent.trim()) return
  const label = button.getAttribute('title') || button.dataset.tooltip || button.getAttribute('aria-label')
  if (!label) return
  button.dataset.tooltip = label
  button.removeAttribute('title')
  tooltipTarget = button
  tooltipTimer = setTimeout(() => {
    if (!button.isConnected || tooltipTarget !== button) return
    iconTooltip.textContent = button.getAttribute('title') || button.dataset.tooltip
    ;(button.closest('dialog[open]') || document.body).append(iconTooltip)
    iconTooltip.hidden = false
    const box = button.getBoundingClientRect()
    const tip = iconTooltip.getBoundingClientRect()
    iconTooltip.style.left = Math.max(4, Math.min(innerWidth - tip.width - 4, box.left + (box.width - tip.width) / 2)) + 'px'
    iconTooltip.style.top = (box.bottom + tip.height + 6 <= innerHeight ? box.bottom + 6 : Math.max(4, box.top - tip.height - 6)) + 'px'
  }, 450)
}, true)
document.addEventListener('pointerdown', hideIconTooltip, true)
document.addEventListener('scroll', hideIconTooltip, true)
window.addEventListener('blur', hideIconTooltip)

const menuTriggers = [...document.querySelectorAll('.menu-trigger')]
const menuPopups = new Map(menuTriggers.map(trigger => [trigger, $(trigger.getAttribute('aria-controls'))]))
let openMenuTrigger

function menuItems(trigger) {
  return [...menuPopups.get(trigger).querySelectorAll('button:not(:disabled)')]
}

function closeMenus(focus = false) {
  if (!openMenuTrigger) return
  const trigger = openMenuTrigger
  menuPopups.get(trigger).hidden = true
  trigger.setAttribute('aria-expanded', 'false')
  openMenuTrigger = undefined
  if (focus) trigger.focus({ preventScroll: true })
}

function openMenus(trigger, index = 0) {
  if (openMenuTrigger && openMenuTrigger !== trigger) closeMenus()
  syncMenuState()
  openMenuTrigger = trigger
  menuPopups.get(trigger).hidden = false
  trigger.setAttribute('aria-expanded', 'true')
  const items = menuItems(trigger)
  items[Math.min(index, items.length - 1)]?.focus({ preventScroll: true })
}

function syncMenuState() {
  $('menu-open-media').disabled = $('open-media').disabled
  $('menu-undo').disabled = !undo.length
  $('menu-redo').disabled = !redo.length
}

// The native menu uses the same commands and state as the in-window menu.
if (app.hasInsetWindowControls) {
  let previousMenu = ''
  const updateNativeMenu = () => {
    syncMenuState()
    const blocked = switchingProject || Boolean(document.querySelector('dialog[open]'))
    const groups = menuTriggers.map(trigger => ({
      label: trigger.textContent.trim(),
      items: [...menuPopups.get(trigger).children].map(node => {
        if (node.tagName === 'HR') return { separator: true }
        const checked = node.getAttribute('aria-checked')
        return { id: node.id, label: node.querySelector('span')?.textContent || node.textContent.trim(),
          enabled: !blocked && !node.disabled, accelerator: node.querySelector('kbd')?.textContent.trim(),
          ...(checked === null ? {} : { checked: checked === 'true' }) }
      }),
    }))
    const snapshot = JSON.stringify(groups)
    if (snapshot !== previousMenu) { previousMenu = snapshot; app.updateMenu(groups) }
  }
  app.onMenuCommand(id => {
    if (switchingProject || document.querySelector('dialog[open]')) return
    syncMenuState()
    const button = document.getElementById(id)
    if (button && button.closest('.menu-popup') && !button.disabled) button.click()
  })
  setInterval(updateNativeMenu, 500)
  updateNativeMenu()
}

for (const [index, trigger] of menuTriggers.entries()) {
  const popup = menuPopups.get(trigger)
  const openAt = offset => {
    openMenus(trigger, offset)
  }
  const step = event => menuTriggers[(index + (event.key === 'ArrowRight' ? 1 : menuTriggers.length - 1)) % menuTriggers.length]
  trigger.addEventListener('click', () => openMenuTrigger === trigger ? closeMenus() : openAt(0))
  trigger.addEventListener('pointerenter', () => {
    if (openMenuTrigger && openMenuTrigger !== trigger) openAt(0)
  })
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openAt(0)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const next = step(event)
      if (openMenuTrigger) openMenus(next)
      else next.focus({ preventScroll: true })
    }
  })
  popup.addEventListener('keydown', event => {
    const items = menuItems(trigger)
    const current = items.indexOf(document.activeElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenus(true)
    } else if (event.key === 'Tab') {
      closeMenus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const offset = event.key === 'ArrowDown' ? 1 : -1
      items[(current + offset + items.length) % items.length]?.focus({ preventScroll: true })
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      ;(event.key === 'Home' ? items[0] : items[items.length - 1])?.focus({ preventScroll: true })
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      openMenus(step(event))
    }
  })
  popup.addEventListener('click', event => {
    if (event.target.closest('button')) closeMenus()
  })
}

document.addEventListener('pointerdown', event => {
  if (openMenuTrigger && !event.target.closest('.menu')) closeMenus()
}, true)
window.addEventListener('blur', () => closeMenus())

action('menu-open-media', () => $('open-media').click())
action('menu-undo', () => $('undo').click())
action('menu-redo', () => $('redo').click())
action('menu-quit', () => app.quit())
action('menu-shortcuts', () => $('shortcuts-dialog').showModal())
action('menu-homepage', () => app.openExternal('https://github.com/AchiDilyar/SubX'))

function edit(change) {
  const before = { project: structuredClone(project), revision }
  before.bytes = projectBytes(before.project)
  change()
  undo.push(before)
  undoBytes += before.bytes
  trimHistory(undo)
  redo.length = 0
  redoBytes = 0
  revision = Symbol()
  render()
  scheduleAutosave()
}

function restore(source, destination) {
  endDrag(drag?.pointer, false)
  if (!source.length) return
  const media = project.media
  const entry = source.pop()
  if (source === undo) undoBytes -= entry.bytes ?? 0
  else redoBytes -= entry.bytes ?? 0
  const snapshot = { project, revision, bytes: projectBytes(project) }
  destination.push(snapshot)
  if (destination === undo) undoBytes += snapshot.bytes
  else redoBytes += snapshot.bytes
  trimHistory(destination)
  project = entry.project
  revision = entry.revision
  // Video selection is independent of subtitle undo and redo.
  project.media = media
  ensureSelection()
  render()
  // 撤销/重做会整体替换工程对象，旧查找结果必须按新工程重新解析。
  if (!findPanel.hidden) runFind({ reset: false })
  scheduleAutosave()
}

function ensureSelection() {
  const owner = trackFor(selected)
  if (owner) currentTrack = owner.id
  else selected = undefined
  if (!track()) currentTrack = project.tracks[0]?.id
  for (const id of selectedCues) if (!findCue(project, id)) selectedCues.delete(id)
  if (!styleFor(selectedStyle)) selectedStyle = undefined
  for (const id of cueDrafts.keys()) if (!findCue(project, id)) cueDrafts.delete(id)
  for (const id of styleDrafts.keys()) if (!styleFor(id)) styleDrafts.delete(id)
  linkStart = undefined
}

function reset(next, media, documentHandle = null) {
  clearTimeout(autosaveTimer)
  autosaveTimer = 0
  pendingEditorDraft = null
  projectDisplayName = ''
  projectDocument = documentHandle
  cueDrafts.clear()
  styleDrafts.clear()
  project = { styles: [], bindings: [], ...next }
  normalizeStyleNames(project)
  punch = null
  scriptIndex = project.script ? nextScriptIndex(0) : 0
  selected = undefined
  selectedCues.clear()
  currentTrack = undefined
  selectedStyle = undefined
  revision = Symbol()
  savedVersion = { revision, media: project.media }
  undo.length = 0
  redo.length = 0
  undoBytes = 0
  redoBytes = 0
  ensureSelection()
  $('cue-tab').hidden = true
  closeFindPanel()
  switchTab('styles', false)
  updateTabPages()
  scroll.scrollTop = scroll.scrollLeft = 0
  attachVideo(media)
  render()
}

function openResult(result) {
  if (!result) return
  reset(result.project, result.media, result.document)
  status(typeof result.project.media === 'string' && !result.media ? '原视频不可用，请重新定位视频。' : '已打开工程')
}

function attachVideo(reference) {
  stopSolidClock()
  frameTimes = rulerFrame = undefined
  frameGap = Infinity
  $('ruler').dataset.frameIndex = reference ? 'loading' : 'none'
  $('ruler').title = ''
  waveform = undefined
  delete $('waveform').dataset.hasAudio
  waveformMedia = reference
  if (!reference) void app.cancelWaveform()

  const solid = !reference && isSolidMedia(project.media) ? project.media : null
  solidMedia = solid
  $('solid-frame').hidden = !solid
  if (solid) $('solid-frame').style.backgroundColor = solid.color
  const missingPath = reference || solid ? null : project.media
  const originalName = missingPath?.split(/[\\/]/).pop()
  const label = reference?.name || (solid ? solidLabel(solid) : '')
  $('media-name').textContent = label || originalName || '视频预览'
  $('media-name').title = label || missingPath || ''
  $('empty-video-message').textContent = missingPath ? '原视频不可用' : ''
  $('empty-video-message').hidden = !missingPath
  mediaState = reference ? 'loading' : missingPath ? 'missing' : 'none'
  $('open-media').textContent = missingPath ? '重新定位视频' : '打开视频'
  $('play').disabled = true
  video.pause()
  video.hidden = true
  canvas.hidden = true
  $('empty-video').hidden = Boolean(solid)
  updateEmptyState()
  video.removeAttribute('src')
  if (reference) video.src = reference.url
  if (!solid) video.load()
  time = 0
  presentedFrameTime = null
  mediaDuration = 0
  if (solid) {
    mediaDuration = solid.duration
    frameTimes = solidFrameTimes(solid)
    frameGap = 1000 / solid.fps
    $('ruler').dataset.frameIndex = frameTimes?.length ? 'ready' : 'unavailable'
    $('ruler').title = frameTimes?.length ? '' : '空白视频时长较长，未生成逐帧索引。'
    $('play').disabled = false
    $('empty-video').hidden = true
    fitPicture()
    updatePreview()
    renderViewport()
    return
  }
  observeVideoFrames()
  fitPicture()
  updatePreview()
}

// 空工作区与缺失媒体时的引导：保留居中的品牌字标，操作卡固定在预览底部。
const emptyActionIds = ['empty-open-media', 'empty-import-subtitles', 'empty-blank-video', 'empty-open-project']
function updateEmptyState() {
  const box = $('empty-video')
  if (!box) return
  const loading = mediaState === 'loading'
  $('empty-actions').hidden = loading
  if (loading) return
  const missing = mediaState === 'missing'
  const broken = mediaState === 'error'
  $('empty-actions-title').textContent = broken ? '重新选择视频' : missing ? '重新定位视频' : '开始制作字幕'
  $('empty-actions-hint').textContent = broken
    ? '请重新选择可解码的视频（H.264 / AAC MP4 最稳妥），字幕轨道仍可继续编辑。'
    : missing
      ? '重新定位视频后即可继续预览；字幕轨道仍可编辑，保存工程会记住新位置。'
      : '打开视频，或直接导入 SRT / ASS 字幕；也可以先用空白视频练习打轴。'
  $('empty-open-media').querySelector('span').textContent = broken ? '重新选择视频…' : missing ? '重新定位视频…' : '打开视频…'
  for (const id of emptyActionIds) $(id).hidden = false
  // 与菜单按钮的禁用状态保持一致，项目操作进行中不留下可点但无反应的入口。
  $('empty-open-media').disabled = $('open-media').disabled
  $('empty-import-subtitles').disabled = $('import-subtitles').disabled
  $('empty-blank-video').disabled = $('blank-video').disabled
  $('empty-open-project').disabled = $('open-project').disabled
  $('empty-blank-video').hidden = missing || broken
  $('empty-open-project').hidden = missing || broken
}

action('empty-open-media', () => $('open-media').click())
action('empty-import-subtitles', () => $('import-subtitles').click())
action('empty-blank-video', () => $('blank-video').click())
action('empty-open-project', () => $('open-project').click())
action('empty-import', () => $('import-subtitles').click())

function fitPicture() {
  const ar = isSolid() ? solidMedia.width / solidMedia.height :
    video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9
  const availableWidth = stage.clientWidth
  const boxWidth = Math.min(availableWidth, stage.clientHeight * ar)
  frame.style.width = boxWidth + 'px'
  frame.style.height = boxWidth / ar + 'px'
  applyWatermarkOverlay()
  updatePreview()
}

function applyQuality() {
  if (isSolid()) {
    video.hidden = true
    canvas.hidden = true
    $('solid-frame').hidden = false
    return
  }
  const scale = Number($('quality').value)
  const hasFrame = video.readyState >= 2
  const reduced = scale > 1 && hasFrame
  video.hidden = !hasFrame || reduced
  canvas.hidden = !reduced
  if (reduced) {
    const w = Math.max(1, Math.round(video.videoWidth / scale))
    const h = Math.max(1, Math.round(video.videoHeight / scale))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, w, h)
  }
}

const assPreview = createAssPreview($('ass-overlays'), status, updatePreview)
let previewStyles = project.styles
let readStylePreview
let previewDraftKey = ''
let stylePreviewFrame = 0
let previewCueText
let cuePreviewFrame = 0
let lastCaptionKey = ''
function playheadPosition() {
  if (rulerFrame !== undefined) return rulerFrame
  if (!frameTimes?.length) return time
  return frameTimes[Math.max(0, frameAt(time + .51) - 1)]
}

function updatePlayhead() {
  $('playhead').style.left = width(playheadPosition()) + 'px'
  renderPlayingCue()
  updateZoomPlayhead()
}

function renderPlayingCue() {
  const position = playheadPosition()
  for (const row of rows) {
    for (const block of row.buttons.values()) {
      const start = Number(block.dataset.start)
      const end = Number(block.dataset.end)
      block.classList.toggle('playing', Number.isFinite(start) && position >= start && position < end)
    }
  }
}
function updatePreview() {
  const captionTime = presentedFrameTime ?? time
  assPreview.draw(captionTime, drag)
  $('timecode').value = printTimecode(time)
  const progress = $('preview-progress')
  progress.disabled = !hasPicture() || !mediaDuration
  progress.value = mediaDuration ? String(Math.max(0, Math.min(1000, time * 1000 / mediaDuration))) : '0'
  updatePlayhead()
  updatePunch()
  if (!playbackPaused()) revealTimelinePosition(playheadPosition(), true)
  const captions = []
  for (const row of rows) {
    if (!row.track.visible) continue
    const layerId = row.track.ass ? row.track.id : 'plain-subtitles'
    if (assPreview.ready(layerId) || assPreview.pending(layerId)) continue
    // 播放时每帧都会走到这里：按 start 二分定位，只回看最长一条字幕的跨度，
    // 避免几千条字幕时每帧整表扫描。
    const visible = []
    if (drag) {
      for (const cue of row.ordered) {
        if (cue.start > captionTime + Math.abs(drag.delta)) break
        const { start, end } = cueTiming(cue, drag)
        if (start <= captionTime && end > captionTime) visible.push(cue)
      }
    } else {
      const span = row.maxSpan ?? 0
      for (let index = lastCueStartingAt(row.ordered, captionTime); index >= 0; index--) {
        const cue = row.ordered[index]
        if (cue.start < captionTime - span) break
        if (cue.end > captionTime) visible.push(cue)
      }
      visible.reverse()
    }
    for (const cue of visible) {
      const style = previewStyles.find(style => style.id === cue.style) ??
        (row.track.ass ? fallbackAssStyle(row.track, cue, previewStyles) : previewStyles.find(style => style.isProjectDefault))
      const text = previewCueText?.id === cue.id ? previewCueText.text : cue.text
      if (text) captions.push({ text, style, source: row.track.ass })
    }
  }
  const key = JSON.stringify([frame.clientHeight, captions.map(({ text, style, source }) => [
    text, style?.fields, source?.resolution,
  ])])
  if (key === lastCaptionKey) return
  lastCaptionKey = key
  const aligned = new Map()
  const nodes = captions.map(({ text, style, source }) => {
    const scale = frame.clientHeight / (source?.resolution.height ?? 1080)
    const property = name => style && field(style.fields, name)
    const assText = source ? text.replace(/\{[^}]*\}/g, '').replace(/\\h/g, ' ').replace(/\\n/g, ' ') : text
    const node = element('div', 'caption', assText)
    const alignment = Number(property('Alignment')) || 2
    const column = (alignment - 1) % 3
    const group = Math.floor((alignment - 1) / 3)
    const row = aligned.get(alignment) ?? 0
    aligned.set(alignment, row + 1)
    const size = style ? Math.max(9, (Number(property('Fontsize')) || 42) * scale) : Math.max(12, frame.clientHeight * 0.056)
    node.style.fontSize = size + 'px'
    node.style.textAlign = ['left', 'center', 'right'][column] ?? 'center'
    if (group === 2) node.style.top = 'calc(5% + ' + row * size * 1.24 + 'px)'
    else if (group === 1) node.style.top = 'calc(50% + ' + row * size * 1.24 + 'px)'
    else node.style.bottom = (style ? Math.max(0, Number(property('MarginV')) * scale) : frame.clientHeight * 0.055) + row * size * 1.24 + 'px'
    if (style) {
      node.style.fontFamily = property('Fontname')
      node.style.color = cssAssColor(property('PrimaryColour'))
      node.style.webkitTextStroke = Math.max(0, Number(property('Outline')) || 0) * scale + 'px ' + cssAssColor(property('OutlineColour'))
      const shadow = Math.max(0, Number(property('Shadow')) || 0) * scale
      node.style.textShadow = shadow ? `${shadow}px ${shadow}px ${cssAssColor(property('BackColour'))}` : 'none'
      node.style.paddingLeft = Math.max(0, Number(property('MarginL')) || 0) * scale + 'px'
      node.style.paddingRight = Math.max(0, Number(property('MarginR')) || 0) * scale + 'px'
      node.style.fontWeight = Number(property('Bold')) ? 'bold' : 'normal'
      node.style.fontStyle = Number(property('Italic')) ? 'italic' : 'normal'
    }
    return node
  })
  $('captions').replaceChildren(...nodes)
}

function readAssColor(value = '') {
  const source = value.trim()
  const match = /^(?:&H|0x)([+-]?[0-9a-f]{1,8})&?$/i.exec(source)
  let packed = 0xffffff
  if (match) packed = Number.parseInt(match[1], 16) >>> 0
  else if (/^[+-]?\d{1,10}$/.test(source)) {
    const decimal = Number(source)
    if (decimal >= -0x80000000 && decimal <= 0xffffffff) packed = decimal >>> 0
  }
  const red = packed & 255
  const green = (packed >>> 8) & 255
  const blue = (packed >>> 16) & 255
  const hex = '#' + [red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('')
  return { hex, alpha: packed >>> 24 }
}

function cssAssColor(value) {
  const { hex, alpha } = readAssColor(value)
  return hex + (255 - alpha).toString(16).padStart(2, '0')
}

const isSolid = () => Boolean(solidMedia)
const hasPicture = () => isSolid() || video.readyState >= 2
const playbackPaused = () => isSolid() ? !solidPlaying : video.paused
function pausePlayback() {
  if (isSolid()) pauseSolidClock()
  else video.pause()
  snapPlayhead()
}
async function startPlayback() {
  if (isSolid()) startSolidClock()
  else await video.play()
}
function solidLabel(media) {
  return '空白视频 · ' + media.color.toUpperCase() + ' · ' + media.width + '×' + media.height + ' · ' + media.fps + ' fps · ' + printTime(media.duration, '.')
}
function solidFrameTimes(media) {
  const count = Math.floor(media.duration * media.fps / 1000)
  if (count < 1 || count > 200000) return undefined
  return Array.from({ length: count }, (_, index) => Math.round(index * 1000 / media.fps))
}
// 纯色空白视频没有媒体时钟，用 performance.now 推时间；定时器只负责刷新画面，
// 读取当前时间时再按真实经过时长计算，避免后台窗口节流时时间不前进。
function solidElapsed() {
  if (!solidPlaying) return time
  return Math.min(solidMedia.duration, solidStartTime + performance.now() - solidStartedAt)
}
function stopSolidClock() {
  if (solidTimer) clearInterval(solidTimer)
  solidTimer = 0
  solidPlaying = false
}
function startSolidClock() {
  if (!isSolid() || solidPlaying) return
  if (time >= solidMedia.duration) seek(0)
  solidPlaying = true
  solidStartTime = time
  solidStartedAt = performance.now()
  syncPlayback()
  solidTimer = setInterval(tickSolidClock, 16)
}
function tickSolidClock() {
  if (!solidPlaying) return
  time = Math.round(solidElapsed())
  if (time >= solidMedia.duration) {
    time = solidMedia.duration
    stopSolidClock()
    syncPlayback()
  }
  updatePreview()
}
function pauseSolidClock() {
  if (!solidPlaying) return
  time = Math.round(solidElapsed())
  stopSolidClock()
  syncPlayback()
  updatePreview()
}

// 播放头始终落在时间轴的最小刻度上：有帧索引时按帧，否则按标尺最小刻度。
function snapRulerTime(value) {
  if (frameTimes?.length) return Math.round(value)
  const fps = rulerFps()
  if (fps) {
    const frame = 1000 / fps
    return Math.round(Math.round(value / frame) * frame)
  }
  const step = rulerMinor()
  return Math.round(value / step) * step
}
function snapPlayheadTime(value) {
  const rounded = Math.round(value)
  if (frameTimes?.length) {
    const boundaries = editingBoundaries()
    if (boundaries.length >= 2) return nearestBoundary(boundaries, rounded) ?? rounded
    return rounded
  }
  return snapRulerTime(rounded)
}
function snapPlayhead() {
  const snapped = snapPlayheadTime(time)
  if (snapped === time) return
  time = snapped
  presentedFrameTime = null
  if (isSolid()) {
    solidStartTime = time
    solidStartedAt = performance.now()
  } else if (video.readyState) {
    video.currentTime = snapped / 1000
  }
  updatePreview()
}

function seek(value, onFrame = false) {
  const target = Math.max(0, Math.min(hasPicture() ? mediaDuration : timelineEnd(), value))
  rulerFrame = onFrame ? target : undefined
  time = Math.round(target)
  presentedFrameTime = null
  if (isSolid()) {
    solidStartTime = time
    solidStartedAt = performance.now()
  } else if (video.readyState) video.currentTime = target / 1000
  updatePreview()
}

// First presentation timestamp at or after the requested position.
function frameAt(milliseconds) {
  let left = 0
  let right = frameTimes.length
  while (left < right) {
    const mid = Math.floor((left + right) / 2)
    if (frameTimes[mid] < milliseconds) left = mid + 1
    else right = mid
  }
  return left
}
function editingBoundaries() {
  return frameBoundaries(frameTimes, mediaDuration)
}

function seekFrame(milliseconds, direction = 0) {
  if (!frameTimes?.length) {
    seek(milliseconds + direction * 100)
    return
  }
  const index = frameAt(milliseconds)
  let target = Math.min(index, frameTimes.length - 1)
  const tolerance = .0001
  if (direction < 0) target = frameAt(milliseconds - tolerance) - 1
  else if (direction > 0) target = frameAt(milliseconds + tolerance)
  else if (target > 0 && milliseconds - frameTimes[target - 1] <= frameTimes[target] - milliseconds) target--
  seek(frameTimes[Math.max(0, Math.min(target, frameTimes.length - 1))], true)
}

// 方向键移动播放头：有帧索引时按帧，没有时按 0.1 秒；Shift 每次 1 秒。
function pauseForSeek() {
  if (isSolid()) pauseSolidClock()
  else video.pause()
}
// 与时间码一致的“当前帧”：取离 time 最近的一帧，避免停在帧中间时按方向键画面不动。
function nearestFrameIndex(milliseconds) {
  const index = frameAt(milliseconds)
  if (index <= 0) return 0
  if (index >= frameTimes.length) return frameTimes.length - 1
  return milliseconds - frameTimes[index - 1] <= frameTimes[index] - milliseconds ? index - 1 : index
}
function nudgePlayhead(direction, shift) {
  pauseForSeek()
  if (frameTimes?.length && !shift) {
    const target = Math.max(0, Math.min(frameTimes.length - 1, nearestFrameIndex(time) + direction))
    seek(frameTimes[target], true)
  } else {
    seekFrame(playheadPosition() + direction * (shift ? 1000 : 100))
  }
  revealTimelinePosition(time)
}

function timelineEnd() {
  return Math.max(mediaDuration || emptyDuration, ...rows.map(row => row.end))
}

function drawWaveform(usable) {
  const canvas = $('waveform')
  if (isSolid()) {
    canvas.hidden = true
    return
  }
  if (waveformMode === 'off') {
    canvas.hidden = true
    return
  }
  canvas.hidden = false
  const height = canvas.clientHeight
  const offset = scroll.scrollLeft
  const ratio = devicePixelRatio
  const visibleWidth = Math.max(0, Math.min(usable, width(timelineEnd()) - offset))
  canvas.style.left = offset + 'px'
  canvas.style.width = visibleWidth + 'px'
  const pixelWidth = Math.round(visibleWidth * ratio)
  const pixelHeight = Math.round(height * ratio)
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight
  if (!pixelWidth || !pixelHeight) return
  const context = canvas.getContext('2d')
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, visibleWidth, height)
  const axis = height / 2
  const singleSided = waveformMode === 'asymmetric'
  context.fillStyle = '#393e47'
  if (singleSided) context.fillRect(0, height - 1, visibleWidth, 1)
  else context.fillRect(0, axis - .5, visibleWidth, 1)
  if (!waveform) return
  const { peaks, step } = waveform
  context.fillStyle = '#556474'
  for (let x = 0; x < visibleWidth; x += 2) {
    const at = (offset + x) * 1000 / pixelsPerSecond / step
    if (at >= peaks.length) break
    const end = Math.min(peaks.length, Math.ceil(at + 2000 / pixelsPerSecond / step))
    let peak = 0
    for (let index = Math.floor(at); index < end; index++) peak = Math.max(peak, peaks[index])
    if (singleSided) {
      const amplitude = peak * Math.max(0, height - 8)
      if (amplitude > .5) context.fillRect(x, height - amplitude, 1, amplitude)
    } else {
      const amplitude = peak * Math.max(0, axis - 6)
      if (amplitude > .5) context.fillRect(x, axis - amplitude, 1, amplitude * 2)
    }
  }
}

// 同一轨道上两条字幕时间相交的区间，用于时间轴上的重叠高亮和刻度尺提示。
function rowOverlaps(row) {
  const events = []
  for (const cue of row.ordered) {
    if (cue.end <= cue.start) continue
    events.push([cue.start, 1], [cue.end, -1])
  }
  events.sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const intervals = []
  let depth = 0
  let start = 0
  for (const [time, change] of events) {
    const previous = depth
    depth += change
    if (previous < 2 && depth >= 2) start = time
    else if (previous >= 2 && depth < 2 && time > start) intervals.push({ start, end: time })
  }
  return intervals
}

function laneLayout(track) {
  const ordered = [...track.cues].sort((left, right) => left.start - right.start || left.end - right.end)
  const laneById = new Map()
  let end = 0
  let maxSpan = 0
  // 一条轨道只有一行：重叠的字幕块横向叠在同一行里，不再上下排成多行。
  for (const cue of ordered) {
    laneById.set(cue.id, 0)
    end = Math.max(end, cue.end)
    maxSpan = Math.max(maxSpan, cue.end - cue.start)
  }
  return { track, ordered, laneById, end, height: CUE_HEIGHT, maxSpan }
}

function render() {
  rows = project.tracks.map(laneLayout)
  renderScriptPanel()
  if (!hasPicture()) time = Math.min(time, timelineEnd())
  reviewCues = []
  for (const [rowIndex, row] of rows.entries()) {
    for (const [cueIndex, cue] of row.ordered.entries()) {
      if (cue.splitNeedsReview) reviewCues.push({ row, cue, rowIndex, cueIndex })
    }
  }
  $('next-review').hidden = !reviewCues.length
  $('next-review').textContent = '待校对 ' + reviewCues.length
  const spacer = element('div', 'heading-spacer')
  const headingActions = element('div', 'heading-actions')
  headingActions.append(headingAddTrack, $('delete-track'))
  spacer.append(element('span', '', '轨道'), headingActions)
  const headings = element('div', 'track-heading-list')
  const lanes = []
  for (const row of rows) {
    const { track } = row
    const locked = Boolean(track.locked)
    const heading = element('div', 'track-heading')
    heading.dataset.trackId = track.id
    heading.style.setProperty('--track-height', row.height + 'px')
    heading.classList.toggle('locked', locked)
    const label = trackLabel(track)
    const name = element('span', 'track-name', track.label || label)
    name.tabIndex = 0
    name.setAttribute('role', 'button')
    name.title = track.ass?.sourceName ?? track.name
    name.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      chooseTrack(track)
    })
    name.addEventListener('dblclick', event => {
      event.preventDefault()
      event.stopPropagation()
      beginTrackRename(track, name)
    })
    const visibility = element('button', 'visibility-button')
    visibility.append(icon(track.visible ? 'eye' : 'eye-off'))
    visibility.title = locked ? '轨道已锁定' : track.visible ? '隐藏轨道' : '显示轨道'
    visibility.setAttribute('aria-label', visibility.title + ' ' + label)
    visibility.disabled = locked
    visibility.addEventListener('click', () => {
      if (track.locked) return
      edit(() => { track.visible = !track.visible })
    })
    const lock = element('button', 'lock-button')
    lock.append(icon(locked ? 'lock' : 'unlock'))
    lock.title = locked ? '解锁轨道' : '锁定轨道'
    lock.setAttribute('aria-label', lock.title)
    lock.setAttribute('aria-pressed', String(locked))
    lock.addEventListener('click', () => toggleTrackLock(track))
    heading.append(name, visibility, lock)
    heading.addEventListener('click', event => {
      if (event.target.closest('button')) return
      chooseTrack(track)
    })
    headings.append(heading)
    const lane = element('div', 'track-lane' + (track.visible ? '' : ' muted-track') + (locked ? ' locked-track' : ''))
    lane.dataset.trackId = track.id
    lane.dataset.layerIndex = String(trackIndex(project.tracks, track))
    lane.style.setProperty('--track-height', row.height + 'px')
    lanes.push(lane)
    row.lane = lane
    row.buttons = new Map()
    row.overlapLayer = element('div', 'overlap-layer')
    lane.append(row.overlapLayer)
  }
  $('track-headings').replaceChildren(spacer, headings, headingResizer)
  $('track-lanes').replaceChildren(...lanes)
  const cueTotal = rows.reduce((sum, row) => sum + row.ordered.length, 0)
  $('empty-timeline').hidden = cueTotal > 0
  $('project-stats').textContent = rows.length + ' 条轨道 · ' +
    rows.reduce((sum, row) => sum + row.ordered.length, 0) + ' 条字幕'
  $('undo').disabled = !undo.length
  $('redo').disabled = !redo.length
  refreshTrackControls()
  renderCueForm()
  updateEmptyState()
  updateProjectTitle()
  renderViewport()
  renderStyleList(true)
  for (const key of ['fade', 'watermark']) $('project-' + key).checked = Boolean(project.settings?.[key])
  $('project-fade-duration').value = String(project.settings?.fadeDuration ?? 100)
  $('fade-duration-field').hidden = !project.settings?.fade
  const watermarkImage = project.settings?.watermarkImage
  $('watermark-fields').hidden = !project.settings?.watermark
  $('watermark-name').textContent = watermarkImage?.path
    ? (watermarkImage.name || watermarkImage.path.split(/[\\/]/).pop()) : '选择水印图片'
  $('watermark-scale').value = String(watermarkImage?.scale ?? 14)
  $('watermark-opacity').value = String(watermarkImage?.opacity ?? 80)
  $('watermark-x').value = String(watermarkImage?.x ?? 78)
  $('watermark-y').value = String(watermarkImage?.y ?? 6)
  void syncWatermarkImage()
  applyWatermarkOverlay()
  if ($('qc-tab').getAttribute('aria-selected') === 'true') renderQcPanel()
}

function refreshTrackControls() {
  const current = track()
  const locked = Boolean(current?.locked)
  $('export-subtitles').disabled = locked || (!current?.ass && !current?.cues.length)
  $('add-cue').disabled = locked
  const selectedCue = findCue(project, selected)
  const selectedLocked = Boolean(selectedCue && trackFor(selectedCue.id)?.locked)
  $('split-cue').disabled = !selectedCue || selectedLocked
  $('trim-start').disabled = !selectedCue || selectedLocked
  $('trim-end').disabled = !selectedCue || selectedLocked
  $('timeline-delete').disabled = !(selectedCue || selectedCues.size)
  $('delete-track').disabled = !current || locked
  for (const heading of $('track-headings').querySelectorAll('.track-heading')) {
    const active = heading.dataset.trackId === currentTrack
    heading.classList.toggle('active', active)
    heading.querySelector('.track-name').setAttribute('aria-pressed', String(active))
  }
}

function timelineView() {
  const headingWidth = $('track-headings').offsetWidth
  const usable = Math.max(1, scroll.clientWidth - headingWidth)
  const contentWidth = Math.max(usable, width(contentTime()))
  return { usable, contentWidth, maxScroll: Math.max(0, contentWidth - usable) }
}

// 重叠区间按当前 rows 缓存：滚动时不会每帧重算几千条字幕。
let overlapCacheRows = null
let overlapCacheMap = null
function overlapsForRows() {
  if (overlapCacheRows === rows && overlapCacheMap) return overlapCacheMap
  overlapCacheRows = rows
  overlapCacheMap = new Map(rows.map(row => [row, rowOverlaps(row)]))
  return overlapCacheMap
}

// 播放头磁吸用的字幕块边缘：按当前 rows 缓存，滚动和播放时不会重复排序。
let edgeCacheRows = null
let edgeCacheEdges = null
function cueEdgeTimes() {
  if (edgeCacheRows === rows) return edgeCacheEdges
  edgeCacheRows = rows
  const edges = []
  for (const row of rows) {
    if (!row.track.visible) continue
    for (const cue of row.ordered) edges.push(cue.start, cue.end)
  }
  edges.sort((a, b) => a - b)
  edgeCacheEdges = edges
  return edges
}

// 指针移动播放头时的磁吸：命中字幕块边缘就吸附过去，否则回落到最小刻度。
function magneticPlayheadTime(milliseconds) {
  if (!snapping) return undefined
  const edges = cueEdgeTimes()
  if (!edges.length) return undefined
  const edge = nearestBoundary(edges, milliseconds)
  if (edge === undefined) return undefined
  return Math.abs(width(edge - milliseconds)) <= 7 ? edge : undefined
}

function updateSnapGuide() {
  const guide = $('snap-guide')
  const at = drag?.snapTime ?? playheadSnapTime
  guide.hidden = at === undefined
  if (!guide.hidden) guide.style.left = width(at) + 'px'
}

function renderRuler(start, end, limit, trackData, overlapIntervals = []) {
  const { fps, major, minor, frameTicks } = rulerSteps()
  const ticks = []
  const markedEnds = mediaDuration && mediaDuration < limit ? [mediaDuration, limit] : [limit]
  const nearEndLabel = at => markedEnds.some(end => Math.abs(width(end - at)) < 95)
  function tick(at, title, extraClass = '') {
    const mark = element('div', 'tick' + extraClass)
    mark.style.left = width(at) + 'px'
    if (title) mark.append(element('span', 'tick-label', title))
    ticks.push(mark)
  }
  const first = Math.floor(start / minor)
  const last = Math.ceil(end / minor)
  for (let index = first; index <= last; index++) {
    const at = index * minor
    if (at < 0 || at >= limit) continue
    const ratio = at / major
    const isMajor = Math.abs(ratio - Math.round(ratio)) < 1e-6
    const label = isMajor && (at === 0 || !nearEndLabel(at)) ? rulerLabel(at, fps, major) : ''
    tick(at, label, (isMajor ? ' major-tick' : '') + (frameTicks ? ' frame-tick' : ''))
  }
  for (const at of markedEnds) {
    if (end >= at && start <= at) tick(at, rulerLabel(at, fps, major), ' major-tick end-tick')
  }
  for (const interval of overlapIntervals) {
    if (interval.end < start || interval.start > end) continue
    const mark = element('div', 'overlap-mark')
    mark.style.left = width(interval.start) + 'px'
    mark.style.width = Math.max(2, width(interval.end - interval.start)) + 'px'
    mark.title = '字幕重叠 ' + printTime(interval.end - interval.start, '.')
    mark.append(element('span', 'overlap-badge', '!'))
    ticks.push(mark)
  }
  for (const at of project.markers ?? []) {
    if (at < start || at > end) continue
    const marker = element('span', 'marker')
    marker.style.left = width(at) + 'px'
    marker.title = '标记 ' + printTime(at, '.')
    ticks.push(marker)
  }
  $('ruler').replaceChildren(...ticks)
}

function renderViewport() {
  const { usable } = timelineView()
  cachedUsableWidth = usable
  const { min, max } = zoomBounds(usable)
  if (pixelsPerSecond <= min + .001) fitZoom = true
  pixelsPerSecond = fitZoom ? min : Math.min(max, pixelsPerSecond)
  const zoom = $('zoom')
  zoom.min = String(min)
  zoom.max = String(max)
  zoom.value = String(pixelsPerSecond)
  updatePlayhead()
  const { contentWidth } = timelineView()
  const trackData = $('track-data')
  trackData.style.width = contentWidth + 'px'
  const timeLimit = timelineEnd()
  trackData.style.setProperty('--timeline-end', width(timeLimit) + 'px')
  updateSnapGuide()
  const visibleStart = deltaFor(Math.max(0, scroll.scrollLeft - 110))
  const visibleEnd = deltaFor(scroll.scrollLeft + usable + 110)
  const overlapRows = overlapsForRows()
  const rulerOverlaps = []
  const seenOverlaps = new Set()
  for (const intervals of overlapRows.values()) {
    for (const interval of intervals) {
      const key = interval.start + ':' + interval.end
      if (seenOverlaps.has(key)) continue
      seenOverlaps.add(key)
      rulerOverlaps.push(interval)
    }
  }
  renderRuler(visibleStart, visibleEnd, timeLimit, trackData, rulerOverlaps)
  drawWaveform(usable)
  const paired = new Set(selected ? linkedIds(project, selected) : [])
  const overlaps = dragOverlapIds(drag)
  $('drag-overlap').hidden = !overlaps?.size
  for (const row of rows) {
    row.lane.classList.toggle('active', row.track.id === currentTrack)
    row.lane.classList.toggle('drop-target', drag?.destination === row)
    row.lane.classList.toggle('locked-track', Boolean(row.track.locked))
    if (row.overlapLayer) {
      row.overlapLayer.replaceChildren(...(overlapRows.get(row) ?? []).map(interval => {
        const band = element('div', 'cue-overlap')
        band.style.left = width(interval.start) + 'px'
        band.style.width = Math.max(2, width(interval.end - interval.start)) + 'px'
        band.title = '字幕重叠 ' + printTime(interval.end - interval.start, '.')
        return band
      }))
    }
    const retained = new Set()
    for (const cue of row.ordered) {
      if (cue.start > visibleEnd && !drag) break
      const { start, end } = cueTiming(cue, drag)
      if (cue.id !== selected && cue.id !== linkStart &&
          (start > visibleEnd || end < visibleStart)) continue
      retained.add(cue.id)
      let block = row.buttons.get(cue.id)
      if (!block) {
        block = element('button', 'cue')
        block.type = 'button'
        block.dataset.cueId = cue.id
        block.addEventListener('pointerdown', event => startDrag(event, row.track, cue))
        block.addEventListener('pointermove', event => {
          const edge = !linkMode && (drag ? drag.edge : cueEdge(event, cue))
          block.classList.toggle('trim-edge', Boolean(edge))
          block.classList.toggle('trim-start', edge === 'start')
          block.classList.toggle('trim-end', edge === 'end')
        })
        block.addEventListener('pointerleave', () => block.classList.remove('trim-edge', 'trim-start', 'trim-end'))
        block.addEventListener('lostpointercapture', event => endDrag(event.pointerId, false))
        block.addEventListener('click', event => {
          if (event.detail === 0) pick(row.track, cue)
        })
        block.addEventListener('dblclick', () => openCueEditor(row.track, cue))
        block.addEventListener('keydown', event => {
          if (event.key !== 'Enter' || linkMode || event.isComposing || event.keyCode === 229 ||
              event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          event.preventDefault()
          if (!event.repeat) openCueEditor(row.track, cue)
        })
        row.buttons.set(cue.id, block)
        // 字幕块保持在前，重叠高亮层始终垫在最后，避免影响按位置取块的既有选择器。
        if (row.overlapLayer) row.lane.insertBefore(block, row.overlapLayer)
        else row.lane.append(block)
      }
      const displayText = row.track.ass || cue.assText ? cue.text.replace(/\{[^}]*\}/g, '') : cue.text
      const linked = linkedIds(project, cue.id).length === 2
      const title = (cue.splitNeedsReview ? '需手工检查 · ' : '') + displayText
      const label = displayText.replace(/\n/g, ' / ')
      if (block.textContent !== label || Boolean(block.querySelector('svg use[href="#i-link"]')) !== linked) {
        block.replaceChildren(...(linked ? [icon('link'), label] : [label]))
      }
      const durationWidth = width(end - start)
      const dense = durationWidth < DENSE_CUE_WIDTH
      block.title = displayText
      block.setAttribute('aria-label', title || '空字幕块')
      block.dataset.range = printTime(start, '.') + ' – ' + printTime(end, '.')
      const isSelected = cue.id === selected || cue.id === linkStart || selectedCues.has(cue.id)
      block.classList.toggle('selected', isSelected)
      block.setAttribute('aria-pressed', String(isSelected))
      block.classList.toggle('paired', paired.has(cue.id) && cue.id !== selected)
      block.classList.toggle('review', Boolean(cue.splitNeedsReview))
      block.classList.toggle('locked', Boolean(row.track.locked))
      block.classList.toggle('drag-overlap', overlaps?.has(cue.id) ?? false)
      block.classList.toggle('dense', dense)
      const bound = Boolean(bindingGroupOf(cue.id))
      block.classList.toggle('bound', bound)
      let bindingDot = block.querySelector('.cue-binding-dot')
      if (bound && !bindingDot) {
        bindingDot = element('span', 'cue-binding-dot')
        block.append(bindingDot)
      } else if (!bound && bindingDot) bindingDot.remove()
      block.style.left = width(start) + 'px'
      block.style.top = row.laneById.get(cue.id) * (CUE_HEIGHT + CUE_LANE_GAP) + CUE_LANE_PADDING + 'px'
      block.style.height = CUE_HEIGHT + 'px'
      const targetRow = drag?.trackDelta && drag.movingIds.has(cue.id) ? rows[rows.indexOf(row) + drag.trackDelta] : undefined
      block.classList.toggle('crossing-track', Boolean(targetRow))
      block.style.transform = targetRow ? 'translateY(' + (targetRow.lane.offsetTop - row.lane.offsetTop) + 'px)' : ''
      const trimming = drag?.edge && drag.ids.has(cue.id)
      // 紧凑块按真实时长绘制并留 1px 间隙；普通块保持原样，避免相邻块共用一条边。
      // 裁剪时只把最小宽度降到 1px，不能把当前宽度直接写成 1px，否则一拖就缩成一条线。
      const visualWidth = dense
        ? Math.max(trimming ? 1 : 2, durationWidth - 1)
        : Math.max(1, durationWidth)
      block.style.width = visualWidth + 'px'
      block.dataset.start = String(start)
      block.dataset.end = String(end)
    }
    for (const [id, node] of row.buttons) {
      if (retained.has(id)) continue
      node.remove()
      row.buttons.delete(id)
    }
  }
  renderZoomBar()
  renderPlayingCue()
  if (editorOpen()) {
    if (findCue(project, editorCue)) positionCueEditor()
    else closeCueEditor(false)
  }
}

function beginTrackRename(owner, node) {
  if (owner.locked) {
    status('轨道已锁定，解锁后可重命名')
    return
  }
  if (node.querySelector('input')) return
  const input = element('input', 'track-name-input')
  input.type = 'text'
  input.value = owner.label || trackLabel(owner)
  input.maxLength = 40
  input.setAttribute('aria-label', '轨道名称')
  node.textContent = ''
  node.append(input)
  input.focus()
  input.select()
  let settled = false
  const finish = commit => {
    if (settled) return
    settled = true
    const value = input.value.trim()
    if (commit && value && value !== (owner.label || trackLabel(owner))) edit(() => { owner.label = value })
    else render()
  }
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('click', event => event.stopPropagation())
  input.addEventListener('dblclick', event => event.stopPropagation())
}

function chooseTrack(owner) {
  if (owner.locked) {
    status('轨道已锁定，解锁后可操作')
    return
  }
  if (currentTrack === owner.id) return
  currentTrack = owner.id
  selectedCues.clear()
  selected = undefined
  refreshTrackControls()
  renderCueForm()
  renderViewport()
  refreshInspectorPreview()
}

function toggleTrackLock(owner) {
  if (switchingProject) return
  owner.locked = !owner.locked
  revision = Symbol()
  if (owner.locked) {
    if (selected && trackFor(selected)?.id === owner.id) selected = undefined
    selectedCues.clear()
    if (linkStart && trackFor(linkStart)?.id === owner.id) linkStart = undefined
    if (editorOpen() && trackFor(editorCue)?.id === owner.id) closeCueEditor(false)
  }
  render()
  status((owner.locked ? '已锁定「' : '已解锁「') + trackLabel(owner) + '」')
  scheduleAutosave()
}

function pick(track, cue, keepGroup = false) {
  if (track.locked) {
    status('轨道已锁定，解锁后可编辑')
    return
  }
  if (!keepGroup) selectedCues.clear()
  selected = cue.id
  currentTrack = track.id
  if (!linkMode && bindingGroupOf(cue.id)) {
    selectedCues = expandBindings(new Set([...selectedCues, cue.id]))
  }
  if (linkMode) {
    if (linkStart === cue.id || !linkStart && linkedIds(project, cue.id).length > 1) {
      if (linkedIds(project, cue.id).length > 1) {
        edit(() => { project.links = project.links.filter(pair => !pair.includes(cue.id)) })
        status('已解除链接')
      } else {
        status('已取消配对')
      }
      linkStart = undefined
    } else if (!linkStart) {
      linkStart = cue.id
      status('选择另一条轨道上的字幕以建立链接')
    } else if (trackFor(linkStart)?.id === track.id) {
      status('请选择另一条轨道上的字幕')
    } else if (linkedIds(project, cue.id).length > 1) {
      status('此字幕已有链接，请先解除链接')
    } else {
      edit(() => { project.links.push([linkStart, cue.id]) })
      linkStart = undefined
      status('已建立链接')
    }
    render()
    return
  }
  refreshTrackControls()
  renderCueForm()
  updateProjectTitle()
  renderViewport()
  $('cue-tab').hidden = false
  switchTab('cue')
  updateTabPages()
  refreshInspectorPreview()
}

function cueEdge(event, cue) {
  if (width(cue.end - cue.start) < DENSE_CUE_WIDTH) return null
  const bounds = event.currentTarget.getBoundingClientRect()
  const threshold = Math.min(6, bounds.width / 3)
  if (event.clientX <= bounds.left + threshold) return 'start'
  if (event.clientX >= bounds.right - threshold) return 'end'
  return null
}

// 多选裁剪时所有选中块共用同一个位移，取各块允许范围的交集。
function trimLimits(cues, edge) {
  let min = -Infinity
  let max = Infinity
  for (const item of cues) {
    min = Math.max(min, trimDelta(item, edge, -Infinity))
    max = Math.min(max, trimDelta(item, edge, Infinity))
  }
  return { min, max }
}

function startDrag(event, track, cue) {
  if (event.button !== 0 || drag) return
  if (track.locked) {
    status('轨道已锁定，解锁后可编辑')
    return
  }
  if (toolMode === 'split') {
    event.preventDefault()
    splitCueAt(track, cue, cue.start + deltaFor(event.clientX - event.currentTarget.getBoundingClientRect().left))
    return
  }
  if (toolMode === 'select-forward' || toolMode === 'select-backward') {
    event.preventDefault()
    selectCueRange(track, cue, toolMode === 'select-forward' ? 'forward' : 'backward')
    return
  }
  const edge = cueEdge(event, cue)
  // 多选时移动和裁剪都作用到全部选中块；裁剪时每块按同一个位移调整同一条边。
  const keepGroup = !linkMode && selectedCues.size > 1 && selectedCues.has(cue.id)
  pick(track, cue, keepGroup)
  if (linkMode) return
  // 绑定组在 pick 时已经展开进 selectedCues：直接拖任意一个绑定块也要整组移动。
  const group = !linkMode && selectedCues.size > 1 && selectedCues.has(cue.id)
  event.preventDefault()
  const movingIds = new Set(group ? selectedCues : [cue.id])
  const ids = new Set(movingIds)
  if (!edge) {
    for (const [left, right] of project.links) {
      if (ids.has(left) || ids.has(right)) { ids.add(left); ids.add(right) }
    }
  }
  const targets = rows.flatMap(row => row.ordered.filter(item => ids.has(item.id)).map(cue => ({ cue, row })))
  const cues = targets.map(item => item.cue)
  const overlapRows = new Map(rows.map(row => [row, row.ordered.filter(item => !ids.has(item.id))]))
  const boundaries = []
  if (snapping) {
    for (const row of rows) {
      if (!row.track.visible) continue
      for (const other of row.ordered) if (!ids.has(other.id)) boundaries.push(other.start, other.end)
    }
  }
  const limits = edge ? trimLimits(cues, edge) : undefined
  const limit = edge
    ? requested => Math.max(limits.min, Math.min(limits.max, requested))
    : requested => moveDelta(cues, requested)
  const snapEdges = edge ? [cue[edge]] : [cue.start, cue.end]
  drag = { pointer: event.pointerId, startX: event.clientX, scrollLeft: scroll.scrollLeft, startY: event.clientY, source: track, sourceRowIndex: rows.findIndex(row => row.track === track),
    cues, targets, ids, movingIds, edge, grid: editingBoundaries(),
    boundaries, snapEdges, group, overlapRows, minDelta: limit(-Infinity), maxDelta: limit(Infinity), delta: 0, trackDelta: 0 }
  event.currentTarget.focus({ preventScroll: true })
  event.currentTarget.setPointerCapture(event.pointerId)
}

function findDragSnap(requested) {
  let closest = Infinity
  let snap
  function consider(boundary) {
    for (const edge of drag.snapEdges) {
      const delta = boundary - edge
      const distance = Math.abs(width(delta - requested))
      if (delta < drag.minDelta || delta > drag.maxDelta || distance > 7 || distance >= closest) continue
      closest = distance
      snap = { delta, time: boundary }
    }
  }
  consider(Math.round(playheadPosition()))
  for (const boundary of drag.boundaries) consider(boundary)
  return snap
}

function pointerMove(event) {
  if (drag?.pointer !== event.pointerId) return
  const distance = event.clientX - drag.startX + scroll.scrollLeft - drag.scrollLeft
  const requested = Math.abs(distance) > 3 ? deltaFor(distance) : 0
  const snap = snapping && requested ? findDragSnap(requested) : undefined
  const delta = snap?.delta ?? Math.max(drag.minDelta, Math.min(drag.maxDelta, requested))
  const zone = scroll.getBoundingClientRect()
  const lane = !drag.edge && Math.abs(event.clientY - drag.startY) > 4 &&
    event.clientY >= zone.top && event.clientY < zone.bottom &&
    document.elementsFromPoint(event.clientX, event.clientY).find(node => node.classList.contains('track-lane'))
  const laneRow = lane && rows.find(row => row.lane === lane)
  // 多选跨轨道移动：整组按同一轨道数平移，任何一条越界或目标轨道锁定就取消。
  let trackDelta = 0
  if (laneRow) {
    const step = rows.indexOf(laneRow) - drag.sourceRowIndex
    if (step && drag.targets.every(({ row }) => {
      const target = rows[rows.indexOf(row) + step]
      return Boolean(target) && !target.track.locked
    })) trackDelta = step
  }
  const destination = trackDelta ? laneRow : undefined
  if (delta === drag.delta && snap?.time === drag.snapTime && destination === drag.destination && trackDelta === drag.trackDelta) return
  drag.trackDelta = trackDelta
  drag.destination = destination
  drag.delta = delta
  drag.snapTime = snap?.time
  drag.timings = undefined
  if (requested && drag.grid.length >= 2) {
    drag.timings = new Map()
    for (const cue of drag.cues) {
      let timing
      if (drag.edge === 'start') {
        const start = nearestBoundary(drag.grid, cue.start + delta, -Infinity, cue.end - 1)
        timing = start === undefined ? { start: cue.start, end: cue.end } : alignCue(drag.grid, start, cue.end)
      } else if (drag.edge === 'end') {
        const end = nearestBoundary(drag.grid, cue.end + delta, cue.start + 1)
        timing = end === undefined ? { start: cue.start, end: cue.end } : alignCue(drag.grid, cue.start, end)
      } else timing = alignCue(drag.grid, cue.start + delta, cue.end + delta)
      drag.timings.set(cue.id, timing)
    }
    drag.snapTime = undefined
  }
  if (!dragFrame) {
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0
      renderViewport()
      updatePreview()
    })
  }
}

function dragOverlapIds(adjustment) {
  if (!adjustment || !adjustment.delta && !adjustment.destination) return
  const overlaps = new Set()
  for (const { cue, row } of adjustment.targets) {
    const { start, end } = cueTiming(cue, adjustment)
    const zone = adjustment.movingIds.has(cue.id) && adjustment.trackDelta
      ? rows[rows.indexOf(row) + adjustment.trackDelta] ?? row
      : row
    for (const other of adjustment.overlapRows.get(zone)) {
      if (other.start >= end) break
      if (other.end <= start || adjustment.ids.has(other.id)) continue
      overlaps.add(cue.id)
      overlaps.add(other.id)
    }
  }
  return overlaps
}

function endDrag(pointer, commit) {
  if (!drag || drag.pointer !== pointer) return
  const adjustment = drag
  const { delta, cues, edge, destination, trackDelta } = adjustment
  cancelAnimationFrame(dragFrame)
  dragFrame = 0
  drag = undefined
  if (commit && destination && [...adjustment.movingIds].some(id => cueDrafts.has(id))) {
    renderViewport()
    updatePreview()
    status('请先应用或取消字幕草稿，再移动到其他轨道。')
    return
  }
  if (commit && (delta || destination)) {
    const overlaps = dragOverlapIds(adjustment)
    edit(() => {
      for (const cue of cues) Object.assign(cue, cueTiming(cue, adjustment))
      if (trackDelta) {
        // 多选可能横跨多条轨道：按来源轨道分组，各自平移到目标轨道。
        const groups = new Map()
        for (const { cue, row } of adjustment.targets) {
          if (!adjustment.movingIds.has(cue.id)) continue
          const target = rows[rows.indexOf(row) + trackDelta]
          if (!target) continue
          const entry = groups.get(row.track.id) ?? { source: row.track, target: target.track, cues: [] }
          entry.cues.push(cue)
          groups.set(row.track.id, entry)
        }
        for (const group of groups.values()) moveCuesToTrack(project, group.source, group.target, group.cues)
        currentTrack = destination.track.id
        selectedCues.clear()
      }
    })
    const message = destination ? '已移动到 ' + trackLabel(destination.track) : edge ? (cues.length > 1 ? '已调整 ' + cues.length + ' 条字幕边界' : '已调整字幕边界') : '已移动' + (adjustment.group ? '成组字幕' : cues.length > 1 ? '链接字幕' : '字幕')
    status(message + (overlaps?.size ? ' · 同轨字幕重叠' : ''))
  } else {
    renderViewport()
    updatePreview()
  }
}

function switchTab(tab, preview = true) {
  // 标签组使用 roving tabindex：只有当前标签在 Tab 序列里，方向键在标签间移动。
  for (const name of ['styles', 'settings', 'qc', 'cue', 'script']) {
    $(name + '-tab').tabIndex = tab === name ? 0 : -1
  }
  if ($(tab + '-tab').getAttribute('aria-selected') === 'true') {
    if (tab === 'qc') renderQcPanel()
    return
  }
  if (punch && tab !== 'script') finishPunch()
  for (const name of ['styles', 'settings', 'qc', 'cue', 'script']) {
    $(name + '-tab').setAttribute('aria-selected', String(tab === name))
    $(name + '-panel').hidden = tab !== name
  }
  revealTab(tab)
  if (tab === 'qc') renderQcPanel()
  if (preview) refreshInspectorPreview()
}

// 配置区变窄时标签放不下：右侧出现箭头，点一下翻到下一页标签。
const tabsScroll = $('tabs-scroll')
const tabsMoreLeft = $('tabs-more-left')
const tabsMoreRight = $('tabs-more-right')
const tabsMenu = $('tabs-menu')
function visibleTabButtons() {
  return [...tabsScroll.querySelectorAll('[role=tab]')].filter(button => !button.hidden)
}
function hiddenTabButtons(side) {
  const view = tabsScroll.getBoundingClientRect()
  return visibleTabButtons().filter(button => {
    const box = button.getBoundingClientRect()
    return side === 'left' ? box.left < view.left - 1 : box.right > view.right + 1
  })
}
function updateTabPages() {
  if (!tabsScroll) return
  tabsMoreLeft.hidden = hiddenTabButtons('left').length === 0
  tabsMoreRight.hidden = hiddenTabButtons('right').length === 0
}
// 弹层以自身尺寸为基准夹在视口内，靠近顶部或底部时都不会溢出。
function placePopover(menu, left, top) {
  menu.style.left = Math.max(4, Math.min(innerWidth - menu.offsetWidth - 4, left)) + 'px'
  menu.style.top = Math.max(4, Math.min(innerHeight - menu.offsetHeight - 4, top)) + 'px'
}

function showTabsMenu(side) {
  const hidden = hiddenTabButtons(side)
  if (!hidden.length) return
  tabsMenu.replaceChildren(...hidden.map(button => {
    const item = element('button')
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    const iconNode = button.querySelector('svg')
    if (iconNode) item.append(iconNode.cloneNode(true))
    item.append(element('span', '', button.textContent.trim()))
    if (button.getAttribute('aria-selected') === 'true') item.setAttribute('aria-selected', 'true')
    item.addEventListener('click', () => {
      tabsMenu.hidePopover()
      const name = button.id.replace(/-tab$/, '')
      switchTab(name)
      revealTab(name)
    })
    return item
  }))
  const anchor = side === 'left' ? tabsMoreLeft : tabsMoreRight
  const box = anchor.getBoundingClientRect()
  tabsMenu.style.left = '0px'
  tabsMenu.style.top = '0px'
  tabsMenu.showPopover()
  placePopover(tabsMenu, side === 'left' ? box.left : box.right - tabsMenu.offsetWidth, box.bottom + 4)
}
function revealTab(name) {
  const button = $(name + '-tab')
  if (!button || button.hidden) return
  const box = button.getBoundingClientRect()
  const view = tabsScroll.getBoundingClientRect()
  if (box.left < view.left) tabsScroll.scrollLeft -= view.left - box.left + 6
  else if (box.right > view.right) tabsScroll.scrollLeft += box.right - view.right + 6
}
tabsMoreLeft.addEventListener('click', () => showTabsMenu('left'))
tabsMoreRight.addEventListener('click', () => showTabsMenu('right'))
tabsScroll.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const buttons = visibleTabButtons()
  const current = buttons.indexOf(document.activeElement)
  if (current < 0) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
  const target = buttons[next]
  switchTab(target.id.replace(/-tab$/, ''))
  target.focus({ preventScroll: true })
  // 显式阻止冒泡，避免标签方向键同时触发全局播放头快捷键。
  event.stopPropagation()
})
tabsScroll.addEventListener('scroll', updateTabPages, { passive: true })
new ResizeObserver(updateTabPages).observe(tabsScroll)

function recordDraft(form) {
  const binding = inspectorForms.get(form)
  if (!binding) return
  const { drafts, id, fields, original } = binding
  const changes = new Map()
  fields.forEach((control, index) => {
    if (control.value !== original[index]) changes.set(index, control.value)
  })
  if (changes.size) drafts.set(id, changes)
  else drafts.delete(id)
  form.querySelector('.discard-draft').hidden = !changes.size
  scheduleAutosave()
}

function bindDraft(form, drafts, id, rerender) {
  const fields = [...form.querySelectorAll('input,textarea,select')]
  inspectorForms.set(form, { drafts, id, fields, original: fields.map(control => control.value) })
  for (const [index, value] of drafts.get(id) ?? []) fields[index].value = value
  recordDraft(form)
  form.querySelector('.discard-draft').onclick = () => {
    drafts.delete(id)
    rerender()
    updateProjectTitle()
    scheduleAutosave()
  }
}

// 选中字幕的即时信息：轨道、时长、语速（去除空白与 ASS 标签后的字数/秒）和链接状态。
function cuePlainText(text) {
  return String(text ?? '').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n')
}
function cueStats(cue, values = {}) {
  const start = Number.isSafeInteger(values.start) ? values.start : cue.start
  const end = Number.isSafeInteger(values.end) ? values.end : cue.end
  const text = cuePlainText(values.text ?? cue.text)
  const duration = Math.max(0, end - start)
  const chars = text.replace(/\s+/g, '').length
  return { duration, cps: duration ? chars / (duration / 1000) : 0, chars }
}
function updateCueMeta(cue, values) {
  const meta = $('cue-meta')
  if (!meta || !cue) return
  const { duration, cps, chars } = cueStats(cue, values)
  const owner = trackFor(cue.id)
  const linked = (project.links ?? []).some(pair => pair.includes(cue.id))
  const bound = Boolean(bindingGroupOf(cue.id))
  $('cue-meta-track').textContent = owner ? trackLabel(owner) : '—'
  $('cue-meta-duration').textContent = (duration / 1000).toFixed(2) + ' 秒'
  $('cue-meta-cps').textContent = cps.toFixed(1) + ' 字/秒 · ' + chars + ' 字'
  const warn = duration < 1000 || cps > 17
  $('cue-meta-cps').classList.toggle('warn', warn)
  $('cue-meta-cps').title = warn
    ? (cps > 17 ? '语速超过 17 字/秒，观众可能读不完。' : '时长不足 1 秒，可能来不及阅读。')
    : '按去除空白与 ASS 标签后的正文字数计算。'
  $('cue-meta-link').textContent = linked ? '已链接' : bound ? '成组' : '未链接'
  $('cue-meta-link').classList.toggle('linked', linked || bound)
}

function renderCueForm() {
  inspectorForms.delete($('cue-form'))
  const cue = findCue(project, selected)
  $('cue-form').hidden = !cue
  $('empty-cue').hidden = Boolean(cue)
  $('cue-meta').hidden = !cue
  $('complete-review').hidden = !cue?.splitNeedsReview
  if (!cue) return
  const locked = Boolean(trackFor(cue.id)?.locked)
  for (const control of $('cue-form').querySelectorAll('input, textarea, select, button')) control.disabled = locked
  $('cue-text').value = cue.text
  $('cue-text').placeholder = trackFor(cue.id)?.ass || cue.assText ? '支持 ASS 覆盖标签' : ''
  $('cue-start').value = printTime(cue.start, '.')
  $('cue-end').value = printTime(cue.end, '.')
  const choices = [new Option('项目默认样式', '')]
  for (const style of project.styles) {
    if (style.trackId === undefined || style.trackId === trackFor(cue.id)?.id) {
      choices.push(new Option(styleName(style), style.id))
    }
  }
  $('cue-style').replaceChildren(...choices)
  $('cue-style').value = cue.style ?? ''
  bindDraft($('cue-form'), cueDrafts, cue.id, () => {
    renderCueForm()
    refreshInspectorPreview()
  })
  updateCueMeta(cue, {
    start: readTime($('cue-start').value),
    end: readTime($('cue-end').value),
    text: $('cue-text').value,
  })
}

const styleSections = [
  ['字形', [
    ['Name', '名称', 'text'], ['Fontname', '字体', 'text'],
    ['Fontsize', '字号', 'number'], ['PrimaryColour', '文字颜色', 'color'],
    ['Bold', '粗体', 'toggle'], ['Italic', '斜体', 'toggle'], ['Underline', '下划线', 'toggle'], ['StrikeOut', '删除线', 'toggle'],
  ]],
  ['描边与阴影', [
    ['Outline', '描边宽度', 'number'], ['OutlineColour', '描边颜色', 'color'],
    ['Shadow', '阴影距离', 'number'], ['BackColour', '阴影颜色', 'color'],
  ]],
  ['位置与对齐', [
    ['Alignment', '对齐', 'alignment'], ['MarginV', '垂直边距', 'number'],
    ['MarginL', '左边距', 'number'], ['MarginR', '右边距', 'number'],
  ]],
  ['缩放与旋转', [
    ['ScaleX', '横向缩放', 'number'], ['ScaleY', '纵向缩放', 'number'],
    ['Spacing', '字间距', 'number'], ['Angle', '旋转角度', 'number'],
  ]],
]

function styleColorControl(title, previous) {
  const group = element('div', 'style-color')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', title)
  const color = readAssColor(previous)
  const picker = element('input', 'style-swatch')
  picker.type = 'color'
  picker.value = color.hex
  picker.setAttribute('aria-label', '选择' + title)
  picker.title = '选择' + title

  const hex = element('input', 'style-hex')
  hex.type = 'text'
  hex.required = true
  hex.maxLength = 7
  hex.pattern = '#?[0-9a-fA-F]{6}'
  hex.title = '输入六位十六进制颜色，例如 #FFFFFF'
  hex.spellcheck = false
  hex.setAttribute('aria-label', title + '十六进制值')
  const updateHex = () => { hex.value = picker.value.toUpperCase() }
  picker.addEventListener('input', updateHex)
  picker.addEventListener('change', updateHex)
  hex.addEventListener('input', () => {
    if (hex.validity.valid) picker.value = '#' + hex.value.replace(/^#/, '')
  })
  hex.addEventListener('blur', () => {
    if (hex.validity.valid) updateHex()
  })
  const opacity = element('input', 'style-opacity')
  opacity.type = 'number'
  opacity.min = '0'
  opacity.max = '100'
  opacity.step = '0.1'
  opacity.required = true
  opacity.value = String(Math.round((255 - color.alpha) * 1000 / 255) / 10)
  opacity.setAttribute('aria-label', title + '不透明度百分比')
  const opacityLabel = element('label', 'style-opacity-field', '不透明度')
  opacityLabel.append(opacity, element('span', '', '%'))
  updateHex()
  group.append(picker, hex, opacityLabel)
  return { group, picker }
}

function styleControl(key, title, type, previous) {
  if (type === 'color') {
    const { group, picker } = styleColorControl(title, previous)
    const wrapper = element('div', 'style-field')
    wrapper.append(element('span', 'field-label', title), group)
    return { wrapper, input: picker }
  }
  if (type === 'toggle') {
    const wrapper = element('div', 'style-field')
    wrapper.append(element('span', 'field-label', title))
    const input = element('input')
    input.type = 'hidden'
    input.value = Number(previous) ? '1' : '0'
    const button = element('button', 'style-toggle', title === '粗体' ? 'B' : title === '斜体' ? 'I' : title === '下划线' ? 'U' : 'S')
    button.type = 'button'
    button.title = title
    button.setAttribute('aria-label', title)
    button.setAttribute('aria-pressed', String(input.value === '1'))
    button.addEventListener('click', () => {
      input.value = input.value === '1' ? '0' : '1'
      button.setAttribute('aria-pressed', String(input.value === '1'))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    wrapper.append(button, input)
    return { wrapper, input }
  }
  if (type === 'alignment') {
    const wrapper = element('div', 'style-field')
    wrapper.append(element('span', 'field-label', title))
    const input = element('input')
    input.type = 'hidden'
    input.value = String(Number(previous) || 2)
    const grid = element('div', 'alignment-grid')
    grid.setAttribute('role', 'group')
    grid.setAttribute('aria-label', title)
    const names = ['左下', '居中靠下', '右下', '左中', '居中', '右中', '左上', '居中靠上', '右上']
    // 宫格按视觉顺序排：上排 7-9，中排 4-6，下排 1-3。
    for (const value of [7, 8, 9, 4, 5, 6, 1, 2, 3]) {
      const cell = element('button', 'alignment-cell')
      cell.type = 'button'
      cell.dataset.value = String(value)
      cell.title = names[value - 1]
      cell.setAttribute('aria-label', names[value - 1])
      cell.setAttribute('aria-pressed', String(String(value) === input.value))
      cell.addEventListener('click', () => {
        input.value = String(value)
        for (const other of grid.children) other.setAttribute('aria-pressed', String(other.dataset.value === input.value))
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      grid.append(cell)
    }
    wrapper.append(grid, input)
    return { wrapper, input }
  }
  const wrapper = element('label', 'style-field', title)
  const input = element('input')
  input.type = type
  input.required = true
  if (type === 'number') {
    input.min = key === 'Fontsize' ? '1' : '0'
    input.step = 'any'
  }
  input.value = previous ?? ''
  wrapper.append(input)
  return { wrapper, input }
}

function styleFieldValue(input, previous) {
  if (input.type !== 'color') return input.value.trim()
  const opacity = input.parentElement.querySelector('.style-opacity').valueAsNumber
  const alpha = Math.round((100 - opacity) * 255 / 100)
  const old = readAssColor(previous)
  if (input.value === old.hex && alpha === old.alpha) return previous?.trim()
  const [red, green, blue] = input.value.slice(1).match(/../g)
  return '&H' + (alpha.toString(16).padStart(2, '0') + blue + green + red).toUpperCase()
}

// 样式编辑器顶部的实时预览：无背景、无边框，只渲染当前样式的文字。
function applyStylePreview(style) {
  const node = $('style-editor')?.querySelector('.style-preview-text')
  if (!node || !style) return
  const property = name => field(style.fields, name)
  const size = Number(property('Fontsize')) || 36
  const shown = Math.max(12, Math.min(40, size))
  const ratio = Math.min(1, 40 / Math.max(12, size))
  node.style.fontFamily = property('Fontname') || ''
  node.style.fontSize = shown + 'px'
  node.style.color = cssAssColor(property('PrimaryColour'))
  node.style.webkitTextStroke = Math.max(0, Number(property('Outline')) || 0) * ratio + 'px ' + cssAssColor(property('OutlineColour'))
  const shadow = (Number(property('Shadow')) || 0) * ratio
  node.style.textShadow = shadow > 0 ? shadow + 'px ' + shadow + 'px ' + cssAssColor(property('BackColour')) : 'none'
  node.style.fontWeight = Number(property('Bold')) ? 'bold' : 'normal'
  node.style.fontStyle = Number(property('Italic')) ? 'italic' : 'normal'
  node.style.textDecoration = [Number(property('Underline')) && 'underline', Number(property('StrikeOut')) && 'line-through'].filter(Boolean).join(' ')
  node.style.letterSpacing = (Number(property('Spacing')) || 0) * .4 + 'px'
  const rotation = -(Number(property('Angle')) || 0)
  const scaleX = (Number(property('ScaleX')) || 100) / 100
  const scaleY = (Number(property('ScaleY')) || 100) / 100
  // 预览文字按面板宽度等比缩小；ScaleX/ScaleY 也计入，避免放大样式被右侧裁掉。
  const fit = () => {
    const box = node.parentElement
    if (!node.isConnected || !box) return
    const available = Math.max(48, box.clientWidth - 16)
    const natural = node.scrollWidth
    const ratio = natural > 0 && scaleX > 0 ? Math.min(1, available / (natural * scaleX)) : 1
    node.style.transform = 'rotate(' + rotation + 'deg) scale(' + scaleX * ratio + ', ' + scaleY * ratio + ')'
  }
  fit()
  cancelAnimationFrame(stylePreviewFrame)
  stylePreviewFrame = requestAnimationFrame(fit)
  document.fonts?.ready?.then(() => {
    cancelAnimationFrame(stylePreviewFrame)
    stylePreviewFrame = requestAnimationFrame(fit)
  })?.catch(() => {})
}

function refreshInspectorPreview(projectChanged = false) {
  const draft = !$('styles-panel').hidden && readStylePreview?.()
  const key = draft ? JSON.stringify([draft.id, draft.fields]) : ''
  let nextCueText
  if (!$('cue-panel').hidden && cueDrafts.has(selected)) {
    const cue = findCue(project, selected)
    const text = $('cue-text').value.replace(/\r\n?/g, '\n')
    if (cue && text !== cue.text) {
      const track = trackFor(cue.id)
      nextCueText = { id: cue.id, trackId: track.id, text }
    }
  }
  const styleChanged = key !== previewDraftKey
  const cueChanged = nextCueText?.id !== previewCueText?.id || nextCueText?.text !== previewCueText?.text
  if (!projectChanged && !styleChanged && !cueChanged) return
  previewDraftKey = key
  previewCueText = nextCueText
  previewStyles = draft ? project.styles.map(style => style.id === draft.id ? draft : style) : project.styles
  if (draft) applyStylePreview(draft)
  assPreview.sync(assLayers(project.tracks, previewStyles,
    project.settings, Math.ceil(mediaDuration / 10) * 10, nextCueText))
  updatePreview()
}

function renderStyleList(projectChanged = false) {
  const styles = project.styles
  const nameCounts = new Map()
  for (const style of styles) {
    const name = styleName(style)
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  const style = styleFor(selectedStyle)
  const list = $('styles-list')
  const editor = $('style-editor')
  list.hidden = $('style-list-header').hidden = Boolean(style)
  editor.hidden = !style
  editor.replaceChildren()
  readStylePreview = undefined
  if (!style) {
    list.replaceChildren(...styles.map(item => {
      const name = styleName(item)
      const row = element('div', 'style-list-item')
      row.setAttribute('role', 'listitem')
      const property = key => field(item.fields, key)?.trim()
      const preview = element('span', 'style-sample')
      const text = element('span', '', '文本Aa')
      const alignment = Number(property('Alignment')) || 2
      preview.style.justifyContent = ['flex-start', 'center', 'flex-end'][(alignment - 1) % 3]
      preview.style.alignItems = ['flex-end', 'center', 'flex-start'][Math.floor((alignment - 1) / 3)]
      text.style.fontFamily = property('Fontname') || ''
      // 样例块只有 64 像素宽，字号上限压到 16 像素，避免大字号样式把文字裁掉。
      text.style.fontSize = Math.max(9, Math.min(16, (Number(property('Fontsize')) || 36) / 2.9)) + 'px'
      text.style.color = cssAssColor(property('PrimaryColour'))
      text.style.webkitTextStroke = Math.min(2, Math.max(0, Number(property('Outline')) || 0) / 3) + 'px ' + cssAssColor(property('OutlineColour'))
      text.style.fontWeight = Number(property('Bold')) ? 'bold' : 'normal'
      text.style.fontStyle = Number(property('Italic')) ? 'italic' : 'normal'
      text.style.textDecoration = [Number(property('Underline')) && 'underline', Number(property('StrikeOut')) && 'line-through'].filter(Boolean).join(' ')
      text.style.transform = `rotate(${-(Number(property('Angle')) || 0)}deg) scale(${(Number(property('ScaleX')) || 100) / 100}, ${(Number(property('ScaleY')) || 100) / 100})`
      text.style.letterSpacing = (Number(property('Spacing')) || 0) / 3 + 'px'
      const shadow = (Number(property('Shadow')) || 0) / 3
      text.style.textShadow = shadow > 0 ? `${shadow}px ${shadow}px ${cssAssColor(property('BackColour'))}` : 'none'
      preview.append(text)
      const label = element('span', 'style-list-name', name)
      row.title = name
      if (nameCounts.get(name) > 1) {
        const index = project.tracks.findIndex(track => track.id === item.trackId)
        const source = index < 0 ? '工程样式' : `${trackLabel(project.tracks[index])} · ${project.tracks[index].ass?.sourceName ?? project.tracks[index].name}`
        label.append(element('small', 'style-list-source', source))
        row.title = `${name} · ${source}`
      }
      const font = element('span', 'style-list-font', property('Fontname') || '未设置')
      font.title = font.textContent
      const actions = element('div', 'style-row-actions')
      actions.append(
        styleButton('pencil', '编辑', () => openStyle(item.id)),
        styleButton('copy', '复制', () => createStyle(item)),
        styleDeleteButton(item),
      )
      row.append(preview, label, font, element('span', 'style-list-size', property('Fontsize') || '-'), actions)
      return row
    }))
    if (!styles.length) list.append(element('p', 'muted', '暂无样式'))
    refreshInspectorPreview(projectChanged)
    return
  }
  const form = element('form', 'style-form')
  const inputs = new Map()
  for (const [heading, fields] of styleSections) {
    const section = element('fieldset', 'style-section')
    section.append(element('legend', '', heading))
    const grid = element('div', 'columns')
    for (const [key, title, type] of fields) {
      const control = styleControl(key, title, type, field(style.fields, key)?.trim())
      inputs.set(key, control.input)
      grid.append(control.wrapper)
    }
    section.append(grid)
    form.append(section)
  }
  const actions = element('div', 'dialog-actions style-actions')
  const back = styleButton('back', '返回样式列表', () => openStyle(undefined))
  const discard = element('button', 'discard-draft', '取消修改')
  discard.type = 'button'
  const apply = element('button', 'primary', '保存')
  apply.type = 'submit'
  // 删除是破坏性操作，和右侧的取消/保存分开，避免误点。
  const head = element('div', 'style-editor-head')
  head.append(back, element('strong', 'style-editor-name', styleName(style)), styleDeleteButton(style))
  const tail = element('div', 'style-editor-tail')
  tail.append(discard, apply)
  actions.append(head, tail)
  form.prepend(actions)
  const preview = element('div', 'style-preview')
  preview.append(element('span', 'style-preview-text', 'SubX字幕样式预览Aa'))
  actions.after(preview)
  form.addEventListener('submit', event => {
    event.preventDefault()
    const name = inputs.get('Name').value.trim()
    const font = inputs.get('Fontname').value.trim()
    if (!name || !font || /[,\r\n\0]/.test(name + font)) {
      status('名称和字体不能为空或包含逗号。')
      return
    }
    const previousName = styleName(style)
    const conflicts = name !== previousName && project.styles.some(item =>
      item.id !== style.id && styleName(item).toLowerCase() === name.toLowerCase())
    if (conflicts) {
      status('样式名称必须全工程唯一。')
      return
    }
    const cueEdits = []
    if (name !== previousName) {
      const controls = [...$('cue-form').querySelectorAll('input,textarea,select')]
      const textIndex = controls.indexOf($('cue-text'))
      const styleIndex = controls.indexOf($('cue-style'))
      const renamingDefault = previousName.toLowerCase() === 'default'
      for (const cue of assStyleResetCues(project, style)) {
        const draft = cueDrafts.get(cue.id)
        const draftText = draft?.get(textIndex)
        if ((draftText !== undefined && renameAssStyleReset(draftText, previousName, name) !== draftText) ||
            (renamingDefault && draft?.get(styleIndex) === '')) {
          status('请先应用或取消含此样式引用的字幕草稿。')
          return
        }
        const text = renameAssStyleReset(cue.text, previousName, name)
        const keepDefault = renamingDefault && (cue.style === undefined || cue.style === null)
        if (text !== cue.text || keepDefault) cueEdits.push({ cue, text, keepDefault })
      }
      if (cueEdits.some(({ cue, text }) => cue.text !== text) && /[\\{}()\0]/.test(name)) {
        status('行内引用的样式名称不能包含反斜杠、括号或空字符。')
        return
      }
    }
    edit(() => {
      styleDrafts.delete(style.id)
      for (const { cue, text, keepDefault } of cueEdits) {
        cue.text = text
        if (keepDefault) cue.style = style.id
      }
      for (const [key, input] of inputs) {
        const old = field(style.fields, key)
        const value = styleFieldValue(input, old)
        if (value !== old?.trim()) setField(style.fields, key, value)
      }
    })
    status('已保存样式')
    // 保存后回到样式列表，避免误以为还在草稿状态。
    openStyle(undefined)
  })
  editor.append(form)
  applyStylePreview(style)
  bindDraft(form, styleDrafts, style.id, renderStyleList)
  readStylePreview = () => {
    let fields
    for (const [key, input] of inputs) {
      // Keep the committed name so ASS inline style references still resolve.
      if (key === 'Name') continue
      const controls = input.type === 'color' ? [...input.parentElement.querySelectorAll('input')] : [input]
      if (controls.some(control => !control.validity.valid)) continue
      const old = field(style.fields, key)
      const value = styleFieldValue(input, old)
      if (!value || value === old?.trim() || (key === 'Fontname' && /[,\r\n]/.test(value))) continue
      fields ??= { ...style.fields }
      setField(fields, key, value)
    }
    return fields && { ...style, fields }
  }
  let previewFrame = 0
  function schedulePreview() {
    if (previewFrame) return
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0
      if (form.isConnected) refreshInspectorPreview()
    })
  }
  form.addEventListener('input', schedulePreview)
  form.addEventListener('change', schedulePreview)
  refreshInspectorPreview(projectChanged)
}

function openStyle(id) {
  selectedStyle = id
  $('styles-panel').scrollTop = 0
  renderStyleList()
  if (id) $('style-editor').querySelector('input')?.focus({ preventScroll: true })
}

function styleButton(symbol, label, callback) {
  const button = element('button', 'style-icon-button')
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.append(icon(symbol))
  button.addEventListener('click', callback)
  return button
}

function styleDeleteButton(style) {
  const button = styleButton('trash', '删除', () => {
    const bounds = button.getBoundingClientRect()
    popup.style.left = Math.max(8, bounds.right - 220) + 'px'
    const below = bounds.bottom + 5
    popup.style.top = (below + 92 <= window.innerHeight ? below : bounds.top - 92) + 'px'
    popup.showPopover()
    cancel.focus()
  })
  button.classList.add('style-delete')
  button.setAttribute('aria-haspopup', 'dialog')
  const popup = element('div', 'style-delete-confirm')
  popup.popover = 'auto'
  popup.setAttribute('role', 'dialog')
  popup.setAttribute('aria-label', '确认删除样式')
  const actions = element('div', 'dialog-actions')
  const cancel = element('button', '', '取消')
  const confirm = element('button', 'style-delete', '删除')
  cancel.type = confirm.type = 'button'
  cancel.addEventListener('click', () => { popup.hidePopover(); button.focus() })
  confirm.addEventListener('click', () => {
    popup.hidePopover()
    deleteStyle(style)
  })
  actions.append(cancel, confirm)
  popup.append(element('div', '', `删除「${styleName(style)}」？`), actions)
  const wrapper = element('span', 'style-delete-wrap')
  wrapper.append(button, popup)
  return wrapper
}

function deleteStyle(style) {
  const name = styleName(style)
  const controls = [...$('cue-form').querySelectorAll('input,textarea,select')]
  const textIndex = controls.indexOf($('cue-text'))
  const styleIndex = controls.indexOf($('cue-style'))
  const resetCues = new Set(assStyleResetCues(project, style))
  const cueEdits = project.tracks.flatMap(track => track.cues.flatMap(cue => {
    const usesStyle = cue.style === style.id ||
      (track.ass && !cue.style && fallbackAssStyle(track, cue, project.styles)?.id === style.id)
    const text = resetCues.has(cue) ? renameAssStyleReset(cue.text, name, '') : cue.text
    return usesStyle || text !== cue.text ? [{ track, cue, usesStyle, text }] : []
  }))
  const draftUsesStyle = [...cueDrafts].some(([id, changes]) => {
    if (changes.get(styleIndex) === style.id) return true
    const text = changes.get(textIndex)
    return text !== undefined && resetCues.has(findCue(project, id)) && renameAssStyleReset(text, name, '') !== text
  })
  if (draftUsesStyle || cueEdits.some(({ cue }) => cueDrafts.has(cue.id))) {
    status('请先应用或取消引用此样式的字幕草稿。')
    return
  }
  edit(() => {
    for (const { track, cue, usesStyle, text } of cueEdits) {
      cue.text = text
      if (usesStyle) cue.style = track.ass ? null : undefined
    }
    const owner = project.tracks.find(track => track.id === style.trackId)
    if (owner?.ass) owner.ass.lines[style.line] = ''
    styleDrafts.delete(style.id)
    project.styles = project.styles.filter(item => item.id !== style.id)
    if (selectedStyle === style.id) selectedStyle = undefined
  })
  status('已删除样式，可撤销')
}

function createStyle(source) {
  const base = source ? styleName(source) + ' 副本' : '样式'
  let name = base
  for (let index = 2; project.styles.some(style => styleName(style) === name); index++) name = base + ' ' + index
  const style = newStyle(name, source?.fields)
  edit(() => {
    project.styles.push(style)
    selectedStyle = source ? undefined : style.id
  })
}

function updateSplitPreview() {
  const current = track()
  if (!current) return
  const reverse = $('split-order').value === 'reverse'
  const entries = inspectTrackSplit(project, current)
  const pairs = entries.filter(entry => entry.lines)
  const exceptions = entries.filter(entry => entry.reason)
  $('split-summary').textContent = `${pairs.length} 条可拆分 · ${exceptions.length} 条原文保留在上轨`
  $('split-dialog').querySelector('button[value="confirm"]').disabled = !pairs.length
  const examples = [...pairs.slice(0, 3), ...exceptions.slice(0, 3)].map(({ cue, lines, reason }) => {
    const section = element('div', reason ? 'split-entry split-exception' : 'split-entry')
    const timestamp = `${printTime(cue.start, '.')} – ${printTime(cue.end, '.')}`
    const detail = lines ? `上轨 ${lines[reverse ? 1 : 0]}\n下轨 ${lines[reverse ? 0 : 1]}` : `${reason}\n${cue.text}`
    section.append(element('span', 'split-time', timestamp), element('p', '', detail))
    return section
  })
  $('split-preview').replaceChildren(...examples)
}

async function canDecodeVideo(reference) {
  const candidate = document.createElement('video')
  candidate.preload = 'auto'
  let timer
  try {
    return await new Promise(resolve => {
      candidate.addEventListener('loadeddata', () => resolve(candidate.videoWidth > 0 && candidate.videoHeight > 0), { once: true })
      candidate.addEventListener('error', () => resolve(false), { once: true })
      timer = setTimeout(() => resolve(false), 15000)
      candidate.src = reference.url
    })
  } finally {
    clearTimeout(timer)
    candidate.removeAttribute('src')
    candidate.load()
  }
}

action('open-media', () => withProjectOperation(async () => {
  const reference = await app.chooseMedia()
  if (!reference) return
  status('正在检查 ' + reference.name)
  let accepted = false
  try {
    accepted = await canDecodeVideo(reference)
  } finally {
    if (!await app.finishMediaSelection(reference.token, accepted)) throw new Error('视频选择已失效，请重新选择。')
  }
  if (!accepted) throw new Error(`无法播放 ${reference.name}。请检查文件或尝试 H.264/AAC MP4。`)
  project.media = reference.file
  updateProjectTitle()
  attachVideo(reference)
  status('已打开视频')
  scheduleAutosave()
}))

// —— 空白视频选项 ——
const blankRatios = [['16:9', 16, 9], ['4:3', 4, 3], ['3:2', 3, 2], ['1:1', 1, 1], ['21:9', 21, 9]]
const blankHeights = [480, 720, 1080, 1440, 2160]
const blankFps = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120]
const evenSize = value => Math.round(value / 2) * 2
function fillBlankVideoOptions() {
  const form = $('blank-video-form')
  const resolution = form.elements.resolution
  resolution.replaceChildren()
  for (const [ratio, ratioWidth, ratioHeight] of blankRatios) {
    for (const orientation of ['横屏', '竖屏']) {
      if (ratio === '1:1' && orientation === '竖屏') continue
      const group = element('optgroup')
      group.label = ratio + ' · ' + orientation
      for (const height of blankHeights) {
        const long = evenSize(height * ratioWidth / ratioHeight)
        const width = orientation === '横屏' ? long : height
        const tall = orientation === '横屏' ? height : long
        group.append(new Option(width + ' × ' + tall + ' · ' + height + 'p', width + 'x' + tall))
      }
      resolution.append(group)
    }
  }
  form.elements.fps.replaceChildren(...blankFps.map(value => new Option(String(value), String(value))))
}
function setupPickers() {
  for (const picker of document.querySelectorAll('[data-picker]')) {
    const select = picker.querySelector('select')
    const button = picker.querySelector('.picker-button')
    const list = picker.querySelector('.picker-list')
    const close = () => {
      list.hidden = true
      button.setAttribute('aria-expanded', 'false')
    }
    const itemFor = option => {
      const item = element('button', '', option.textContent)
      item.type = 'button'
      item.setAttribute('role', 'option')
      item.dataset.value = option.value
      item.addEventListener('click', () => {
        select.value = option.value
        select.dispatchEvent(new Event('change', { bubbles: true }))
        close()
      })
      return item
    }
    const items = []
    for (const node of select.children) {
      if (node.tagName === 'OPTGROUP') {
        items.push(element('div', 'picker-group', node.label))
        for (const option of node.children) items.push(itemFor(option))
      } else {
        items.push(itemFor(node))
      }
    }
    list.replaceChildren(...items)
    const refresh = () => {
      button.textContent = select.selectedOptions[0]?.textContent ?? ''
      for (const item of list.querySelectorAll('button')) {
        item.setAttribute('aria-selected', String(item.dataset.value === select.value))
      }
    }
    button.addEventListener('click', event => {
      event.preventDefault()
      const open = list.hidden
      list.hidden = !open
      button.setAttribute('aria-expanded', String(open))
      if (!open) return
      refresh()
      list.querySelector('button[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    })
    picker.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !list.hidden) {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    })
    document.addEventListener('pointerdown', event => {
      if (!picker.contains(event.target)) close()
    }, true)
    select.addEventListener('change', refresh)
    picker.refreshPicker = refresh
    refresh()
  }
}
fillBlankVideoOptions()
setupPickers()

const blankVideoDialog = $('blank-video-dialog')
action('blank-video', () => {
  if (projectBusy) return
  const form = $('blank-video-form')
  form.reset()
  form.elements.resolution.value = '1920x1080'
  form.elements.fps.value = '30'
  form.elements.duration.value = '60'
  form.elements.color.value = '#000000'
  for (const picker of blankVideoDialog.querySelectorAll('[data-picker]')) picker.refreshPicker?.()
  blankVideoDialog.returnValue = 'cancel'
  blankVideoDialog.showModal()
})
blankVideoDialog.addEventListener('close', () => {
  if (blankVideoDialog.returnValue !== 'create') return
  const data = new FormData($('blank-video-form'))
  const [width, height] = String(data.get('resolution')).split('x').map(Number)
  const media = createSolidMedia({
    color: String(data.get('color')),
    width,
    height,
    fps: Number(data.get('fps')),
    duration: Math.round(Number(data.get('duration')) * 1000),
  })
  if (!isSolidMedia(media)) {
    status('空白视频设置无效')
    return
  }
  void withProjectOperation(async () => {
    project.media = media
    updateProjectTitle()
    attachVideo(null)
    status('已添加空白视频 · ' + media.width + '×' + media.height + ' · ' + media.fps + ' fps')
    scheduleAutosave()
  }).catch(error => status(errorText(error), 'error'))
})

// —— 整体平移 ——
const shiftDialog = $('shift-dialog')

function shiftScopeCues() {
  const scope = $('shift-scope').value
  if (scope === 'selected') {
    const result = []
    for (const id of selectedCueIds()) {
      const owner = trackFor(id)
      const cue = findCue(project, id)
      if (owner && cue && !owner.locked) result.push({ owner, cue })
    }
    return { cues: result, skipped: 0 }
  }
  if (scope === 'all') {
    const result = []
    let skipped = 0
    for (const owner of project.tracks) {
      if (owner.locked) {
        skipped += 1
        continue
      }
      for (const cue of owner.cues) result.push({ owner, cue })
    }
    return { cues: result, skipped }
  }
  const owner = track()
  if (!owner) return { cues: [], skipped: 0 }
  if (owner.locked) return { cues: [], skipped: 1, locked: true }
  return { cues: owner.cues.map(cue => ({ owner, cue })), skipped: 0 }
}

function shiftDeltaValue() {
  if ($('shift-mode').value === 'frames') {
    const frames = Number($('shift-frames').value)
    if (!Number.isInteger(frames)) return { error: '请输入整数帧数。' }
    const fps = Number.isFinite(frameGap) && frameGap > 0 ? 1000 / frameGap : rulerFps()
    if (!fps) return { error: '当前工程没有帧率信息，无法按帧平移。' }
    return { delta: Math.round(frames * 1000 / fps), frames, fps: Math.round(fps * 1000) / 1000 }
  }
  const value = $('shift-time').value.trim()
  const match = value.match(/^([+-]?)(\d{1,}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/)
  if (!match) return { error: '时间格式应为 +00:00:00.500 或 -00:00:01.000。' }
  const minutes = Number(match[3])
  const seconds = Number(match[4])
  if (minutes > 59 || seconds > 59) return { error: '分和秒必须在 0–59 之间。' }
  const milliseconds = ((Number(match[2]) * 60 + minutes) * 60 + seconds) * 1000 +
    Number((match[5] ?? '').padEnd(3, '0'))
  return { delta: (match[1] === '-' ? -1 : 1) * milliseconds }
}

function formatOffset(value) {
  return (value < 0 ? '-' : '+') + printTime(Math.abs(value), '.')
}

function showShiftError(message) {
  $('shift-error').textContent = message
  $('shift-error').hidden = false
}

function updateShiftPreview() {
  $('shift-error').hidden = true
  const mode = $('shift-mode').value
  $('shift-time-field').hidden = mode !== 'time'
  $('shift-frame-field').hidden = mode !== 'frames'
  const { cues, skipped, locked } = shiftScopeCues()
  if (locked) {
    $('shift-summary').textContent = '当前轨道已锁定，解锁后再平移。'
    return
  }
  if (!cues.length) {
    $('shift-summary').textContent = skipped ? '当前范围内没有可平移的字幕（锁定轨道已跳过）。' : '当前范围内没有字幕。'
    return
  }
  const parsed = shiftDeltaValue()
  if (parsed.error) {
    showShiftError(parsed.error)
    $('shift-summary').textContent = ''
    return
  }
  const applied = clampShiftDelta(cues.map(({ cue }) => cue), parsed.delta)
  const adjusted = applied !== parsed.delta
  if (!applied) {
    $('shift-summary').textContent = adjusted
      ? '请求的偏移会早于最早起点，整体钳到 0 后没有可移动空间。'
      : '偏移量为 0，不会改变字幕。'
    return
  }
  const earliest = cues.reduce((min, { cue }) => Math.min(min, cue.start), Infinity)
  const parts = ['将平移 ' + cues.length + ' 条字幕 · ' + formatOffset(applied)]
  if (adjusted) parts.push('（请求 ' + formatOffset(parsed.delta) + '，为保持相对时间整体钳到最早起点）')
  if (mode === 'frames') parts.push(' · ' + parsed.frames + ' 帧 @ ' + parsed.fps + ' fps')
  if (skipped) parts.push(' · 已跳过 ' + skipped + ' 条锁定轨道')
  const shiftedIds = new Set(cues.map(({ cue }) => cue.id))
  const crossing = cues.some(({ cue }) => (project.links.find(pair => pair.includes(cue.id)) ?? [])
    .some(id => !shiftedIds.has(id)))
  if (crossing) parts.push(' · 跨轨链接的对端不会移动')
  parts.push(' · 最早起点 ' + printTime(earliest, '.'))
  $('shift-summary').textContent = parts.join('')
}

action('menu-shift', () => {
  closeFindPanel()
  const form = $('shift-form')
  form.reset()
  $('shift-mode').value = 'time'
  $('shift-scope').value = selectedCueIds().length ? 'selected' : 'track'
  $('shift-time').value = '+00:00:00.500'
  $('shift-frames').value = '0'
  const owner = track()
  $('shift-scope').options[0].textContent = owner ? '当前轨道（' + trackLabel(owner) + '）' : '当前轨道'
  updateShiftPreview()
  shiftDialog.showModal()
  $('shift-time').focus({ preventScroll: true })
  $('shift-time').select()
})
for (const id of ['shift-time', 'shift-frames']) $(id).addEventListener('input', updateShiftPreview)
for (const id of ['shift-mode', 'shift-scope']) $(id).addEventListener('change', updateShiftPreview)
$('shift-cancel').addEventListener('click', () => shiftDialog.close())
$('shift-form').addEventListener('submit', event => {
  event.preventDefault()
  const { cues, skipped, locked } = shiftScopeCues()
  if (locked) {
    showShiftError('当前轨道已锁定，解锁后再平移。')
    return
  }
  if (!cues.length) {
    showShiftError('当前范围内没有可平移的字幕。')
    return
  }
  const parsed = shiftDeltaValue()
  if (parsed.error) {
    showShiftError(parsed.error)
    return
  }
  const applied = clampShiftDelta(cues.map(({ cue }) => cue), parsed.delta)
  const adjusted = applied !== parsed.delta
  if (!applied) {
    status(adjusted
      ? '请求的偏移超出最早起点，整体钳到 0 后没有修改字幕。'
      : '偏移量为 0，没有修改字幕。', 'warn')
    return
  }
  edit(() => {
    for (const { cue } of cues) {
      const next = shiftTiming(cue, applied)
      cue.start = next.start
      cue.end = next.end
    }
  })
  shiftDialog.close()
  status('已整体平移 ' + cues.length + ' 条字幕 · ' + formatOffset(applied) +
    (adjusted ? ' · 请求值已钳到最早起点' : '') +
    (skipped ? ' · 跳过 ' + skipped + ' 条锁定轨道' : ''), 'success')
})

// —— 查找与替换 ——
const findPanel = $('find-panel')
let findMatches = []
let findIndex = -1
let findTimer = 0
let findSignature = ''

function findOptions() {
  return { regex: $('find-regex').checked, caseSensitive: $('find-case').checked }
}
function findStateSignature() {
  return JSON.stringify([$('find-query').value, $('find-case').checked, $('find-regex').checked,
    $('find-tags').checked, $('find-scope').value])
}
function resolveFindMatch(match) {
  const cue = findCue(project, match.cueId)
  if (!cue) return null
  const owner = trackFor(cue.id)
  if (!owner) return null
  if (cue.text.slice(match.index, match.index + match.length) !== match.text) return null
  return { owner, cue }
}
function findMaskFor(owner, cue) {
  return $('find-tags').checked && Boolean(owner.ass || cue.assText)
}
function findScopeCues() {
  const scope = $('find-scope').value
  if (scope === 'selected') {
    const result = []
    for (const id of selectedCueIds()) {
      const owner = trackFor(id)
      const cue = findCue(project, id)
      if (owner && cue && !owner.locked) result.push({ owner, cue })
    }
    return result
  }
  const owners = scope === 'all' ? project.tracks : [track()].filter(Boolean)
  const result = []
  for (const owner of owners) {
    if (owner.locked) continue
    for (const cue of owner.cues) result.push({ owner, cue })
  }
  return result
}
function setFindError(message) {
  $('find-error').textContent = message
  $('find-error').hidden = false
}
function clearFindError() {
  $('find-error').hidden = true
  $('find-error').textContent = ''
}
function updateFindSummary() {
  if (!findMatches.length || findIndex < 0) return
  const match = findMatches[findIndex]
  $('find-summary').textContent = '第 ' + (findIndex + 1) + ' / ' + findMatches.length +
    ' 个匹配 · ' + trackLabel(match.owner) + ' · ' + printTime(match.cue.start, '.')
}
function runFind({ reset = true, navigate = false } = {}) {
  clearFindError()
  findSignature = findStateSignature()
  const query = $('find-query').value
  if (!query) {
    findMatches = []
    findIndex = -1
    $('find-summary').textContent = '输入查找内容后按 Enter 查找。'
    return
  }
  const entries = findScopeCues()
  if (!entries.length) {
    findMatches = []
    findIndex = -1
    $('find-summary').textContent = '当前范围内没有可查找的字幕。'
    return
  }
  const options = findOptions()
  const matches = []
  try {
    for (const { owner, cue } of entries) {
      const maskTags = findMaskFor(owner, cue)
      for (const match of findTextMatches(cue.text, query, { ...options, maskTags })) {
        matches.push({ owner, cue, cueId: cue.id, index: match.index, length: match.length, text: match.text })
      }
    }
  } catch (error) {
    findMatches = []
    findIndex = -1
    setFindError('正则表达式无效：' + error.message)
    $('find-summary').textContent = ''
    return
  }
  findMatches = matches
  if (!matches.length) {
    findIndex = -1
    $('find-summary').textContent = '没有匹配。'
    return
  }
  findIndex = reset ? 0 : Math.min(findIndex, matches.length - 1)
  updateFindSummary()
  if (navigate) focusFindMatch(findIndex)
}
function focusFindMatch(index) {
  if (!findMatches.length) return
  findIndex = (index + findMatches.length) % findMatches.length
  const match = findMatches[findIndex]
  const resolved = resolveFindMatch(match)
  if (!resolved) {
    runFind({ reset: false })
    if (!findMatches.length) {
      setFindError('匹配位置已变化，请重新查找。')
      return
    }
    focusFindMatch(findIndex)
    return
  }
  // 查找定位是只读操作；先退出链接工具，避免 pick() 意外建立或解除链接。
  if (linkMode) setLinkMode(false)
  pick(resolved.owner, resolved.cue)
  seek(resolved.cue.start)
  revealTimelinePosition(resolved.cue.start)
  renderViewport()
  const field = $('cue-text')
  if (!field.disabled) {
    field.focus({ preventScroll: true })
    field.setSelectionRange(match.index, match.index + match.length)
  }
  updateFindSummary()
}
function openFindPanel() {
  findPanel.hidden = false
  $('find-scope').value = selectedCueIds().length ? 'selected' : 'track'
  clearFindError()
  runFind({ reset: true })
  $('find-query').focus({ preventScroll: true })
  $('find-query').select()
}
function closeFindPanel() {
  findPanel.hidden = true
  findMatches = []
  findIndex = -1
  clearTimeout(findTimer)
  clearFindError()
}
action('menu-find', () => {
  if (findPanel.hidden) openFindPanel()
  else {
    $('find-query').focus({ preventScroll: true })
    $('find-query').select()
  }
})
$('find-close').addEventListener('click', closeFindPanel)
$('find-query').addEventListener('input', () => {
  clearTimeout(findTimer)
  findTimer = setTimeout(() => runFind({ reset: true }), 120)
})
$('find-query').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  clearTimeout(findTimer)
  runFind({ reset: true, navigate: true })
})
for (const id of ['find-scope', 'find-case', 'find-regex', 'find-tags']) {
  $(id).addEventListener('change', () => runFind({ reset: true }))
}
function navigateFind(direction) {
  clearTimeout(findTimer)
  const changed = findSignature !== findStateSignature()
  if (changed) runFind({ reset: true })
  if (findMatches.length) focusFindMatch(changed ? findIndex : findIndex + direction)
}
$('find-prev').addEventListener('click', () => navigateFind(-1))
$('find-next').addEventListener('click', () => navigateFind(1))
$('find-replace-one').addEventListener('click', () => {
  clearTimeout(findTimer)
  if (findSignature !== findStateSignature()) {
    runFind({ reset: true })
  }
  if (!findMatches.length || findIndex < 0) {
    status('请先查找并定位一个匹配。', 'warn')
    return
  }
  const match = findMatches[findIndex]
  const resolved = resolveFindMatch(match)
  if (!resolved) {
    runFind({ reset: false })
    if (!findMatches.length) setFindError('匹配位置已变化，请重新查找。')
    return
  }
  const { owner, cue } = resolved
  try {
    const result = replaceTextAt(cue.text, $('find-query').value, $('find-replacement').value,
      match.index, { ...findOptions(), maskTags: findMaskFor(owner, cue) })
    if (!result.count) {
      setFindError('匹配位置已变化，请重新查找。')
      return
    }
    if (!owner.ass && !cue.assText && hasEmptyLine(result.text)) {
      setFindError('替换结果会产生空行；SRT 用空行分隔条目，已取消这次替换。')
      return
    }
    cueDrafts.delete(cue.id)
    edit(() => { cue.text = result.text })
  } catch (error) {
    setFindError('替换失败：' + error.message)
    return
  }
  status('已替换 1 处', 'success')
  runFind({ reset: false })
  if (findMatches.length) focusFindMatch(findIndex)
})
$('find-replace-all').addEventListener('click', () => {
  const query = $('find-query').value
  if (!query) {
    setFindError('请输入查找内容。')
    return
  }
  const options = findOptions()
  const replacement = $('find-replacement').value
  const changes = []
  let count = 0
  let skipped = 0
  try {
    for (const { owner, cue } of findScopeCues()) {
      const result = replaceTextMatches(cue.text, query, replacement,
        { ...options, maskTags: findMaskFor(owner, cue) })
      if (!result.count) continue
      if (!owner.ass && !cue.assText && hasEmptyLine(result.text)) {
        skipped += 1
        continue
      }
      changes.push({ cue, text: result.text })
      count += result.count
    }
  } catch (error) {
    setFindError('正则表达式无效：' + error.message)
    return
  }
  if (!count) {
    status(skipped ? '替换结果会产生空行，已跳过 ' + skipped + ' 条字幕。' : '没有匹配，未做修改。', 'warn')
    return
  }
  for (const change of changes) cueDrafts.delete(change.cue.id)
  edit(() => {
    for (const change of changes) change.cue.text = change.text
  })
  status('已替换 ' + count + ' 处' + (skipped ? ' · 跳过 ' + skipped + ' 条会产生空行的字幕' : ''), 'success')
  runFind({ reset: true })
})
findPanel.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closeFindPanel()
})
// 打开任何模态对话框时收起查找浮层，避免结果面板留在遮罩后面。
const findDialogObserver = new MutationObserver(() => {
  if (!findPanel.hidden && document.querySelector('dialog[open]')) closeFindPanel()
})
for (const dialog of document.querySelectorAll('dialog')) {
  findDialogObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] })
}

// —— 质量检查 ——
const qcTypeLabels = {
  cps: '语速', short: '过短', long: '过长', empty: '空正文',
  trailing: '行尾空格', blank: '空行', overlap: '重叠', punctuation: '标点',
}

function renderQcPanel() {
  if ($('qc-panel').hidden) return
  const settings = qcSettings(project)
  $('qc-cps').value = String(settings.cps)
  $('qc-min').value = String(settings.minDuration / 1000)
  $('qc-max').value = String(settings.maxDuration / 1000)
  const { issues, counts } = analyzeProject(project, settings)
  const detail = Object.entries(counts).map(([type, count]) => (qcTypeLabels[type] ?? type) + ' ' + count).join(' · ')
  $('qc-summary').textContent = issues.length ? issues.length + ' 个问题 · ' + detail : '没有发现问题'
  $('qc-count').hidden = !issues.length
  $('qc-count').textContent = issues.length > 99 ? '99+' : String(issues.length)
  $('qc-empty').hidden = issues.length > 0
  $('qc-fix-trailing').disabled = !counts.trailing
  $('qc-fix-short').disabled = !counts.short
  $('qc-fix-split').disabled = !counts.long
  const rows = []
  for (const issue of issues.slice(0, 200)) {
    const owner = project.tracks.find(track => track.id === issue.trackId)
    if (!owner) continue
    const row = element('button', 'qc-issue')
    row.type = 'button'
    const badge = element('span', 'qc-badge ' + issue.type, qcTypeLabels[issue.type] ?? issue.type)
    const text = element('span', 'qc-issue-text', issue.message)
    const meta = element('span', 'qc-issue-meta', trackLabel(owner) + ' · ' + printTime(issue.start, '.'))
    row.append(badge, text, meta)
    row.addEventListener('click', () => locateQcIssue(issue))
    rows.push(row)
  }
  if (issues.length > 200) rows.push(element('p', 'muted', '其余 ' + (issues.length - 200) + ' 条未列出，请先修复当前问题。'))
  $('qc-list').replaceChildren(...rows)
}

function locateQcIssue(issue) {
  const cue = findCue(project, issue.cueId)
  const owner = cue && trackFor(cue.id)
  if (!cue || !owner) {
    renderQcPanel()
    return
  }
  if (owner.locked) {
    status('轨道已锁定，解锁后可定位', 'warn')
    return
  }
  if (linkMode) setLinkMode(false)
  pick(owner, cue)
  seek(cue.start)
  revealTimelinePosition(cue.start)
  renderViewport()
  switchTab('qc')
}

function runQcFix(fix, label) {
  if (hasPendingForm() || editorOpen()) {
    status('请先应用或取消字幕修改，再批量修复', 'warn')
    return
  }
  let result
  edit(() => { result = fix() })
  const skipped = result.skipped ? ' · 跳过 ' + result.skipped + ' 条' : ''
  status(label + '：' + result.fixed + ' 条' + skipped, result.fixed ? 'success' : 'warn')
}

function applyQcThreshold(key, value) {
  const next = { ...qcSettings(project) }
  if (!Number.isFinite(value)) {
    renderQcPanel()
    return
  }
  if (key === 'cps') next.cps = Math.max(1, Math.min(60, Math.round(value)))
  if (key === 'minDuration') next.minDuration = Math.max(0, Math.min(10000, Math.round(value)))
  if (key === 'maxDuration') next.maxDuration = Math.max(1000, Math.min(60000, Math.round(value)))
  if (next.maxDuration < next.minDuration) {
    status('最长时长不能短于最短时长', 'warn')
    renderQcPanel()
    return
  }
  edit(() => {
    project.settings = { fade: false, watermark: false, fadeDuration: 100, ...project.settings, qc: next }
  })
}

action('qc-tab', () => switchTab('qc'))
action('qc-refresh', () => renderQcPanel())
action('qc-fix-trailing', () => runQcFix(() => fixTrailingSpaces(project), '已去除行尾空格'))
action('qc-fix-short', () => runQcFix(() => extendShortCues(project), '已延长过短字幕'))
action('qc-fix-split', () => runQcFix(() => splitLongCues(project), '已拆分过长字幕'))
$('qc-cps').addEventListener('change', event => applyQcThreshold('cps', Number(event.target.value)))
$('qc-min').addEventListener('change', event => applyQcThreshold('minDuration', Number(event.target.value) * 1000))
$('qc-max').addEventListener('change', event => applyQcThreshold('maxDuration', Number(event.target.value) * 1000))

// —— 文稿打轴 ——
const scriptDialog = $('script-dialog')
function parseScriptText(text, bilingual) {
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const lines = []
  if (bilingual) {
    for (let index = 0; index < rows.length; index += 2) {
      lines.push({ id: crypto.randomUUID(), text: rows[index], second: rows[index + 1] ?? '' })
    }
  } else {
    for (const row of rows) lines.push({ id: crypto.randomUUID(), text: row, second: null })
  }
  return lines
}
function scriptCueMap() {
  const map = new Map()
  for (const track of project.tracks) {
    for (const cue of track.cues) {
      if (!cue.scriptLine) continue
      const list = map.get(cue.scriptLine) ?? []
      list.push({ track, cue })
      map.set(cue.scriptLine, list)
    }
  }
  return map
}
function nextScriptIndex(from = 0) {
  const lines = project.script?.lines ?? []
  const punched = scriptCueMap()
  for (let step = 0; step < lines.length; step++) {
    const index = (Math.max(0, from) + step) % lines.length
    if (!punched.has(lines[index].id)) return index
  }
  return lines.length
}
function renderScriptPanel() {
  const script = project.script
  const list = $('script-list')
  const progress = $('script-progress')
  if (!script?.lines.length) {
    progress.textContent = '未导入文稿'
    $('script-hint').hidden = false
    list.replaceChildren()
    return
  }
  $('script-hint').hidden = true
  const punched = scriptCueMap()
  progress.textContent = punched.size + ' / ' + script.lines.length + ' 行已打轴'
  const items = script.lines.map((line, index) => {
    const item = element('li', 'script-line')
    item.dataset.index = String(index)
    if (index === scriptIndex) item.classList.add('current')
    const cues = punched.get(line.id) ?? []
    if (cues.length) item.classList.add('punched')
    const text = element('span', 'script-text', line.text)
    if (script.bilingual) text.append(element('small', '', line.second || '（缺译文）'))
    const time = cues.length ? printTime(cues[0].cue.start, '.') + ' – ' + printTime(cues[0].cue.end, '.') : ''
    item.append(element('span', 'script-index', String(index + 1)), text, element('span', 'script-time', time))
    item.addEventListener('click', () => {
      if (punch) finishPunch()
      scriptIndex = index
      renderScriptPanel()
    })
    return item
  })
  list.replaceChildren(...items)
  const current = list.querySelector('.script-line.current')
  if (current && $('script-tab').getAttribute('aria-selected') === 'true') current.scrollIntoView({ block: 'nearest' })
}
function openScriptDialog() {
  if (projectBusy) return
  $('script-form').reset()
  $('script-order-label').hidden = true
  $('script-dialog-error').hidden = true
  scriptDialog.returnValue = 'cancel'
  scriptDialog.showModal()
}
action('import-script', openScriptDialog)
action('script-import', openScriptDialog)
$('script-form').addEventListener('change', event => {
  if (event.target.name === 'mode') $('script-order-label').hidden = event.target.value !== 'bilingual'
})
scriptDialog.addEventListener('close', () => {
  if (scriptDialog.returnValue !== 'choose') return
  const data = new FormData($('script-form'))
  const bilingual = data.get('mode') === 'bilingual'
  const order = bilingual && data.get('order') === 'reverse' ? 'reverse' : 'first'
  void withProjectOperation(async () => {
    const file = await app.chooseScript()
    if (!file) return
    const lines = parseScriptText(file.text, bilingual)
    if (!lines.length) throw new Error(file.name + ' 没有可用的文稿行。')
    const missing = bilingual ? lines.filter(line => !line.second).length : 0
    if (punch) finishPunch()
    edit(() => {
      project.script = { bilingual, order, lines, tracks: {} }
      scriptIndex = 0
    })
    switchTab('script')
    renderScriptPanel()
    status('已导入 ' + lines.length + ' 行文稿' + (missing ? ' · ' + missing + ' 行缺译文' : ''))
  }).catch(error => status(errorText(error), 'error'))
})
action('script-tab', () => switchTab('script'))
function playheadNow() {
  return isSolid() && solidPlaying ? Math.round(solidElapsed()) : Math.round(time)
}
function punchAvailable() {
  return Boolean(project.script?.lines.length) && hasPicture() &&
    $('script-tab').getAttribute('aria-selected') === 'true' && !switchingProject
}
function ensureScriptTracks() {
  const script = project.script
  const stored = script.tracks ?? {}
  let first = project.tracks.find(track => track.id === stored.first)
  let second = project.tracks.find(track => track.id === stored.second)
  if (!first) {
    first = createTrack(script.bilingual ? '文稿 · 上轨' : '文稿')
    project.tracks.unshift(first)
    script.tracks = { ...stored, first: first.id }
  }
  if (script.bilingual && !second) {
    second = createTrack('文稿 · 下轨')
    project.tracks.splice(project.tracks.indexOf(first) + 1, 0, second)
    script.tracks = { ...script.tracks, second: second.id }
  }
  return { first, second }
}
function beginPunch(key) {
  if (!project.script || !punchAvailable()) return
  if (punch?.key === key) return
  let start = playheadNow()
  if (punch) {
    const seam = finishPunch()
    if (seam !== undefined) start = seam
  }
  if (scriptIndex >= project.script.lines.length) {
    status('文稿已全部打轴完成')
    return
  }
  const line = project.script.lines[scriptIndex]
  const order = project.script.order === 'reverse' ? 'reverse' : 'first'
  const created = { cueIds: [] }
  edit(() => {
    for (const { cue } of scriptCueMap().get(line.id) ?? []) removeCue(project, cue.id)
    const { first, second } = ensureScriptTracks()
    const topCue = { id: crypto.randomUUID(), start, end: start + 1, text: order === 'reverse' ? line.second : line.text, scriptLine: line.id }
    first.cues.push(topCue)
    created.cueIds.push(topCue.id)
    if (project.script.bilingual && second) {
      const bottomCue = { id: crypto.randomUUID(), start, end: start + 1, text: order === 'reverse' ? line.text : line.second, scriptLine: line.id }
      second.cues.push(bottomCue)
      project.links.push([topCue.id, bottomCue.id])
      created.cueIds.push(bottomCue.id)
    }
    created.lineIndex = scriptIndex
  })
  punch = { key, lineIndex: created.lineIndex, start, cueIds: created.cueIds }
  if (playbackPaused()) void startPlayback()
  updatePunch()
  status('正在给第 ' + (created.lineIndex + 1) + ' 行打轴，松开 ' + key.toUpperCase() + ' 结束')
}
function updatePunch() {
  if (!punch) return
  const end = Math.max(punch.start + 1, playheadNow())
  for (const id of punch.cueIds) {
    const cue = findCue(project, id)
    if (!cue) continue
    cue.end = end
    const block = rows.find(row => row.buttons.has(id))?.buttons.get(id)
    if (block) block.style.width = Math.max(1, width(cue.end - cue.start)) + 'px'
  }
}
function finishPunch() {
  if (!punch) return undefined
  const active = punch
  punch = null
  const end = Math.max(active.start + 1, playheadNow())
  const aligned = alignCue(editingBoundaries(), active.start, end)
  for (const id of active.cueIds) {
    const cue = findCue(project, id)
    if (cue) Object.assign(cue, { start: aligned.start, end: aligned.end })
  }
  scriptIndex = nextScriptIndex(active.lineIndex + 1)
  render()
  status('第 ' + (active.lineIndex + 1) + ' 行已打轴 · ' + printTime(aligned.start, '.') + ' – ' + printTime(aligned.end, '.'))
  scheduleAutosave()
  return aligned.end
}
function cancelPunch() {
  if (!punch) return
  const active = punch
  punch = null
  const entry = undo.pop()
  if (entry) {
    undoBytes -= entry.bytes ?? 0
    project = entry.project
    revision = entry.revision
    redo.length = 0
    redoBytes = 0
    ensureSelection()
  }
  scriptIndex = active.lineIndex
  render()
  status('已取消第 ' + (active.lineIndex + 1) + ' 行打轴')
  scheduleAutosave()
}
window.addEventListener('keyup', event => {
  if (punch && event.key === punch.key) finishPunch()
})
window.addEventListener('blur', () => { if (punch) finishPunch() })
function updateProjectTitle() {
  const name = projectDocument?.name ?? (projectDisplayName || '未命名工程')
  const modified = dirty() || hasPendingForm()
  $('save-project').title = name + (modified ? '（有未保存修改）' : '')
  const titled = Boolean(projectDocument || projectDisplayName)
  document.title = titled ? name + (modified ? ' ●' : '') + ' · SubX' : 'SubX'
}

async function withProjectOperation(callback) {
  if (projectBusy) return
  projectBusy = true
  const controls = ['new-project', 'open-project', 'recent-projects', 'save-project',
    'save-project-as', 'open-media', 'blank-video', 'import-subtitles', 'import-script', 'script-import',
    'empty-open-media', 'empty-import-subtitles', 'empty-blank-video', 'empty-open-project']
  for (const id of controls) $(id).disabled = true
  try {
    await callback()
  } finally {
    projectBusy = false
    for (const id of controls) $(id).disabled = false
  }
}

function askBeforeChangingProject() {
  const dialog = $('project-change-dialog')
  const pending = hasPendingForm()
  $('project-change-detail').hidden = !pending
  if (pending) dialog.setAttribute('aria-describedby', 'project-change-detail')
  else dialog.removeAttribute('aria-describedby')
  dialog.querySelector('button[value="save"]').disabled = pending
  dialog.returnValue = 'cancel'
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true })
    dialog.showModal()
  })
}

function changeProject(callback) {
  return withProjectOperation(async () => {
    endDrag(drag?.pointer, false)
    closeCueEditor(false)
    const workspace = document.querySelector('.workspace')
    switchingProject = true
    workspace.inert = true
    try {
      if (dirty() || hasPendingForm()) {
        const choice = await askBeforeChangingProject()
        if (choice === 'cancel' || (choice === 'save' && !await writeCurrentProject(false))) return
        // 用户明确放弃旧工程的修改时才清理旧自动保存；保存成功由 writeCurrentProject 清理。
        if (choice === 'discard') clearAutosave()
      }
      await callback()
    } finally {
      switchingProject = false
      workspace.inert = false
    }
  })
}

action('new-project', () => changeProject(() => {
  reset(newWorkspaceProject(), null)
  status('已新建工程')
}))
action('open-project', () => changeProject(async () => openResult(await app.openProject())).catch(error => status(errorText(error), 'error')))
function recentTimeLabel(openedAt) {
  if (!Number.isFinite(openedAt) || openedAt <= 0) return ''
  const date = new Date(openedAt)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const pad = value => String(value).padStart(2, '0')
  const clock = pad(date.getHours()) + ':' + pad(date.getMinutes())
  const sameDay = (left, right) => left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
  if (diff >= 0 && diff < 60000) return '刚刚'
  if (diff >= 0 && diff < 3600000) return Math.max(1, Math.floor(diff / 60000)) + ' 分钟前'
  if (sameDay(date, now)) return '今天 ' + clock
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(date, yesterday)) return '昨天 ' + clock
  if (date.getFullYear() === now.getFullYear()) return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + clock
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + clock
}

action('recent-projects', () => withProjectOperation(async () => {
  const entries = (await app.recentProjects())
    .map(item => typeof item === 'string' ? { file: item, openedAt: 0 } : item)
    .filter(item => item?.file)
  const dialog = $('recent-dialog')
  const rows = entries.map(({ file, openedAt }) => {
    const name = file.split(/[\\/]/).pop()
    const folder = file.slice(0, Math.max(0, file.length - name.length)).replace(/[\\/]$/, '')
    const button = element('button', 'recent-item')
    button.type = 'button'
    button.title = file
    const text = element('div', 'recent-item-text')
    text.append(element('span', 'recent-item-name', name), element('span', 'recent-item-path', folder))
    button.append(text, element('span', 'recent-item-time', recentTimeLabel(openedAt)))
    button.addEventListener('click', () => {
      dialog.close()
      changeProject(async () => openResult(await app.openProject(file))).catch(error => status(errorText(error), 'error'))
    })
    return button
  })
  $('recent-list').replaceChildren(...(rows.length ? rows : [element('p', 'muted', '暂无最近工程')]))
  dialog.showModal()
}))
async function writeCurrentProject(saveAs) {
  if (hasPendingForm()) {
    status('请先应用字幕修改或保存样式，再保存工程。')
    return false
  }
  const saving = { revision, media: project.media }
  const saveId = crypto.randomUUID()
  let saved = false
  let closing
  projectSavePending = true
  try {
    const result = await app.saveProject(project, projectDocument?.id, saveAs, saveId)
    if (result) {
      saved = true
      projectDocument = result
      savedVersion = saving
      updateProjectTitle()
      if (!dirty() && !hasPendingForm() && !currentEditorDraft()) clearAutosave()
      status(dirty() || hasPendingForm() ? '已写入工程，仍有尚未保存的修改' : '已保存工程')
    }
  } finally {
    projectSavePending = false
    closing = await app.finishProjectSave(saveId)
  }
  return saved && !closing
}

// —— 自动保存与崩溃恢复 ——
function serializeDrafts(drafts) {
  return [...drafts].map(([id, changes]) => [id, [...changes]])
}
function currentEditorDraft() {
  if (!editorOpen() || editorText.value === initialEditorText) return null
  return editorCue ? { cueId: editorCue, text: editorText.value } : null
}
function clearAutosave() {
  clearTimeout(autosaveTimer)
  autosaveTimer = 0
  autosaveQueued = false
  void app.autosaveClear().catch(() => {})
}
async function flushAutosave() {
  autosaveTimer = 0
  if (switchingProject || projectBusy) {
    scheduleAutosave()
    return
  }
  const editorDraft = currentEditorDraft()
  if (!dirty() && !hasPendingForm() && !editorDraft) {
    clearAutosave()
    return
  }
  if (autosaveWrite) {
    autosaveQueued = true
    return
  }
  const payload = {
    project: structuredClone(project),
    drafts: {
      cues: serializeDrafts(cueDrafts),
      styles: serializeDrafts(styleDrafts),
      editor: editorDraft,
    },
  }
  autosaveWrite = app.autosaveWrite(payload)
    .then(() => { autosaveErrorShown = false })
    .catch(error => {
      console.warn('Could not write autosave:', error?.message ?? error)
      if (!autosaveErrorShown) {
        autosaveErrorShown = true
        status('自动保存失败：' + errorText(error), 'warn')
      }
    })
    .finally(() => { autosaveWrite = null })
  await autosaveWrite
  if (autosaveQueued) {
    autosaveQueued = false
    scheduleAutosave()
  }
}
function scheduleAutosave() {
  if (switchingProject) return
  clearTimeout(autosaveTimer)
  // 回到已保存状态时立即清理，避免 5 秒内退出留下一个用户已撤销的自动保存。
  if (!dirty() && !hasPendingForm() && !currentEditorDraft()) {
    autosaveTimer = 0
    clearAutosave()
    return
  }
  autosaveTimer = setTimeout(() => { void flushAutosave() }, 5000)
}
function restoreDrafts(drafts) {
  for (const [id, changes] of drafts?.cues ?? []) {
    if (findCue(project, id)) cueDrafts.set(id, new Map(changes))
  }
  for (const [id, changes] of drafts?.styles ?? []) {
    if (styleFor(id)) styleDrafts.set(id, new Map(changes))
  }
  pendingEditorDraft = drafts?.editor && typeof drafts.editor.cueId === 'string' ? drafts.editor : null
}
function applyPendingEditorDraft() {
  const draft = pendingEditorDraft
  pendingEditorDraft = null
  if (!draft) return
  const cue = findCue(project, draft.cueId)
  const owner = cue && trackFor(cue.id)
  if (!cue || !owner || owner.locked) return
  if (linkMode) setLinkMode(false)
  pick(owner, cue)
  openCueEditor(owner, cue)
  if (editorOpen()) {
    editorText.value = draft.text
    updateEditorCount()
  }
}
const recoverDialog = $('recover-dialog')
async function initializeAutosave() {
  const info = await app.autosaveInfo().catch(() => null)
  if (!info) return
  const when = info.savedAt ? new Date(info.savedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  const name = info.documentName && info.documentName !== '未命名工程' ? '（' + info.documentName + '）' : ''
  $('recover-message').textContent = '发现 ' + (when ? when + ' ' : '') + '的自动保存' + name +
    '。恢复后可继续编辑；保存时请另存为。'
  $('recover-error').hidden = true
  recoverDialog.showModal()
  $('recover-restore').focus({ preventScroll: true })
}
recoverDialog.addEventListener('cancel', event => event.preventDefault())
$('recover-restore').addEventListener('click', async () => {
  $('recover-restore').disabled = true
  $('recover-discard').disabled = true
  $('recover-error').hidden = true
  try {
    const result = await app.autosaveRestore()
    if (!result) throw new Error('自动保存已损坏，无法恢复。')
    reset(result.project, result.media, null)
    projectDisplayName = result.documentName ? result.documentName + '（恢复）' : '恢复的工程'
    restoreDrafts(result.drafts)
    savedVersion = { revision: Symbol(), media: project.media }
    updateProjectTitle()
    render()
    applyPendingEditorDraft()
    recoverDialog.close()
    status('已恢复自动保存的工程，请另存为', 'warn')
    scheduleAutosave()
  } catch (error) {
    $('recover-error').textContent = errorText(error)
    $('recover-error').hidden = false
  } finally {
    $('recover-restore').disabled = false
    $('recover-discard').disabled = false
  }
})
$('recover-discard').addEventListener('click', async () => {
  $('recover-restore').disabled = true
  $('recover-discard').disabled = true
  await app.autosaveClear().catch(() => {})
  recoverDialog.close()
  $('recover-restore').disabled = false
  $('recover-discard').disabled = false
  status('已丢弃自动保存')
})

const quitDialog = $('quit-dialog')
let allowWindowClose = false
let quitDialogBusy = false
let closePromptBlockedUntil = 0

function closeNeedsConfirmation() {
  return projectSavePending || dirty() || hasPendingForm() ||
    (editorOpen() && editorText.value !== initialEditorText)
}

function setQuitDialogBusy(busy) {
  quitDialogBusy = busy
  for (const id of ['quit-save', 'quit-discard', 'quit-cancel']) $(id).disabled = busy
}

function suppressClosePrompt() {
  closePromptBlockedUntil = Date.now() + 700
}

function hideQuitDialog() {
  if (quitDialog.open) quitDialog.close()
}

function showQuitDialog() {
  if (quitDialogBusy) return
  setQuitDialogBusy(false)
  if (quitDialog.open) return
  quitDialog.showModal()
  $('quit-save').focus({ preventScroll: true })
}

async function saveThenClose() {
  if (!quitDialog.open || quitDialogBusy) return
  setQuitDialogBusy(true)
  hideQuitDialog()
  status('正在保存工程…')
  let saved = false
  let failure = ''
  try {
    saved = await writeCurrentProject(false)
  } catch (error) {
    failure = errorText(error)
  } finally {
    setQuitDialogBusy(false)
  }
  if (!saved) {
    suppressClosePrompt()
    app.cancelClose()
    status(failure || '已取消保存，窗口不会关闭')
    return
  }
  if (closeNeedsConfirmation()) {
    suppressClosePrompt()
    app.cancelClose()
    status('工程已保存，但仍有尚未保存的修改', 'warn')
    showQuitDialog()
    return
  }
  allowWindowClose = true
  app.allowClose()
}

async function discardThenClose() {
  if (!quitDialog.open) return
  hideQuitDialog()
  await app.autosaveClear().catch(() => {})
  clearTimeout(autosaveTimer)
  autosaveTimer = 0
  allowWindowClose = true
  app.allowClose()
}

function cancelClosing() {
  if (!quitDialog.open) return
  hideQuitDialog()
  app.cancelClose()
}

setQuitDialogBusy(false)
$('quit-save').addEventListener('click', () => { void saveThenClose() })
$('quit-discard').addEventListener('click', () => { void discardThenClose() })
$('quit-cancel').addEventListener('click', cancelClosing)
quitDialog.addEventListener('cancel', event => {
  event.preventDefault()
  cancelClosing()
})
quitDialog.addEventListener('close', () => setQuitDialogBusy(false))

// 访达双击工程文件：和「最近工程」走同一条打开路径，未保存内容仍会先询问。
app.onOpenPath?.(path => {
  changeProject(async () => openResult(await app.openProjectPath(path))).catch(error => status(errorText(error), 'error'))
})

app.onCloseRequest(() => {
  if (quitDialog.open || quitDialogBusy) return
  if (Date.now() < closePromptBlockedUntil) {
    app.cancelClose()
    return
  }
  if (!closeNeedsConfirmation()) {
    allowWindowClose = true
    app.allowClose()
    return
  }
  showQuitDialog()
})

action('save-project', () => withProjectOperation(() => writeCurrentProject(false)))
action('save-project-as', () => withProjectOperation(() => writeCurrentProject(true)))

function confirmSubtitleImport(name, cueCount, issues) {
  const dialog = $('srt-import-dialog')
  $('srt-import-summary').textContent = `${name} · ${cueCount} 条有效字幕，${issues.length} 条有问题`
  const visible = issues.slice(0, 50).map(issue => element('li', '', issue))
  if (issues.length > visible.length) visible.push(element('li', '', `其余 ${issues.length - visible.length} 条未列出`))
  const list = $('srt-import-issues')
  list.replaceChildren(...visible)
  list.scrollTop = 0
  dialog.querySelector('button[value="confirm"]').hidden = !cueCount
  dialog.querySelector('button[value="cancel"]').textContent = cueCount ? '取消' : '关闭'
  dialog.returnValue = 'cancel'
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true })
    dialog.showModal()
  })
}

action('import-subtitles', () => withProjectOperation(async () => {
  const file = await app.chooseSubtitles()
  if (!file) return
  const ass = file.extension === '.ass' ? readAss(file.text) : null
  const { cues, issues = [] } = ass ?? inspectSrt(file.text)
  if (issues.length && !await confirmSubtitleImport(file.name, cues.length, issues)) return
  if (!cues.length) {
    status(`${file.name} 没有可导入的字幕。`)
    return
  }
  const groups = ass && groupAssLayers(cues)
  edit(() => {
    if (ass) {
      currentTrack = importAssLayers(project, ass, groups, file.name).id
    } else {
      if (project.tracks.length === 2 && project.tracks.every(track => track.starter && !track.cues.length && !track.ass)) {
        project.tracks = []
      }
      const next = addTopTrack(project.tracks, cues)
      next.name = file.name
      currentTrack = next.id
    }
    selected = undefined
    selectedCues.clear()
    ensureSelection()
  })
  status('已导入 ' + cues.length + ' 条字幕' + (issues.length ? ` · 跳过 ${issues.length} 条` : ''))
}))
let exportSelection
let exportPartner
function updateExportMergePreview() {
  const preview = $('export-merge-preview')
  if (!$('export-merge').checked || !exportPartner || !exportSelection) {
    preview.hidden = true
    preview.textContent = ''
    return
  }
  try {
    const merged = mergeTracks(project, exportSelection, exportPartner)
    preview.textContent = '示例：' + merged.preview + ' · ' + merged.pairs + ' 对链接' +
      (merged.singles ? ' · ' + merged.singles + ' 条单边' : '') +
      (merged.emptyOverlap ? ' · ' + merged.emptyOverlap + ' 对无重叠，按上轨时间' : '')
    preview.hidden = false
  } catch (error) {
    preview.textContent = errorText(error)
    preview.hidden = false
  }
}
$('export-merge').addEventListener('change', updateExportMergePreview)
action('export-subtitles', () => {
  if (switchingProject) return
  const current = track()
  const dialog = $('export-format')
  if (!current || dialog.open) return
  if (current.locked) {
    status('轨道已锁定，解锁后可导出')
    return
  }
  exportSelection = current
  const partnerInfo = findMergePartner(project, current)
  exportPartner = partnerInfo?.partner
  $('export-track-summary').textContent = trackLabel(current) + ' · ' + current.cues.length + ' 条字幕'
  $('export-merge-row').hidden = !partnerInfo
  $('export-merge').checked = false
  $('export-merge-preview').hidden = true
  $('export-merge-preview').textContent = ''
  if (partnerInfo) {
    $('export-merge-summary').textContent = '检测到与 ' + trackLabel(partnerInfo.partner) + ' 的 ' + partnerInfo.count + ' 对链接字幕'
  }
  dialog.returnValue = 'cancel'
  $('ass-export-note').hidden = !current.ass
  dialog.querySelector('button[value="srt"]').disabled = !current.cues.length
  dialog.showModal()
  dialog.querySelector(`button[value="${current.ass ? 'ass' : 'srt'}"]`).focus()
})
async function exportTrack(current, format) {
  const cues = format === 'srt'
    ? assTextCues(current, !current.ass)
    : current.cues
  const skipped = current.cues.length - cues.length
  const summary = skipped ? ' · 跳过 ' + skipped + ' 条无正文事件' : ''
  if (format === 'srt' && !cues.length) {
    status('此轨道没有可导出的字幕正文' + summary)
    return
  }
  const layer = current.ass && !current.ass.indexed ? undefined : trackIndex(project.tracks, current)
  const text = format === 'ass' ? writeAss(current, project.styles, fadeOf(project.settings), layer) : writeSrt(cues)
  if (await app.exportSubtitles({ name: trackLabel(current), format, text })) {
    status('已导出 ' + format.toUpperCase() + summary)
  }
}
async function exportMergedTrack(current, partner, format) {
  const merged = mergedExportText(project, current, partner, format, { fade: fadeOf(project.settings) })
  const name = trackLabel(merged.upper) + ' + ' + trackLabel(merged.lower) + ' 合并'
  if (!await app.exportSubtitles({ name, format, text: merged.text })) return
  const extras = [
    merged.pairs + ' 对链接',
    merged.singles ? merged.singles + ' 条单边' : '',
    merged.emptyOverlap ? merged.emptyOverlap + ' 对无重叠按上轨时间' : '',
    merged.skipped ? '跳过 ' + merged.skipped + ' 条空正文' : '',
  ].filter(Boolean).join(' · ')
  status('已导出 ' + format.toUpperCase() + ' · ' + extras)
}
$('export-format').addEventListener('close', async () => {
  const format = $('export-format').returnValue
  const current = exportSelection
  const partner = exportPartner
  const merge = $('export-merge').checked && Boolean(partner)
  exportSelection = undefined
  exportPartner = undefined
  $('export-merge-row').hidden = true
  $('export-merge-preview').hidden = true
  if (!['srt', 'ass'].includes(format) || !current || switchingProject) return
  try {
    if (merge) await exportMergedTrack(current, partner, format)
    else await exportTrack(current, format)
  } catch (error) { status(errorText(error), 'error') }
})
action('add-track', () => edit(() => {
  const next = addTopTrack(project.tracks)
  currentTrack = next.id
  selected = undefined
  selectedCues.clear()
}))
function focusTimelineCue(id) {
  rows.find(row => row.buttons.has(id))?.buttons.get(id).focus({ preventScroll: true })
}

action('add-cue', () => {
  if (switchingProject || drag) return
  if (track()?.locked) {
    status('轨道已锁定，解锁后可添加字幕块')
    return
  }
  pausePlayback()
  if (linkMode) setLinkMode(false)
  edit(() => {
    let target = track()
    if (!target) {
      target = addTopTrack(project.tracks)
      currentTrack = target.id
    }
    const start = Math.round(playheadPosition())
    const cue = { id: crypto.randomUUID(), ...alignCue(editingBoundaries(), start, start + 2000), text: '', assText: true }
    target.cues.push(cue)
    selected = cue.id
    selectedCues.clear()
  })
  revealTimelinePosition(time)
  renderViewport()
  // Bring a newly created block on a lower track into view as well.
  const block = rows.find(row => row.buttons.has(selected))?.buttons.get(selected)
  block?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  focusTimelineCue(selected)
  status('已添加空字幕块 · 按 Enter 或双击编辑正文')
})

const cueEditor = $('cue-editor-popover')
const editorText = $('editor-text')
const editorCount = $('editor-count')
const editorError = $('editor-error')
let editorCue
let initialEditorText
function editorOpen() {
  return !cueEditor.hidden
}

function editorBlock() {
  return rows.find(row => row.buttons.has(editorCue))?.buttons.get(editorCue)
}

function updateEditorCount() {
  editorCount.textContent = String([...editorText.value].length)
}

// 编辑框紧贴字幕块上方；上方空间不够时落到块下方。
function positionCueEditor() {
  const block = editorBlock()
  if (!block) return
  const box = block.getBoundingClientRect()
  const width = cueEditor.offsetWidth || 420
  const height = cueEditor.offsetHeight || 130
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, box.left))
  let top = box.top - height - 8
  if (top < 8) top = Math.min(window.innerHeight - height - 8, box.bottom + 8)
  cueEditor.style.left = Math.round(left) + 'px'
  cueEditor.style.top = Math.round(top) + 'px'
}

function openCueEditor(owner, cue) {
  if (switchingProject || linkMode || drag || editorOpen()) return
  if (trackFor(cue.id)?.locked) {
    status('轨道已锁定，解锁后可编辑正文')
    return
  }
  pausePlayback()
  if (selected !== cue.id || currentTrack !== owner.id) pick(owner, cue)
  editorCue = cue.id
  initialEditorText = $('cue-text').value
  editorText.value = initialEditorText
  editorError.hidden = true
  updateEditorCount()
  cueEditor.hidden = false
  positionCueEditor()
  editorText.focus({ preventScroll: true })
  editorText.setSelectionRange(editorText.value.length, editorText.value.length)
}

function closeCueEditor(focus = true) {
  if (!editorOpen()) return
  const cue = editorCue
  cueEditor.hidden = true
  editorError.hidden = true
  editorCue = undefined
  if (focus && cue !== undefined && findCue(project, cue)) focusTimelineCue(cue)
  scheduleAutosave()
}

function saveCueEditor() {
  const cue = findCue(project, editorCue)
  if (!cue) {
    closeCueEditor(false)
    return
  }
  const text = editorText.value
  if (!trackFor(cue.id)?.ass && !cue.assText && hasEmptyLine(text)) {
    editorError.textContent = '请删掉 SRT 正文首尾或中间的空行。'
    editorError.hidden = false
    editorText.focus()
    return
  }
  editorError.hidden = true
  // Committing text must keep any pending timing or style changes in the inspector.
  const binding = inspectorForms.get($('cue-form'))
  cueDrafts.get(cue.id)?.delete(binding.fields.indexOf($('cue-text')))
  if (text !== cue.text) edit(() => { cue.text = text })
  else {
    renderCueForm()
    updateProjectTitle()
    refreshInspectorPreview()
  }
  status('已更新字幕正文')
  closeCueEditor()
}

$('editor-save').addEventListener('click', saveCueEditor)
$('editor-cancel').addEventListener('click', () => closeCueEditor())
editorText.addEventListener('input', () => {
  editorError.hidden = true
  updateEditorCount()
  scheduleAutosave()
})
editorText.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing) {
    event.preventDefault()
    closeCueEditor()
    return
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    if (!event.repeat) saveCueEditor()
  }
})

function deleteSelectedCue(id = selected) {
  if (drag || switchingProject) return
  const ids = new Set(selectedCues)
  if (selected !== undefined) ids.add(selected)
  if (id !== undefined) ids.add(id)
  const deletable = [...ids].filter(cueId => findCue(project, cueId))
  if (!deletable.length) return
  if (deletable.some(cueId => trackFor(cueId)?.locked)) {
    status('轨道已锁定，解锁后可删除')
    return
  }
  edit(() => {
    for (const cueId of deletable) {
      removeCue(project, cueId)
      cueDrafts.delete(cueId)
      if (selected === cueId) selected = undefined
    }
    selectedCues.clear()
    linkStart = undefined
  })
  status(deletable.length > 1 ? '已删除 ' + deletable.length + ' 条字幕，可撤销' : '已删除字幕，可撤销')
}

function selectedCueIds() {
  const ids = new Set(selectedCues)
  if (selected !== undefined) ids.add(selected)
  return [...ids].filter(id => findCue(project, id))
}

function copyTimelineCue(owner, cue) {
  clipboard = [{ captured: captureCue(owner, cue, project.styles), offset: 0 }]
  status('已复制字幕')
}

function copySelection() {
  const cues = selectedCueIds().map(id => findCue(project, id))
  if (!cues.length) return
  const origin = Math.min(...cues.map(cue => cue.start))
  clipboard = cues.map(cue => ({
    captured: captureCue(trackFor(cue.id), cue, project.styles),
    offset: cue.start - origin,
  }))
  status(cues.length > 1 ? '已复制 ' + cues.length + ' 条字幕' : '已复制字幕')
}

function pasteTimelineCue() {
  const target = track()
  if (!target || !clipboard?.length || drag || switchingProject) return
  if (target.locked) {
    status('轨道已锁定，解锁后可粘贴')
    return
  }
  if (linkMode) setLinkMode(false)
  pausePlayback()
  const at = Math.round(playheadPosition())
  const created = []
  edit(() => {
    for (const { captured, offset } of clipboard) {
      const cue = pasteCue(target, captured, at + offset, project.styles)
      Object.assign(cue, alignCue(editingBoundaries(), cue.start, cue.end))
      target.cues.push(cue)
      created.push(cue.id)
    }
    selected = created[0]
    selectedCues = new Set(created)
  })
  revealTimelinePosition(time)
  renderViewport()
  const block = rows.find(row => row.track === target)?.buttons.get(created[0])
  block?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  focusTimelineCue(created[0])
  status('已粘贴字幕到「' + trackLabel(target) + '」')
}

function selectTrackCues() {
  const owner = track()
  if (!owner?.cues.length) return
  if (linkMode) setLinkMode(false)
  selectedCues = expandBindings(new Set(owner.cues.map(cue => cue.id)))
  selected = undefined
  refreshTrackControls()
  renderCueForm()
  refreshInspectorPreview()
  renderViewport()
  status('已选中「' + trackLabel(owner) + '」的全部字幕')
}


const cueStyleMenu = $('cue-style-menu')

function selectAllCues() {
  const ids = project.tracks.flatMap(track => track.cues.map(cue => cue.id))
  if (!ids.length) { status('当前工程没有字幕块'); return }
  if (linkMode) setLinkMode(false)
  selectedCues = expandBindings(new Set(ids))
  selected = undefined
  refreshTrackControls()
  renderCueForm()
  refreshInspectorPreview()
  renderViewport()
  status('已全选 ' + selectedCues.size + ' 条字幕块')
}

function selectCuesAroundPlayhead(where) {
  const position = Math.round(playheadPosition())
  const ids = []
  for (const track of project.tracks) {
    for (const cue of track.cues) {
      if (where === 'before' ? cue.end <= position : cue.start >= position) ids.push(cue.id)
    }
  }
  if (!ids.length) {
    status(where === 'before' ? '播放头之前没有字幕块' : '播放头之后没有字幕块')
    return
  }
  if (linkMode) setLinkMode(false)
  selectedCues = expandBindings(new Set(ids))
  selected = undefined
  refreshTrackControls()
  renderCueForm()
  refreshInspectorPreview()
  renderViewport()
  status('已选中播放头' + (where === 'before' ? '之前 ' : '之后 ') + selectedCues.size + ' 条字幕块')
}

function clearSelectedCueText() {
  const ids = selectedCueIds()
  if (!ids.length) return
  edit(() => {
    for (const id of ids) {
      const cue = findCue(project, id)
      if (!cue) continue
      cue.text = ''
      cueDrafts.delete(id)
    }
  })
  status(ids.length > 1 ? '已清空 ' + ids.length + ' 条字幕正文' : '已清空字幕正文')
}

function toggleCueBinding() {
  const ids = selectedCueIds()
  if (ids.length < 2) return
  const group = bindingGroupOf(ids[0])
  if (group && ids.every(id => group.includes(id))) {
    edit(() => { project.bindings = (project.bindings ?? []).filter(item => item !== group) })
    status('已解除绑定')
    return
  }
  selectedCues = new Set(ids)
  edit(() => {
    project.bindings = (project.bindings ?? []).filter(item => !item.some(id => ids.includes(id)))
    project.bindings.push([...ids])
  })
  status('已绑定 ' + ids.length + ' 条字幕块')
}

function showCueStyleMenu(anchor) {
  const ids = selectedCueIds()
  if (!ids.length) return
  const trackIds = new Set(ids.map(id => trackFor(id)?.id))
  const styles = project.styles.filter(style => style.trackId === undefined || ids.every(id => trackFor(id)?.id === style.trackId))
  cueStyleMenu.replaceChildren(...styles.map(style => {
    const item = element('button')
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    item.append(element('span', '', styleName(style) || '默认样式'))
    if (ids.every(id => findCue(project, id)?.style === style.id)) item.setAttribute('aria-selected', 'true')
    item.addEventListener('click', () => {
      cueStyleMenu.hidePopover()
      edit(() => {
        for (const id of ids) {
          const cue = findCue(project, id)
          if (cue) cue.style = style.id
        }
      })
      status('已设置字幕样式')
    })
    return item
  }))
  const box = anchor?.getBoundingClientRect?.() ?? { left: innerWidth / 2, right: innerWidth / 2, bottom: innerHeight / 2 }
  cueStyleMenu.style.left = '0px'
  cueStyleMenu.style.top = '0px'
  cueStyleMenu.showPopover()
  placePopover(cueStyleMenu, box.left, box.bottom + 4)
}

const timelineMenu = $('timeline-menu')
document.querySelector('.timeline-body').addEventListener('dblclick', event => {
  if (event.target.closest('.cue, .track-heading, button')) return
  const lane = event.target.closest('.track-lane')
  const owner = lane && project.tracks.find(track => track.id === lane.dataset.trackId)
  if (owner) chooseTrack(owner)
})

scroll.addEventListener('contextmenu', event => {
  if (drag || switchingProject) return
  event.preventDefault()
  closeMenus()
  if (timelineMenu.matches(':popover-open')) timelineMenu.hidePopover()
  const block = event.target.closest('.cue')
  const owner = block && trackFor(block.dataset.cueId)
  const cue = owner?.cues.find(cue => cue.id === block.dataset.cueId)
  if (cue && selected !== cue.id && !selectedCues.has(cue.id)) pick(owner, cue)
  const ids = cue ? selectedCueIds() : []
  const locked = ids.some(id => trackFor(id)?.locked)
  const group = cue ? bindingGroupOf(cue.id) : undefined
  const bound = Boolean(group) && ids.length >= 2 && ids.every(id => group.includes(id))
  const commands = cue ? [
    ['style', '设置样式', () => showCueStyleMenu(block), locked],
    ['close', '清空', clearSelectedCueText, locked],
    ['copy', '复制', copySelection, locked],
    ['trash', '删除', () => deleteSelectedCue(), locked],
    ['link', bound ? '解除绑定' : '绑定', toggleCueBinding, ids.length < 2 || locked],
    ['split', '拆分双语…', () => splitTrackCommand(owner), Boolean(owner?.locked) || Boolean(owner?.ass) || !owner?.cues.length],
    ['link', '链接字幕', () => setLinkMode(true), Boolean(owner?.locked)],
  ] : [
    ['select', '全选', selectAllCues],
    ['track', '选中当前轨道全部字幕块', selectTrackCues, !track()?.cues.length],
    ['trim-start', '选中播放头之前全部字幕块', () => selectCuesAroundPlayhead('before')],
    ['trim-end', '选中播放头之后全部字幕块', () => selectCuesAroundPlayhead('after')],
    ['cue', '添加字幕块', () => $('add-cue').click(), Boolean(track()?.locked)],
  ]
  timelineMenu.replaceChildren(...commands.map(([symbol, label, command, disabled]) => {
    const button = element('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.disabled = Boolean(disabled)
    button.append(icon(symbol), element('span', '', label))
    button.addEventListener('click', () => {
      timelineMenu.hidePopover()
      if (block?.isConnected) block.focus({ preventScroll: true })
      else $('ruler').focus({ preventScroll: true })
      command()
    })
    return button
  }))
  timelineMenu.showPopover()
  const box = event.target.getBoundingClientRect()
  const x = event.clientX || box.left
  const y = event.clientY || box.bottom
  placePopover(timelineMenu, x, y)
  timelineMenu.querySelector('button:enabled')?.focus({ preventScroll: true })
})

timelineMenu.addEventListener('keydown', event => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const items = [...timelineMenu.querySelectorAll('button:enabled')]
  const offset = event.key === 'ArrowDown' ? 1 : -1
  items[(items.indexOf(document.activeElement) + offset + items.length) % items.length]?.focus()
})

function hasEmptyLine(text) {
  return /\n[ \t]*\n|^\n|\n$/.test(text)
}

action('delete-cue', () => deleteSelectedCue())
function splitTrackCommand(owner = track()) {
  return withProjectOperation(async () => {
    const current = owner
    if (!current?.cues.length || current.ass) return
    if (current.locked) {
      status('轨道已锁定，解锁后可拆分双语')
      return
    }
    if (current.cues.some(cue => cueDrafts.has(cue.id))) {
      status('请先应用或取消当前轨道的字幕草稿，再拆分双语。')
      return
    }
    const dialog = $('split-dialog')
    dialog.returnValue = 'cancel'
    updateSplitPreview()
    const choice = await new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true })
      dialog.showModal()
    })
    if (choice !== 'confirm' || dialog.querySelector('button[value="confirm"]').disabled) return
    edit(() => {
      splitTrack(project, current.id, $('split-order').value === 'reverse')
      currentTrack = project.tracks[0].id
    })
    status('已拆分双语字幕')
  })
}
$('split-order').addEventListener('change', updateSplitPreview)
action('undo', () => restore(undo, redo))
action('redo', () => restore(redo, undo))
action('next-review', () => {
  if (!reviewCues.length) return
  const activeTrack = trackFor(selected)
  const activeRow = rows.findIndex(row => row.track === activeTrack)
  const activeCue = rows[activeRow]?.ordered.findIndex(cue => cue.id === selected) ?? -1
  const { row, cue } = reviewCues.find(({ rowIndex, cueIndex }) =>
    rowIndex > activeRow || (rowIndex === activeRow && cueIndex > activeCue)
  ) ?? reviewCues[0]
  if (linkMode) setLinkMode(false)
  pausePlayback()
  pick(row.track, cue)
  seek(cue.start)
  revealTimelinePosition(cue.start)
  renderViewport()
  const block = row.buttons.get(cue.id)
  if (block) {
    const bounds = scroll.getBoundingClientRect()
    const target = block.getBoundingClientRect()
    if (target.top < bounds.top) scroll.scrollTop -= bounds.top - target.top
    else if (target.bottom > bounds.top + scroll.clientHeight) scroll.scrollTop += target.bottom - bounds.top - scroll.clientHeight
  }
  status(hasPicture() && cue.start > mediaDuration ? '已定位待校对字幕，起点超出视频时长。' : '已定位待校对字幕')
})
action('complete-review', () => {
  const cue = findCue(project, selected)
  if (!cue?.splitNeedsReview) return
  if (cueDrafts.has(cue.id)) {
    status('请先应用或取消字幕修改。')
    return
  }
  edit(() => { delete cue.splitNeedsReview })
  $('cue-text').focus({ preventScroll: true })
  status('已标为已校对')
})
action('add-style', () => createStyle())
action('about-app', async () => {
  $('about-version').textContent = await app.getVersion()
  $('about-dialog').showModal()
})
$('about-homepage').addEventListener('click', event => {
  event.preventDefault()
  app.openExternal('https://github.com/AchiDilyar/SubX')
})

action('styles-tab', () => switchTab('styles'))
action('settings-tab', () => switchTab('settings'))
action('cue-tab', () => switchTab('cue'))
for (const key of ['fade', 'watermark']) {
  $('project-' + key).addEventListener('change', event => edit(() => {
    project.settings = { fade: false, watermark: false, fadeDuration: 100, ...project.settings, [key]: event.target.checked }
  }))
  $('project-' + key).addEventListener('change', () => {
    if (key === 'fade') $('fade-duration-field').hidden = !$('project-fade').checked
    if (key === 'watermark') {
      $('watermark-fields').hidden = !$('project-watermark').checked
      void syncWatermarkImage()
      applyWatermarkOverlay()
    }
  })
}
$('project-fade-duration').addEventListener('change', event => {
  const value = Math.max(0, Math.min(2000, Math.round(Number(event.target.value) || 0)))
  event.target.value = String(value)
  edit(() => {
    project.settings = { fade: false, watermark: false, fadeDuration: 100, ...project.settings, fadeDuration: value }
  })
})
const toolModes = { 'select-tool': 'select', 'split-tool': 'split', 'select-forward': 'select-forward', 'select-backward': 'select-backward' }
for (const [id, mode] of Object.entries(toolModes)) action(id, () => setToolMode(mode))
action('snap-tool', () => {
  snapping = !snapping
  setToolState('snap-tool', snapping)
})
const waveformOrder = ['symmetric', 'asymmetric', 'off']
const waveformLabels = { symmetric: '对称', asymmetric: '非对称', off: '关闭' }
const waveformIcons = { symmetric: 'wave-symmetric', asymmetric: 'wave-asymmetric', off: 'wave-off' }
function setWaveformMode(mode) {
  waveformMode = mode
  const button = $('waveform-mode')
  button.title = '波形：' + waveformLabels[mode]
  button.setAttribute('aria-label', '波形显示：' + waveformLabels[mode])
  button.setAttribute('aria-pressed', String(mode !== 'off'))
  button.replaceChildren(icon(waveformIcons[mode]))
  drawWaveform(timelineView().usable)
}
action('waveform-mode', () => setWaveformMode(waveformOrder[(waveformOrder.indexOf(waveformMode) + 1) % waveformOrder.length]))
setWaveformMode(waveformMode)
setToolState('snap-tool', snapping)
function setToolMode(mode) {
  toolMode = mode
  linkMode = false
  for (const [id, value] of Object.entries(toolModes)) setToolState(id, value === mode)
  status({
    select: '选择工具',
    split: '分割工具：点击字幕块在点击处分割',
    'select-forward': '向前选中：点击字幕选中它及其后方的字幕',
    'select-backward': '向后选中：点击字幕选中它及其前方的字幕',
  }[mode])
  renderViewport()
}
function setLinkMode(enabled) {
  linkMode = enabled
  linkStart = undefined
  if (enabled) {
    for (const id of Object.keys(toolModes)) setToolState(id, false)
    status('选择不同轨道的两个字幕块，或点击已链接的字幕块解除链接。')
  } else {
    setToolMode('select')
  }
  renderViewport()
}
function setToolState(id, isActive) {
  $(id).classList.toggle('selected', isActive)
  $(id).setAttribute('aria-pressed', String(isActive))
}
function splitCueAt(owner, cue, at) {
  if (owner.locked) {
    status('轨道已锁定，解锁后可分割')
    return
  }
  if (cue.end - cue.start < 3) {
    status('字幕太短，无法继续分割')
    return
  }
  const grid = editingBoundaries()
  const timing = alignCue(grid, cue.start, cue.end)
  const position = grid.length >= 2 ? nearestBoundary(grid, at, timing.start + 1, timing.end - 1) : Math.max(cue.start + 1, Math.min(cue.end - 1, Math.round(at)))
  if (position === undefined) { status('字幕不足两帧，无法分割'); return }
  if (position <= cue.start || position >= cue.end) return
  edit(() => {
    const tail = { ...cue, id: crypto.randomUUID(), start: position, end: timing.end }
    cue.start = timing.start
    cue.end = position
    owner.cues.push(tail)
    project.links = (project.links ?? []).filter(pair => !pair.includes(cue.id))
    selected = cue.id
    selectedCues.clear()
  })
  status('已在 ' + printTime(position, '.') + ' 处分割字幕')
}
function splitSelectedCue() {
  const cue = findCue(project, selected)
  if (!cue) {
    status('请先选中一条字幕')
    return
  }
  const owner = trackFor(cue.id)
  if (owner) splitCueAt(owner, cue, playheadPosition())
}
function trimSelectedToPlayhead(edge) {
  const cue = findCue(project, selected)
  if (!cue) {
    status('请先选中一条字幕')
    return
  }
  if (trackFor(cue.id)?.locked) {
    status('轨道已锁定，解锁后可裁剪')
    return
  }
  const at = Math.round(playheadPosition())
  if (at <= cue.start || at >= cue.end) {
    status('请把播放头移到字幕内部再裁剪')
    return
  }
  edit(() => { Object.assign(cue, alignCue(editingBoundaries(), edge === 'start' ? at : cue.start, edge === 'end' ? at : cue.end)) })
  status(edge === 'start' ? '已向左裁剪到播放头' : '已向右裁剪到播放头')
}
function selectCueRange(owner, cue, direction) {
  const ordered = [...owner.cues].sort((left, right) => left.start - right.start || left.end - right.end)
  const index = ordered.findIndex(item => item.id === cue.id)
  if (index < 0) return
  const slice = direction === 'forward' ? ordered.slice(index) : ordered.slice(0, index + 1)
  selectedCues = expandBindings(new Set(slice.map(item => item.id)))
  selected = undefined
  currentTrack = owner.id
  refreshTrackControls()
  renderCueForm()
  refreshInspectorPreview()
  renderViewport()
  status((direction === 'forward' ? '已向前选中 ' : '已向后选中 ') + slice.length + ' 条字幕')
}
function toggleMarker() {
  if (switchingProject) return
  const at = Math.round(playheadPosition())
  project.markers ??= []
  const index = project.markers.findIndex(value => Math.abs(value - at) <= 60)
  edit(() => {
    if (index >= 0) project.markers.splice(index, 1)
    else {
      project.markers.push(at)
      project.markers.sort((left, right) => left - right)
    }
  })
  status(index >= 0 ? '已删除播放头处的标记' : '已在播放头处添加标记')
}
function deleteCurrentTrack() {
  if (switchingProject) return
  const owner = track()
  if (!owner) {
    status('没有可删除的轨道')
    return
  }
  if (owner.locked) {
    status('轨道已锁定，解锁后可删除')
    return
  }
  const index = project.tracks.indexOf(owner)
  const cueIds = new Set(owner.cues.map(cue => cue.id))
  edit(() => {
    project.tracks.splice(index, 1)
    project.links = (project.links ?? []).filter(pair => !pair.some(id => cueIds.has(id)))
    for (const id of cueIds) cueDrafts.delete(id)
    currentTrack = project.tracks[Math.min(index, project.tracks.length - 1)]?.id
    selected = undefined
    selectedCues.clear()
    linkStart = undefined
  })
  status('已删除轨道「' + trackLabel(owner) + '」，可撤销')
}
action('delete-track', deleteCurrentTrack)

action('split-cue', splitSelectedCue)
action('trim-start', () => trimSelectedToPlayhead('start'))
action('trim-end', () => trimSelectedToPlayhead('end'))
action('timeline-delete', () => deleteSelectedCue())
action('toggle-marker', toggleMarker)

// 编辑开始/结束时间或正文时，实时刷新时长与语速提示。
for (const id of ['cue-text', 'cue-start', 'cue-end']) {
  $(id).addEventListener('input', () => {
    const cue = findCue(project, selected)
    if (!cue) return
    updateCueMeta(cue, {
      start: readTime($('cue-start').value),
      end: readTime($('cue-end').value),
      text: $('cue-text').value,
    })
  })
}

$('cue-form').addEventListener('submit', event => {
  event.preventDefault()
  const cue = findCue(project, selected)
  if (!cue) return
  let start = readTime($('cue-start').value)
  let end = readTime($('cue-end').value)
  const text = $('cue-text').value.replace(/\r\n?/g, '\n')
  if (!trackFor(cue.id)?.ass && !cue.assText && hasEmptyLine(text)) {
    status('请删掉 SRT 正文首尾或中间的空行。')
    return
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    status('请输入有效时间，且结束时间晚于开始时间。')
    return
  }
  if (start !== cue.start || end !== cue.end) ({ start, end } = alignCue(editingBoundaries(), start, end))
  edit(() => {
    cueDrafts.delete(cue.id)
    cue.start = start
    cue.end = end
    cue.text = text
    const style = $('cue-style').value
    if (style) cue.style = style
    else if (cue.style !== undefined) cue.style = cue.ass ? null : undefined
  })
  status('已更新字幕')
})

action('play', async () => {
  if (playbackPaused()) await startPlayback()
  else pausePlayback()
})
function setPreviewMaximized(maximize) {
  if (monitor.classList.contains('preview-maximized') === maximize) return
  monitor.classList.toggle('preview-maximized', maximize)
  const button = $('fullscreen-preview')
  button.setAttribute('aria-pressed', String(maximize))
  button.setAttribute('aria-label', maximize ? '退出全屏预览' : '全屏预览视频')
  button.title = maximize ? '退出全屏预览' : '全屏预览'
  button.replaceChildren(icon(maximize ? 'collapse' : 'expand'))
  requestAnimationFrame(fitPicture)
}
action('fullscreen-preview', () => setPreviewMaximized(!monitor.classList.contains('preview-maximized')))
$('preview-progress').addEventListener('input', event => {
  if (mediaDuration && hasPicture()) {
    const requested = mediaDuration * Number(event.target.value) / 1000
    seek(magneticPlayheadTime(requested) ?? snapPlayheadTime(requested))
  }
})
// 原生 range 在隐藏窗口/自定义外观下拖动不稳定，这里自己按指针位置定位。
const progressInput = $('preview-progress')
function seekFromProgress(event) {
  const box = progressInput.getBoundingClientRect()
  if (!box.width || !mediaDuration || !hasPicture()) return
  const fraction = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
  const requested = mediaDuration * fraction
  seek(magneticPlayheadTime(requested) ?? snapPlayheadTime(requested))
}
progressInput.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !mediaDuration || !hasPicture()) return
  event.preventDefault()
  progressInput.dataset.dragging = 'true'
  progressInput.setPointerCapture(event.pointerId)
  seekFromProgress(event)
})
progressInput.addEventListener('pointermove', event => {
  if (progressInput.dataset.dragging !== 'true') return
  seekFromProgress(event)
})
function endProgressDrag(event) {
  if (progressInput.dataset.dragging !== 'true') return
  delete progressInput.dataset.dragging
  if (progressInput.hasPointerCapture?.(event.pointerId)) progressInput.releasePointerCapture(event.pointerId)
}
progressInput.addEventListener('pointerup', endProgressDrag)
progressInput.addEventListener('pointercancel', endProgressDrag)
progressInput.addEventListener('lostpointercapture', () => { delete progressInput.dataset.dragging })
function syncPlayback() {
  const paused = playbackPaused()
  $('play').replaceChildren(icon(paused ? 'play' : 'pause'))
  $('play').title = paused ? '播放' : '暂停'
  $('play').setAttribute('aria-label', paused ? '播放' : '暂停')
}
video.addEventListener('play', () => { rulerFrame = undefined; syncPlayback() })
video.addEventListener('pause', syncPlayback)
video.addEventListener('ended', () => { syncPlayback(); snapPlayhead() })
video.addEventListener('loadedmetadata', () => {
  if (isSolid()) return
  mediaDuration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0
  const reference = waveformMedia
  if (reference && mediaDuration) {
    app.frameTimes(reference.token).then(result => {
      if (waveformMedia !== reference) return
      frameTimes = result?.filter(at => at < mediaDuration)
      $('ruler').dataset.frameIndex = frameTimes?.length ? 'ready' : 'unavailable'
      $('ruler').title = frameTimes?.length ? '' : '无法读取帧时间。逐帧定位需要本机 ffprobe。'
      if (frameTimes?.length === 1) frameGap = mediaDuration
      for (let index = 1; index < (frameTimes?.length ?? 0); index++) {
        frameGap = Math.min(frameGap, frameTimes[index] - frameTimes[index - 1])
      }
      renderViewport()
    }).catch(() => {
      if (waveformMedia !== reference) return
      $('ruler').dataset.frameIndex = 'unavailable'
      $('ruler').title = '无法读取视频帧时间。'
    })
    app.waveform(reference.token, video.duration).then(result => {
      if (waveformMedia !== reference) return
      waveform = result
      $('waveform').dataset.hasAudio = String(Boolean(result))
      drawWaveform(timelineView().usable)
    }).catch(() => {})
  }
  refreshInspectorPreview(true)
  fitPicture()
  renderViewport()
})
video.addEventListener('loadeddata', () => {
  if (isSolid()) return
  $('empty-video').hidden = true
  $('play').disabled = false
  applyQuality()
})
video.addEventListener('emptied', () => { if (!isSolid()) $('play').disabled = true })
video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return
  $('play').disabled = true
  $('open-media').textContent = '重新定位视频'
  $('empty-video-message').textContent = '视频无法播放'
  $('empty-video-message').hidden = false
  $('empty-video').hidden = false
  mediaState = 'error'
  updateEmptyState()
  video.hidden = true
  canvas.hidden = true
  status('无法播放此视频。请检查文件或尝试 H.264/AAC MP4。', 'error')
})
video.addEventListener('seeking', () => {
  if (isSolid()) return
  if (rulerFrame !== undefined && Math.abs(video.currentTime * 1000 - rulerFrame) > .51) rulerFrame = undefined
  presentedFrameTime = null
  observeVideoFrames()
})
video.addEventListener('seeked', () => {
  if (isSolid()) return
  time = Math.round(video.currentTime * 1000)
  applyQuality()
  updatePreview()
})
video.addEventListener('timeupdate', () => {
  if (!isSolid() && !video.seeking) {
    time = Math.round(video.currentTime * 1000)
    updatePreview()
  }
})
function observeVideoFrames() {
  if (isSolid()) return
  if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest)
  const generation = ++frameGeneration
  function frameReady(_now, metadata) {
    if (generation !== frameGeneration || isSolid()) return
    frameRequest = video.requestVideoFrameCallback(frameReady)
    if (!video.seeking) {
      // A frame's start can precede the exact playback position, especially when paused.
      time = Math.round(video.currentTime * 1000)
      presentedFrameTime = Math.round(metadata.mediaTime * 1000)
      applyQuality()
      updatePreview()
    }
  }
  frameRequest = video.requestVideoFrameCallback(frameReady)
}
$('quality').addEventListener('change', applyQuality)

const ruler = $('ruler')
let rulerPointer
let rulerScrollFrame = 0
function seekWithPointer(event) {
  pauseForSeek()
  const bounds = scroll.getBoundingClientRect()
  const x = Math.max(bounds.left + $('track-headings').offsetWidth, Math.min(bounds.right - 1, event.clientX))
  const requested = (x - ruler.getBoundingClientRect().left) * 1000 / pixelsPerSecond
  playheadSnapTime = magneticPlayheadTime(requested)
  seekFrame(playheadSnapTime ?? snapRulerTime(requested))
  updateSnapGuide()
}
function scrollRulerPointer() {
  if (!rulerPointer) return
  const bounds = scroll.getBoundingClientRect()
  const left = bounds.left + $('track-headings').offsetWidth
  const right = bounds.right
  const distance = rulerPointer.x < left + 24 ? rulerPointer.x - (left + 24) :
    rulerPointer.x > right - 24 ? rulerPointer.x - (right - 24) : 0
  if (distance) {
    const before = scroll.scrollLeft
    scroll.scrollLeft += Math.max(-24, Math.min(24, distance * .35))
    if (scroll.scrollLeft !== before) seekWithPointer({ clientX: rulerPointer.x })
  }
  rulerScrollFrame = requestAnimationFrame(scrollRulerPointer)
}
function endRulerPointer(event) {
  if (rulerPointer?.id !== event.pointerId) return
  rulerPointer = undefined
  playheadSnapTime = undefined
  updateSnapGuide()
  cancelAnimationFrame(rulerScrollFrame)
  rulerScrollFrame = 0
}
ruler.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  event.preventDefault()
  ruler.focus({ preventScroll: true })
  ruler.setPointerCapture(event.pointerId)
  rulerPointer = { id: event.pointerId, x: event.clientX }
  rulerScrollFrame = requestAnimationFrame(scrollRulerPointer)
  seekWithPointer(event)
})
ruler.addEventListener('pointermove', event => {
  if (ruler.hasPointerCapture(event.pointerId)) {
    rulerPointer.x = event.clientX
    seekWithPointer(event)
  }
})
ruler.addEventListener('pointerup', endRulerPointer)
ruler.addEventListener('pointercancel', endRulerPointer)
ruler.addEventListener('lostpointercapture', endRulerPointer)
window.addEventListener('blur', () => { if (rulerPointer) endRulerPointer({ pointerId: rulerPointer.id }) })

const selectionBox = $('selection-box')
let marquee
function marqueePoint(event) {
  const bounds = $('track-data').getBoundingClientRect()
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}
function updateMarquee(event) {
  if (!marquee || marquee.id !== event.pointerId) return
  const point = marqueePoint(event)
  if (!marquee.active && Math.hypot(event.clientX - marquee.clientX, event.clientY - marquee.clientY) < 4) return
  marquee.active = true
  const left = Math.min(marquee.x, point.x), right = Math.max(marquee.x, point.x)
  const top = Math.min(marquee.y, point.y), bottom = Math.max(marquee.y, point.y)
  Object.assign(selectionBox.style, { left: left + 'px', top: top + 'px', width: (right - left) + 'px', height: (bottom - top) + 'px' })
  selectionBox.hidden = false
  selected = undefined
  selectedCues = new Set()
  for (const row of rows) {
    if (row.track.locked) continue
    const laneTop = $('track-lanes').offsetTop + row.lane.offsetTop
    for (const cue of row.ordered) {
      const cueTop = laneTop + row.laneById.get(cue.id) * (CUE_HEIGHT + CUE_LANE_GAP) + CUE_LANE_PADDING
      const cueWidth = width(cue.end - cue.start)
      const blockWidth = cueWidth < DENSE_CUE_WIDTH ? Math.max(2, cueWidth - 1) : Math.max(1, cueWidth)
      if (width(cue.start) < right && width(cue.start) + blockWidth > left &&
          cueTop < bottom && cueTop + CUE_HEIGHT > top) selectedCues.add(cue.id)
    }
  }
  selectedCues = expandBindings(selectedCues)
  refreshTrackControls()
  renderCueForm()
  renderViewport()
}
function endMarquee(event, commit = true) {
  if (!marquee || marquee.id !== event.pointerId) return
  if (!commit) {
    selected = marquee.selected
    selectedCues = marquee.selectedCues
  }
  marquee = undefined
  selectionBox.hidden = true
  refreshTrackControls()
  renderCueForm()
  refreshInspectorPreview()
  renderViewport()
}
$('track-data').addEventListener('pointerdown', event => {
  if (event.button !== 0 || toolMode !== 'select' || linkMode || event.target.closest('.cue')) return
  // 空白区域框选：轨道内、轨道下方的空白，以及轨道容器本身都可以起框。
  const lane = event.target.closest('.track-lane')
  if (!lane && !event.target.closest('#track-lanes') && event.target !== $('track-data')) return
  event.preventDefault()
  const point = marqueePoint(event)
  marquee = { id: event.pointerId, ...point, clientX: event.clientX, clientY: event.clientY, selected, selectedCues: new Set(selectedCues), active: false }
  // 点空白区域即取消当前选中，拖动时再按框选结果重新选中。
  selected = undefined
  selectedCues.clear()
  refreshTrackControls()
  renderCueForm()
  renderViewport()
  ;(lane ?? $('track-lanes')).setPointerCapture(event.pointerId)
})
$('track-data').addEventListener('pointermove', updateMarquee)
$('track-data').addEventListener('pointerup', endMarquee)
$('track-data').addEventListener('pointercancel', event => endMarquee(event, false))
$('track-data').addEventListener('lostpointercapture', event => endMarquee(event, false))
window.addEventListener('blur', () => { if (marquee) endMarquee({ pointerId: marquee.id }, false) })
ruler.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  nudgePlayhead(event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey)
})
// 播放时每帧都会调用，缓存布局宽度避免每帧强制回流。
let cachedUsableWidth = 0
function revealTimelinePosition(target, page = false) {
  const usable = cachedUsableWidth || Math.max(1, scroll.clientWidth - $('track-headings').offsetWidth)
  const position = width(target)
  const start = scroll.scrollLeft
  if (position < start) {
    scroll.scrollLeft = position - playheadMargin
  } else if (position + 1 > start + usable) {
    // 播放时整屏右移一格，让播放头回到左侧重新向右走，而不是贴住右边缘连续滚动。
    scroll.scrollLeft = page ? position - playheadMargin : position - usable + playheadMargin
  }
}
window.addEventListener('pointermove', pointerMove)
window.addEventListener('pointerup', event => endDrag(event.pointerId, true))
window.addEventListener('pointercancel', event => endDrag(event.pointerId, false))
window.addEventListener('blur', () => endDrag(drag?.pointer, false))
window.addEventListener('keydown', event => {
  // isComposing can be false at the start or end of IME input.
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape' && punch) {
    event.preventDefault()
    cancelPunch()
    return
  }
  if (event.key === 'Escape' && drag) endDrag(drag.pointer, false)
  if (event.key === 'Escape' && marquee) endMarquee({ pointerId: marquee.id }, false)
  if (event.key === 'Escape' && !findPanel.hidden) {
    event.preventDefault()
    closeFindPanel()
    return
  }
  if (switchingProject || document.querySelector('dialog[open]')) return
  if (event.key === 'Escape' && monitor.classList.contains('preview-maximized')) {
    event.preventDefault()
    setPreviewMaximized(false)
    return
  }
  if (event.key === 'Escape' && linkStart) {
    linkStart = undefined
    renderViewport()
    status('已取消配对')
    return
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
    const command = { n: 'new-project', o: 'open-project', i: 'import-subtitles', e: 'export-subtitles', f: 'menu-find', q: 'menu-quit' }[event.key.toLowerCase()]
    if (command) {
      event.preventDefault()
      if (!event.repeat) $(command).click()
      return
    }
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (!event.repeat) $(event.shiftKey ? 'save-project-as' : 'save-project').click()
    return
  }
  // 全局快捷键优先于刚点过的控件：空格播放/暂停，左右方向键移动播放头；文本框和菜单保留自己的键盘操作。
  const field = event.target.closest?.('input, textarea, [contenteditable="true"]')
  const typing = Boolean(field) && (field.tagName === 'TEXTAREA' || field.isContentEditable ||
    !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color'].includes(field.type))
  const localKeys = typing || Boolean(event.target.closest?.('[role="menu"], dialog'))
  if (!localKeys && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (!event.repeat && !event.shiftKey && (event.key === 'j' || event.key === 'k') && punchAvailable()) {
      event.preventDefault()
      beginPunch(event.key)
      return
    }
    if (event.code === 'Space') {
      event.preventDefault()
      if (!$('play').disabled && !event.repeat) $('play').click()
      return
    }
    if (!drag && !marquee && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      nudgePlayhead(event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey)
      return
    }
  }
  if (event.target.closest?.('input,textarea,select,dialog')) return
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
    const key = event.key.toLowerCase()
    if (key === 'c') {
      event.preventDefault()
      copySelection()
    } else if (key === 'v') {
      event.preventDefault()
      pasteTimelineCue()
    } else if (key === 'a') {
      event.preventDefault()
      selectTrackCues()
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) restore(redo, undo)
    else restore(undo, redo)
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && !event.repeat &&
      !event.metaKey && !event.ctrlKey && !event.altKey &&
      (findCue(project, selected) || selectedCues.size)) {
    event.preventDefault()
    deleteSelectedCue()
  }
})
for (const eventName of ['input', 'change']) {
  document.querySelector('.inspector').addEventListener(eventName, event => {
    const form = event.target.closest('#cue-form, #style-editor form')
    if (!form) return
    recordDraft(form)
    updateProjectTitle()
    if (event.target === $('cue-text') && !cuePreviewFrame) {
      cuePreviewFrame = requestAnimationFrame(() => {
        cuePreviewFrame = 0
        refreshInspectorPreview()
      })
    }
  })
}
// 界面文字只作为界面展示，禁止拖拽选中或生成原生拖拽幽灵图；输入框和字幕编辑框例外。
for (const type of ['dragstart', 'selectstart']) {
  document.addEventListener(type, event => {
    if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return
    event.preventDefault()
  })
}

window.addEventListener('beforeunload', event => {
  if (!allowWindowClose && closeNeedsConfirmation()) {
    event.preventDefault()
    event.returnValue = false
  }
})
scroll.addEventListener('scroll', renderViewport, { passive: true })
$('zoom').addEventListener('input', () => {
  const anchor = zoomAnchor()
  setZoom(Number($('zoom').value), anchor.time, anchor.offset)
})

// The two seconds after the content participate in scrolling, but do not set the fit scale.
function contentTime() {
  return timelineEnd() + timelineTail
}

function fitDuration() {
  return mediaDuration || timelineEnd()
}

function zoomBounds(usable) {
  const min = usable * 1000 / fitDuration()
  return { min, max: Math.max(min, 960, frameTickSpacing * 1000 / frameGap) }
}

function setZoom(next, anchor, offset = 0) {
  const { min, max } = zoomBounds(timelineView().usable)
  fitZoom = next <= min + .001
  pixelsPerSecond = Math.min(max, Math.max(min, next))
  renderViewport()
  if (fitZoom) scroll.scrollLeft = 0
  else if (anchor !== undefined) scroll.scrollLeft = Math.max(0, width(anchor) - offset)
  updatePreview()
}

function zoomAnchor() {
  const { usable } = timelineView()
  const position = playheadPosition()
  const start = deltaFor(scroll.scrollLeft)
  const end = deltaFor(scroll.scrollLeft + usable)
  if (position >= start && position <= end) {
    // 播放头当前可见：缩放时保持它在屏幕上的位置，确保一直可见。
    return { time: Math.round(position), offset: Math.max(0, width(position) - scroll.scrollLeft) }
  }
  // 播放头不在可视范围：按当前能看到的第一帧（最左侧时间）缩放。
  return { time: start, offset: 0 }
}

function zoomBy(factor) {
  const anchor = zoomAnchor()
  setZoom(pixelsPerSecond * factor, anchor.time, anchor.offset)
}

function wheelZoomFactor(deltaY) {
  return Math.min(1.5, Math.max(0.66, Math.exp(-deltaY * 0.0018)))
}

let zoomMetrics
function renderZoomBar() {
  const barWidth = zoomBar.clientWidth
  if (!barWidth) return
  const { usable, maxScroll } = timelineView()
  const thumbWidth = fitZoom ? barWidth : Math.min(barWidth - 1, Math.max(ZOOM_THUMB_MIN, Math.floor(usable / width(fitDuration()) * barWidth)))
  const travel = barWidth - thumbWidth
  const thumbLeft = maxScroll > 0 ? Math.round(travel * Math.min(1, scroll.scrollLeft / maxScroll)) : 0
  zoomThumb.style.width = thumbWidth + 'px'
  zoomThumb.style.transform = 'translateX(' + thumbLeft + 'px)'
  zoomMetrics = { barWidth, thumbWidth, thumbLeft, travel, maxScroll, usable }
  updateZoomPlayhead()
  zoomBar.setAttribute('aria-valuemin', '0')
  zoomBar.setAttribute('aria-valuemax', String(Math.round(maxScroll)))
  zoomBar.setAttribute('aria-valuenow', String(Math.round(Math.min(scroll.scrollLeft, maxScroll))))
  zoomBar.setAttribute('aria-valuetext', printTime(deltaFor(scroll.scrollLeft), '.') + ' 起 · ' + Math.round(pixelsPerSecond) + ' 像素每秒')
}

// 播放头滚出时间轴视口时，在底部滚动条上留一条红线标出它的位置。
function updateZoomPlayhead() {
  if (!zoomMetrics) return
  const { barWidth, thumbLeft, travel, maxScroll, usable } = zoomMetrics
  const position = playheadPosition()
  const visibleStart = deltaFor(scroll.scrollLeft)
  const visibleEnd = deltaFor(scroll.scrollLeft + usable)
  const outside = position < visibleStart - .5 || position > visibleEnd + .5
  zoomPlayhead.hidden = !outside || maxScroll <= 0
  if (zoomPlayhead.hidden) return
  const x = thumbLeft + (width(position) - scroll.scrollLeft) * travel / maxScroll
  zoomPlayhead.style.left = Math.max(0, Math.min(barWidth - 2, Math.round(x))) + 'px'
}

let zoomDrag
function startZoomDrag(event, kind, edge) {
  const { usable, maxScroll } = timelineView()
  zoomDrag = {
    pointer: event.pointerId,
    kind,
    edge,
    startX: event.clientX,
    startScroll: scroll.scrollLeft,
    startSpan: usable * 1000 / pixelsPerSecond,
    barWidth: zoomBar.clientWidth,
    travel: zoomBar.clientWidth - zoomThumb.offsetWidth,
    duration: fitDuration(),
    contentDuration: timelineEnd() + timelineTail,
    usable,
    maxScroll,
    anchor: zoomAnchor(),
  }
  zoomBar.focus({ preventScroll: true })
  zoomThumb.classList.add('dragging')
  // 抓住任意一侧把柄时，两侧把柄一起加粗描边，提示正在缩放。
  if (kind === 'zoom') zoomThumb.classList.add('gripping')
  event.preventDefault()
  event.stopPropagation()
  event.currentTarget.setPointerCapture(event.pointerId)
}

zoomThumb.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('.zoom-grip')) return
  startZoomDrag(event, 'scroll')
})
for (const grip of zoomBar.querySelectorAll('.zoom-grip')) {
  grip.addEventListener('pointerdown', event => {
    if (event.button === 0) startZoomDrag(event, 'zoom', grip.dataset.edge)
  })
}

// 与 renderZoomBar 相同的布局公式：给定可见跨度，算出左右把柄在缩放条上的位置，
// 供把柄拖动时反解倍率。滑块宽度触底后这段映射会出现平台，调用方另行处理。
function zoomGripAt(span) {
  const { usable, barWidth, duration, contentDuration, anchor, edge } = zoomDrag
  if (span >= duration - .001) return edge === 'left' ? 0 : barWidth
  const pxPerSecond = usable * 1000 / span
  const thumbWidth = Math.min(barWidth - 1, Math.max(ZOOM_THUMB_MIN, Math.floor(usable / (duration * pxPerSecond / 1000) * barWidth)))
  const contentWidth = Math.max(usable, contentDuration * pxPerSecond / 1000)
  const maxScroll = Math.max(0, contentWidth - usable)
  const scrollLeft = Math.max(0, anchor.time * pxPerSecond / 1000 - anchor.offset)
  const thumbLeft = maxScroll > 0 ? (barWidth - thumbWidth) * Math.min(1, scrollLeft / maxScroll) : 0
  return edge === 'left' ? thumbLeft : thumbLeft + thumbWidth
}
// 把柄的指针位置反解成可见跨度。滑块宽度有 24px 下限，长工程缩放到一定程度后
// 把柄位置会停住不再变化；越过这段平台后按对数比例继续缩放，拖到条边时能到最大倍率。
function zoomSpanForGrip(dx) {
  const { startSpan, duration, usable, edge, barWidth } = zoomDrag
  const startGrip = zoomGripAt(startSpan)
  const target = startGrip + dx
  const minSpan = usable * 1000 / zoomBounds(usable).max
  // 滑块宽度触底（floor(barWidth * span / duration) <= 24）的跨度上界。
  const clampSpan = Math.min(duration, Math.max(minSpan, (ZOOM_THUMB_MIN + 1) * duration / barWidth))
  const hasPlateau = clampSpan > minSpan + .5
  const inwardExtreme = edge === 'right' ? 0 : barWidth
  const outwardExtreme = edge === 'right' ? barWidth : 0
  const logSpan = (from, to, fraction) => from * Math.pow(to / from, Math.max(0, Math.min(1, fraction)))
  const inward = edge === 'right' ? target < startGrip : target > startGrip
  if (hasPlateau && startSpan <= clampSpan + .5) {
    // 起点已经在平台里：把柄不再移动，按指针离条边的距离对倍率做对数映射。
    const travel = Math.abs((inward ? inwardExtreme : outwardExtreme) - startGrip)
    return inward
      ? logSpan(startSpan, minSpan, Math.abs(target - startGrip) / Math.max(1, travel))
      : logSpan(startSpan, duration, Math.abs(target - startGrip) / Math.max(1, travel))
  }
  if (hasPlateau) {
    const clampGrip = zoomGripAt(clampSpan)
    if (edge === 'right' ? target < clampGrip - .5 : target > clampGrip + .5) {
      const travel = Math.abs(clampGrip - inwardExtreme)
      return logSpan(clampSpan, minSpan, Math.abs(target - clampGrip) / Math.max(1, travel))
    }
  }
  // 滑块宽度还没触底时仍然让把柄跟手：在候选跨度里找把柄位置最接近指针的一个。
  let best = startSpan
  let bestError = Infinity
  const steps = 96
  for (let index = 0; index <= steps; index++) {
    const span = minSpan + (duration - minSpan) * index / steps
    const error = Math.abs(zoomGripAt(span) - target)
    if (error < bestError) {
      bestError = error
      best = span
    }
  }
  let step = (duration - minSpan) / steps
  for (let round = 0; round < 10; round++) {
    step /= 2
    for (const span of [best - step, best + step]) {
      if (span < minSpan || span > duration) continue
      const error = Math.abs(zoomGripAt(span) - target)
      if (error < bestError) {
        bestError = error
        best = span
      }
    }
  }
  return best
}
function pointerZoomMove(event) {
  if (!zoomDrag || event.pointerId !== zoomDrag.pointer) return
  const dx = event.clientX - zoomDrag.startX
  if (zoomDrag.kind === 'scroll') {
    if (zoomDrag.travel > 0) scroll.scrollLeft = zoomDrag.startScroll + dx * zoomDrag.maxScroll / zoomDrag.travel
    return
  }
  const { usable } = zoomDrag
  setZoom(usable * 1000 / zoomSpanForGrip(dx), zoomDrag.anchor.time, zoomDrag.anchor.offset)
}

function endZoomDrag(event) {
  if (!zoomDrag || (event && event.pointerId !== zoomDrag.pointer)) return
  zoomDrag = undefined
  zoomThumb.classList.remove('dragging', 'gripping')
}

window.addEventListener('pointermove', pointerZoomMove)
window.addEventListener('pointerup', endZoomDrag)
window.addEventListener('pointercancel', endZoomDrag)
window.addEventListener('blur', () => endZoomDrag())

zoomBar.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target === zoomThumb || zoomThumb.contains(event.target)) return
  const rect = zoomBar.getBoundingClientRect()
  const span = timelineView().usable * 1000 / pixelsPerSecond
  const fraction = (event.clientX - rect.left) / rect.width
  scroll.scrollLeft = Math.max(0, width(fraction * fitDuration() - span / 2))
})

zoomBar.addEventListener('keydown', event => {
  const { maxScroll } = timelineView()
  if (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_') {
    event.preventDefault()
    const factor = event.key === '-' || event.key === '_' ? 1 / 1.25 : 1.25
    zoomBy(factor)
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    scroll.scrollLeft = event.key === 'Home' ? 0 : maxScroll
  }
})

scroll.addEventListener('wheel', event => {
  const zooming = event.ctrlKey ||
    (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX) && event.deltaY !== 0)
  if (zooming) {
    event.preventDefault()
    zoomBy(wheelZoomFactor(event.deltaY))
    return
  }
  const horizontal = event.shiftKey ? event.deltaY : event.deltaX
  if (!horizontal) return
  event.preventDefault()
  scroll.scrollLeft += horizontal
}, { passive: false })

zoomBar.addEventListener('wheel', event => {
  const zooming = !event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)
  if (zooming) {
    event.preventDefault()
    zoomBy(wheelZoomFactor(event.deltaY))
    return
  }
  const { maxScroll } = timelineView()
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (!delta) return
  event.preventDefault()
  scroll.scrollLeft = Math.max(0, Math.min(maxScroll, scroll.scrollLeft + delta * (event.shiftKey ? 3 : 1)))
}, { passive: false })

new ResizeObserver(renderViewport).observe(scroll)
new ResizeObserver(renderZoomBar).observe(zoomBar)
new ResizeObserver(fitPicture).observe(stage)

function connectDivider(id, horizontal) {
  const divider = $(id)
  const parent = divider.parentElement
  const property = horizontal ? '--timeline-height' : '--inspector-width'
  const limit = horizontal ? 190 : 255
  function apply(pixels, total) {
    parent.style.setProperty(property, Math.max(limit, Math.min(total * .62, pixels)) + 'px')
    updateTabPages()
  }
  const handle = divider.querySelector('.divider-handle')
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    divider.focus({ preventScroll: true })
    handle.setPointerCapture(event.pointerId)
  })
  handle.addEventListener('pointermove', event => {
    if (!handle.hasPointerCapture(event.pointerId)) return
    const box = parent.getBoundingClientRect()
    if (horizontal) apply(box.bottom - event.clientY, box.height)
    else apply(box.right - event.clientX, box.width)
  })
  divider.addEventListener('keydown', event => {
    const backwards = horizontal ? 'ArrowUp' : 'ArrowLeft'
    const forwards = horizontal ? 'ArrowDown' : 'ArrowRight'
    if (event.key !== backwards && event.key !== forwards) return
    event.preventDefault()
    const box = parent.getBoundingClientRect()
    const panel = divider.nextElementSibling.getBoundingClientRect()
    const size = horizontal ? panel.height : panel.width
    apply(size + (event.key === backwards ? 16 : -16), horizontal ? box.height : box.width)
  })
}
connectDivider('horizontal-divider', true)
connectDivider('vertical-divider', false)
$('play').disabled = true
ensureSelection()
render()
setTimeout(() => { void initializeAutosave() }, 300)

bindComposition({
  project: () => project,
  currentTrack: track,
  hasDraft: hasPendingForm,
  report: status,
  media: () => ({
    ready: hasPicture(),
    name: $('media-name').textContent,
    width: isSolid() ? solidMedia.width : video.videoWidth,
    height: isSolid() ? solidMedia.height : video.videoHeight,
    duration: isSolid() ? solidMedia.duration / 1000 : video.duration,
    solid: isSolid() ? solidMedia : null,
    pause: pausePlayback,
  }),
})

// ---- 视频水印：图片选择、位置/尺寸/透明度与预览叠加 ----
function watermarkImageSettings() {
  const settings = project.settings
  const image = settings?.watermarkImage
  if (!settings?.watermark || !image?.path) return null
  return {
    path: image.path,
    scale: Math.max(1, Math.min(100, Number(image.scale) || 14)),
    x: Math.max(0, Math.min(100, Number(image.x) || 0)),
    y: Math.max(0, Math.min(100, Number(image.y) || 0)),
    opacity: Math.max(0, Math.min(100, Number.isFinite(Number(image.opacity)) ? Number(image.opacity) : 80)),
  }
}
function applyWatermarkOverlay() {
  const node = $('watermark-overlay')
  if (!node) return
  const image = watermarkImageSettings()
  if (!image || !watermarkCache.url || !hasPicture()) {
    node.hidden = true
    return
  }
  if (node.getAttribute('src') !== watermarkCache.url) node.src = watermarkCache.url
  node.hidden = false
  node.style.width = Math.max(8, frame.clientWidth * image.scale / 100) + 'px'
  node.style.left = image.x + '%'
  node.style.top = image.y + '%'
  node.style.opacity = String(image.opacity / 100)
}
async function syncWatermarkImage() {
  const image = watermarkImageSettings()
  if (!image) {
    watermarkCache = { path: '', url: '', tried: false }
    applyWatermarkOverlay()
    return
  }
  if (watermarkCache.path === image.path && watermarkCache.tried) {
    applyWatermarkOverlay()
    return
  }
  watermarkCache = { path: image.path, url: '', tried: true }
  const loaded = await app.readWatermark(image.path).catch(() => null)
  if (watermarkCache.path !== image.path) return
  watermarkCache.url = loaded?.dataUrl ?? ''
  applyWatermarkOverlay()
}
function watermarkDefaults(path, name) {
  return { path, name, scale: 14, x: 78, y: 6, opacity: 80 }
}
function setWatermarkImage(patch) {
  const current = project.settings?.watermarkImage ?? watermarkDefaults('', '')
  project.settings = {
    fade: false, watermark: false, fadeDuration: 100, ...project.settings,
    watermarkImage: { ...current, ...patch },
  }
}
$('watermark-choose').addEventListener('click', async () => {
  const picked = await app.chooseWatermark().catch(error => { status(errorText(error), 'error'); return null })
  if (!picked) return
  watermarkCache = { path: picked.path, url: picked.dataUrl, tried: true }
  edit(() => {
    setWatermarkImage(watermarkDefaults(picked.path, picked.name))
    project.settings.watermark = true
  })
  $('project-watermark').checked = true
})
for (const [key, id, min, max] of [['scale', 'watermark-scale', 1, 100], ['opacity', 'watermark-opacity', 0, 100],
  ['x', 'watermark-x', 0, 100], ['y', 'watermark-y', 0, 100]]) {
  $(id).addEventListener('change', event => {
    const value = Math.max(min, Math.min(max, Math.round(Number(event.target.value) || 0)))
    event.target.value = String(value)
    edit(() => setWatermarkImage({ [key]: value }))
  })
}

