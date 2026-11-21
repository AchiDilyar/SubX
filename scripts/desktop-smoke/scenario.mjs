import assert from 'node:assert/strict'
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog, Menu, nativeTheme, net } from 'electron'
import { verifyPreviewPerformance } from './preview-performance.mjs'

const directory = process.env.SUBX_SMOKE_DIRECTORY
const previewMedia = process.env.SUBX_PREVIEW_MEDIA
app.setPath('userData', join(directory, 'profile'))

// Substitute only the native pickers. IPC, media, rendering and writes use the app's normal entry points.
const picks = previewMedia ? [previewMedia, 'input.srt', 'styles.ass'] : [
  'video.mp4', 'unplayable.mp4', 'broken-encoding.srt', 'mixed.srt', 'mixed.srt', 'bad-timing.srt', 'input.srt',
  'saved.subx', 'saved.subx', null, 'unplayable.mp4', 'moved-video.mp4', 'saved.subx',
  'styles.ass', 'other-styles.ass', null, 'alignment-bottom.srt', 'alignment-top.srt',
]
const saves = previewMedia ? ['before.ass', 'after.ass'] : [
  'saved.subx', 'saved.subx', 'copied.subx', 'track.srt', 'converted.srt', 'roundtrip.ass', 'opacity.ass', 'opacity-rgb.ass', 'styled.ass', 'mutated.ass',
  'other.ass', 'first.ass', 'renamed.ass', 'default-renamed.ass', null, 'alignment.subx', 'close-after-save.subx', null,
]
function nextPath(queue) {
  assert(queue.length, 'Unexpected file picker')
  const name = queue.shift()
  if (name === null) return undefined
  return isAbsolute(name) ? name : join(directory, name)
}
dialog.showOpenDialog = async () => {
  const path = nextPath(picks)
  return { filePaths: path ? [path] : [] }
}
let beforeSavePath
dialog.showSaveDialog = async (_window, options) => {
  if (process.env.SUBX_FFMPEG_PATH && options.filters?.some(filter => filter.extensions.includes('mp4'))) {
    return { filePath: join(directory, 'burned.mp4') }
  }
  const callback = beforeSavePath
  beforeSavePath = undefined
  await callback?.()
  return { filePath: nextPath(saves) }
}

try {
  await import('../../src/main/main.mjs')
  app.whenReady().then(run).then(() => app.exit(0), fail)
} catch (error) {
  fail(error)
}

function fail(error) {
  console.error(error)
  app.exit(1)
}

async function run() {
  let window
  for (let attempt = 0; attempt < 100 && !window; attempt++) {
    window = BrowserWindow.getAllWindows()[0]
    if (!window) await delay(100)
  }
  assert(window, 'SubX did not open a BrowserWindow')
  window.setContentSize(1280, 800)

  const contents = window.webContents
  contents.backgroundThrottling = false
  if (previewMedia) {
    window.setIgnoreMouseEvents(true)
    window.setFocusable(false)
    window.showInactive()
  } else {
    window.hide()
    contents.debugger.attach('1.3')
  }
  const mouse = (type, x, y, clickCount = 1) => contents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: type === 'mouseMoved' ? 0 : clickCount,
  })
  const wheel = (x, y, deltaY, deltaX = 0, modifiers = 0) => contents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX, deltaY, modifiers, button: 'none', clickCount: 0,
  })
  const exec = code => contents.executeJavaScript(code, true)
  const click = id => exec('document.getElementById(' + JSON.stringify(id) + ').click()')
  async function expect(code, description) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await exec(code)) {
        console.log('PASS ' + description)
        return
      }
      await delay(100)
    }
    const status = await exec('document.getElementById("status")?.textContent')
    throw Error(description + ': ' + status)
  }

  await expect('document.getElementById("ruler").children.length > 0', 'load Electron workspace')
  assert.equal(await exec('getComputedStyle(document.querySelector("#styles-tab .icon")).color'), 'rgb(255, 255, 255)', 'Show the active tab icon in white')
  await click('settings-tab')
  assert.equal(await exec('getComputedStyle(document.querySelector("#settings-tab .icon")).color'), 'rgb(255, 255, 255)', 'Show the other active tab icon in white')
  assert.notEqual(await exec('getComputedStyle(document.querySelector("#styles-tab .icon")).color'), 'rgb(255, 255, 255)', 'Keep inactive tab icons muted')
  await click('styles-tab')
  const wordmarks = await exec(`(() => {
    const brand = document.querySelector('.brand img')
    const empty = document.querySelector('.empty-wordmark')
    const stage = document.querySelector('.monitor-stage').getBoundingClientRect()
    const box = empty.getBoundingClientRect()
    const style = getComputedStyle(empty)
    return { loaded: brand.complete && brand.naturalWidth > 0 && empty.complete && empty.naturalWidth > 0,
      brandFit: getComputedStyle(brand).objectFit === 'contain',
      centered: Math.abs((box.left + box.right) / 2 - (stage.left + stage.right) / 2) < 1 && Math.abs((box.top + box.bottom) / 2 - (stage.top + stage.bottom) / 2) < 1,
      white: style.filter.includes('invert(1)'), translucent: Number(style.opacity) > 0 && Number(style.opacity) < 1,
      messageHidden: document.querySelector('#empty-video-message').hidden }
  })()`)
  assert(wordmarks.loaded && wordmarks.brandFit && wordmarks.centered && wordmarks.white && wordmarks.translucent && wordmarks.messageHidden, 'Show the wordmark correctly in the brand and empty preview')
  assert.equal(await exec('getComputedStyle(document.querySelector("#quit-dialog")).display'), 'none', 'Keep the quit dialog hidden before any close request')
  assert.deepEqual(await exec('[...document.querySelectorAll(".menu-trigger")].map(button => button.textContent)'), ['文件', '编辑', '导出', '关于'], 'Expose the four top-level menus')
  if (process.platform === 'darwin') {
    await delay(600)
    const nativeMenus = Menu.getApplicationMenu().items
    assert.deepEqual(nativeMenus.slice(1).map(item => item.label), ['文件', '编辑', '导出', '关于'], 'Match the native menu groups')
    const nativeEdit = nativeMenus.find(item => item.label === '编辑')
    nativeEdit.submenu.items.find(item => item.label === '1/4 预览').click()
    await expect('document.querySelector("#quality").value === "4"', 'execute a native menu command')
    await exec('(() => { const quality = document.querySelector("#quality"); quality.value = "1"; quality.dispatchEvent(new Event("change")) })()')
  }
  await click('menu-file')
  await expect('!document.querySelector("#menu-file-popup").hidden && document.querySelector("#menu-file").getAttribute("aria-expanded") === "true"', 'open the file menu with icon items')
  assert.deepEqual(await exec('[...document.querySelectorAll("#menu-file-popup button")].map(button => button.id)'), ['new-project', 'open-project', 'recent-projects', 'save-project', 'save-project-as', 'menu-open-media', 'import-subtitles', 'menu-quit'], 'List the file commands in order')
  assert(await exec('[...document.querySelectorAll("#menu-file-popup button")].every(button => button.querySelector("svg use"))'), 'Give every file command an icon')
  await mouse('mousePressed', 700, 250)
  await mouse('mouseReleased', 700, 250)
  await expect('document.querySelector("#menu-file-popup").hidden && document.querySelector("#menu-file").getAttribute("aria-expanded") === "false"', 'close the file menu when clicking outside')
  await click('menu-edit')
  await expect('!document.querySelector("#menu-edit-popup").hidden', 'open the edit menu')
  await click('menu-quality-4')
  await expect('document.querySelector("#quality").value === "4"', 'switch the preview quality from the edit menu')
  await exec('(() => { const quality = document.querySelector("#quality"); quality.value = "1"; quality.dispatchEvent(new Event("change")) })()')
  await click('menu-about')
  await click('menu-shortcuts')
  await expect('document.querySelector("#shortcuts-dialog").open', 'open the shortcuts window from the about menu')
  await exec('document.querySelector("#shortcuts-dialog button").click()')
  await expect('!document.querySelector("#shortcuts-dialog").open && document.querySelector("#menu-about-popup").hidden', 'close the shortcuts window and its menu')
  assert(await exec('document.querySelector("#open-media").closest(".monitor") === null'), 'Remove the open-video button from the preview panel')
  assert.equal(await exec('document.querySelector("#split-tool use").getAttribute("href")'), '#i-razor', 'Use a razor icon for the razor tool')
  for (const id of ['play', 'fullscreen-preview']) {
    assert(await exec(`(() => { const style = getComputedStyle(document.getElementById("${id}")); return style.backgroundColor === "rgba(0, 0, 0, 0)" && style.borderTopColor === "rgba(0, 0, 0, 0)" })()`), 'Keep preview icon buttons transparent')
  }
  assert.equal(await exec('getComputedStyle(document.querySelector("#quality")).appearance'), 'none', 'Use the aligned custom select arrow')
  const trackButtons = await exec('[...document.querySelectorAll(".heading-actions button")].map(button => button.id)')
  assert.deepEqual(trackButtons, ['add-track', 'delete-track'], 'Place delete track immediately after add track')
  const missingTooltips = await exec(`[...document.querySelectorAll('button')].filter(button =>
    button.querySelector('svg') && !button.textContent.trim() &&
    !button.title && !button.dataset.tooltip && !button.getAttribute('aria-label')).map(button => button.id || button.className)`)
  assert.deepEqual(missingTooltips, [], 'Give every icon-only button a tooltip label')
  const addTrackBox = await exec(`(() => { const r = document.querySelector('#add-track').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await mouse('mouseMoved', addTrackBox.x, addTrackBox.y)
  await expect('!document.querySelector(".icon-tooltip").hidden && document.querySelector(".icon-tooltip").textContent === "添加轨道"', 'show the add-track tooltip on hover')
  const deleteTrackBox = await exec(`(() => { const r = document.querySelector('#delete-track').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await mouse('mouseMoved', deleteTrackBox.x, deleteTrackBox.y)
  await expect('!document.querySelector(".icon-tooltip").hidden && document.querySelector(".icon-tooltip").textContent === "删除轨道"', 'show the delete-track tooltip on hover')
  await mouse('mouseMoved', 700, 250)
  const undoBox = await exec(`(() => { const b = document.querySelector('#undo'); const r = b.getBoundingClientRect(); return { disabled: b.disabled, x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  assert(undoBox.disabled, 'Start with undo unavailable')
  await mouse('mouseMoved', undoBox.x, undoBox.y)
  await expect('!document.querySelector(".icon-tooltip").hidden && document.querySelector(".icon-tooltip").textContent === "撤销"', 'show a tooltip for a disabled icon button')
  await mouse('mouseMoved', 700, 250)
  const initialTracks = await exec('document.querySelectorAll(".track-heading").length')
  await click('add-track')
  await expect(`document.querySelectorAll(".track-heading").length === ${initialTracks + 1}`, 'add a track from the heading')
  await click('delete-track')
  await expect(`document.querySelectorAll(".track-heading").length === ${initialTracks}`, 'delete the selected track from the heading')
  await click('undo')
  await expect(`document.querySelectorAll(".track-heading").length === ${initialTracks + 1}`, 'undo the track deletion')
  await click('undo')
  await expect(`document.querySelectorAll(".track-heading").length === ${initialTracks}`, 'restore the initial tracks')
  if (process.env.SUBX_MENU_ONLY) {
    const iconAudit = await exec(`(async () => {
      const uses = [...document.querySelectorAll('.icon use[href^="#i-"]')]
      const failures = []
      for (const use of uses) {
        const icon = use.closest('.icon')
        const css = getComputedStyle(icon)
        if (css.maskImage === 'none' || css.backgroundColor === 'rgba(0, 0, 0, 0)') failures.push(use.getAttribute('href'))
      }
      const ids = [...document.querySelectorAll('.icon-library symbol')].map(el => el.id.slice(2))
      const loads = await Promise.all(ids.map(async id => [id, (await fetch('../assets/icons/' + id + '.png')).ok]))
      return { failures, missing: loads.filter(([, ok]) => !ok).map(([id]) => id), count: ids.length }
    })()`)
    assert.equal(iconAudit.count, 49, 'Cover every existing icon symbol')
    assert.deepEqual(iconAudit.failures, [], 'Give every visible icon a colorable mask')
    assert.deepEqual(iconAudit.missing, [], 'Load every icon asset through the app protocol')
    const inherited = await exec(`(() => { const icon = document.querySelector('#select-tool .icon'); const old = icon.style.color; icon.style.color = 'rgb(23, 62, 118)'; const ok = getComputedStyle(icon).backgroundColor === 'rgb(23, 62, 118)'; icon.style.color = old; return ok })()`)
    assert(inherited, 'Let icon masks inherit their current state color')
    await click('waveform-mode')
    assert(await exec('getComputedStyle(document.querySelector("#waveform-mode .icon")).maskImage.includes("wave-asymmetric.png")'), 'Switch icon masks for dynamic state changes')
    await click('waveform-mode')
    await click('waveform-mode')

    const capture = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
    await writeFile('/private/tmp/subx-icons-check.png', Buffer.from(capture.data, 'base64'))
    const squares = await exec(`[...document.querySelectorAll('.timeline-controls button, .toolrail button, .heading-actions button, .track-heading button')].every(button => { const r = button.getBoundingClientRect(); return Math.abs(r.width - r.height) < .01 })`)
    assert(squares, 'Keep timeline icon buttons square')
    assert.equal(await exec('getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase()'), '#173e76')
    await click('fullscreen-preview')
    assert(await exec(`(() => { const bar = document.querySelector('.appbar').getBoundingClientRect(); const monitor = document.querySelector('.monitor').getBoundingClientRect(); return monitor.top >= bar.bottom && getComputedStyle(document.querySelector('.preview-progress')).display !== 'none' })()`), 'Keep the menu and show the preview progress bar')
    await click('menu-file')
    await expect('!document.querySelector("#menu-file-popup").hidden', 'keep the menu usable in fullscreen preview')
    await click('menu-file')
    await click('fullscreen-preview')
    await click('menu-open-media')
    await expect('document.querySelector("#video").readyState >= 2', 'open video through the file menu')
    await click('fullscreen-preview')
    await exec('(() => { const p = document.querySelector("#preview-progress"); p.value = "500"; p.dispatchEvent(new Event("input", { bubbles: true })) })()')
    await expect('Math.abs(document.querySelector("#video").currentTime - document.querySelector("#video").duration / 2) < 0.2', 'seek through the fullscreen preview progress bar')
    await click('fullscreen-preview')
    if (process.platform === 'darwin') {
      await click('menu-shortcuts')
      await delay(600)
      const edit = Menu.getApplicationMenu().items.find(item => item.label === '编辑')
      assert(edit.submenu.items.every(item => item.type === 'separator' || !item.enabled), 'Disable native commands while a dialog is open')
      await exec('document.querySelector("#shortcuts-dialog button").click()')
    }
    return
  }
  const previewControls = await exec(`(() => {
    const monitor = document.querySelector('.monitor')
    const monitorBox = monitor.getBoundingClientRect()
    const playBox = document.querySelector('#play').getBoundingClientRect()
    return {
      grouped: [document.querySelector('#timecode'), document.querySelector('#play'), document.querySelector('#quality'), document.querySelector('#fullscreen-preview')].every(node => monitor.contains(node)),
      playCentered: Math.abs((playBox.left + playBox.right) / 2 - (monitorBox.left + monitorBox.right) / 2) < 2,
      timecodeFirst: monitor.querySelector('.monitor-controls output') === monitor.querySelector('#timecode'),
    }
  })()`)
  assert(previewControls.grouped, 'Group the timecode, play, quality and fullscreen controls inside the preview panel')
  assert(previewControls.playCentered && previewControls.timecodeFirst, 'Center the play button with the timecode on the left')
  await click('fullscreen-preview')
  await expect('document.querySelector(".monitor").classList.contains("preview-maximized") && document.querySelector("#fullscreen-preview").getAttribute("aria-pressed") === "true"', 'maximize the video preview from the new control bar')
  await click('fullscreen-preview')
  await expect('!document.querySelector(".monitor").classList.contains("preview-maximized")', 'restore the video preview from the new control bar')
  await click('fullscreen-preview')
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await expect('!document.querySelector(".monitor").classList.contains("preview-maximized")', 'leave the fullscreen preview with Escape')
  const timelineLayout = JSON.parse(await exec(`JSON.stringify({
    rail: [...document.querySelectorAll('.toolrail button')].map(button => button.id),
    actions: [...document.querySelectorAll('.timeline-actions button')].map(button => button.id),
    states: [...document.querySelectorAll('.timeline-states button')].map(button => button.id),
    addTrack: Boolean(document.querySelector('.heading-spacer #add-track')) && document.querySelector('.heading-spacer #add-track').textContent.trim() === '',
    menuDeleteTrack: Boolean(document.querySelector('#menu-edit-popup #menu-delete-track')),
    menuSplit: Boolean(document.querySelector('#menu-edit-popup #split-track')),
    toolbarSplit: Boolean(document.querySelector('.timeline-controls #split-track'))
  })`))
  assert.deepEqual(timelineLayout.rail, ['select-tool', 'split-tool', 'select-forward', 'select-backward'], 'Lay out the four cursor modes on the timeline toolrail')
  assert.deepEqual(timelineLayout.actions, ['add-cue', 'undo', 'redo', 'split-cue', 'trim-start', 'trim-end', 'timeline-delete', 'toggle-marker'], 'Lay out the instant actions in the timeline header')
  assert.deepEqual(timelineLayout.states, ['snap-tool', 'waveform-mode'], 'Lay out the timeline state toggles on the right')
  assert(timelineLayout.addTrack, 'Place an icon-only add-track button in the timeline heading row')
  assert(timelineLayout.menuDeleteTrack, 'Offer a delete-track command in the edit menu')
  assert(timelineLayout.menuSplit && !timelineLayout.toolbarSplit, 'Keep the bilingual split command in the edit menu only')
  assert.equal(await exec('document.querySelector("#snap-tool").getAttribute("aria-pressed")'), 'true', 'Enable snapping by default')
  assert.equal(await exec('document.querySelector("#waveform-mode").getAttribute("aria-pressed")'), 'true', 'Show the waveform by default')
  assert.equal(await exec('document.querySelector("#waveform-mode").title.includes("对称")'), true, 'Start with the symmetric waveform')
  await click('split-tool')
  await expect(`document.querySelector('#split-tool').getAttribute('aria-pressed') === 'true' && document.querySelector('#select-tool').getAttribute('aria-pressed') === 'false'`, 'switch into split cursor mode')
  await click('select-backward')
  await expect(`document.querySelector('#select-backward').getAttribute('aria-pressed') === 'true' && document.querySelector('#split-tool').getAttribute('aria-pressed') === 'false'`, 'switch between cursor modes exclusively')
  await click('select-tool')
  const trackCountBeforeAdd = await exec('document.querySelectorAll(".track-heading").length')
  await click('add-track')
  await expect('document.querySelectorAll(".track-heading").length === ' + (trackCountBeforeAdd + 1), 'add a track from the heading-row icon button')
  await click('undo')
  await expect('document.querySelectorAll(".track-heading").length === ' + trackCountBeforeAdd, 'undo the track added from the heading icon')
  await exec('document.querySelector(".track-heading").click()')
  const trackCountBeforeDelete = await exec('document.querySelectorAll(".track-heading").length')
  await click('delete-track')
  await expect('document.querySelectorAll(".track-heading").length === ' + (trackCountBeforeDelete - 1), 'delete the current track from the toolbar button')
  await click('undo')
  await expect('document.querySelectorAll(".track-heading").length === ' + trackCountBeforeDelete, 'restore the deleted track with undo')
  await click('waveform-mode')
  await expect(`document.querySelector('#waveform').hidden === false && document.querySelector('#waveform-mode').title.includes('非对称')`, 'switch to the asymmetric waveform')
  await click('waveform-mode')
  await expect(`document.querySelector('#waveform').hidden === true && document.querySelector('#waveform-mode').title.includes('关闭')`, 'turn the waveform display off')
  await click('waveform-mode')
  await expect(`document.querySelector('#waveform').hidden === false && document.querySelector('#waveform-mode').title.includes('对称')`, 'restore the symmetric waveform')
  await click('toggle-marker')
  await expect('document.querySelectorAll("#ruler .marker").length === 1 && document.querySelector("#status").textContent.includes("标记")', 'add a timeline marker at the playhead')
  await click('toggle-marker')
  await expect('document.querySelectorAll("#ruler .marker").length === 0', 'remove the marker at the playhead')
  assert.equal(await exec('getComputedStyle(document.body).userSelect'), 'none', 'Disable native text selection in the app chrome')
  await expect("(() => { const event = new DragEvent('dragstart', { bubbles: true, cancelable: true }); document.querySelector('#status').dispatchEvent(event); return event.defaultPrevented })()", 'Block native text dragging in the app chrome')
  await expect("(() => { const event = new DragEvent('dragstart', { bubbles: true, cancelable: true }); document.querySelector('#cue-text').dispatchEvent(event); return !event.defaultPrevented })()", 'Keep native text dragging inside editable fields')
  const chooseExport = async format => {
    await click('export-subtitles')
    assert(await exec('document.querySelector("#export-format").open'), 'Offer subtitle export formats')
    await exec(`document.querySelector('#export-format button[value=${format}]').click()`)
  }
  const stylesFixture = join(directory, 'styles.ass')
  const baseAss = await readFile(stylesFixture, 'utf8')
  const withLayer = (script, layer) => script.replace(/^(Dialogue:) 0,/gm, '$1 ' + layer + ',')
  await writeFile(stylesFixture, withLayer(baseAss, previewMedia ? 1 : 2))
  if (previewMedia) return verifyPreviewPerformance({ directory, click, exec, expect, chooseExport })
  assert.deepEqual(await exec('[...document.querySelectorAll(".track-name")].map(node => node.textContent)'), ['S1', 'S0'])
  const space = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }
  for (const selector of ['#ruler', '#timeline-zoom']) {
    await exec(`document.querySelector(${JSON.stringify(selector)}).focus({ preventScroll: true })`)
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...space })
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...space })
    await expect(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).outlineStyle === 'none' &&
      getComputedStyle(document.querySelector('.timeline')).borderTopColor === 'rgb(51, 51, 51)'`,
      'keep ' + selector + ' and the panel free of focus frames after Space')
  }
  const sparseAss = baseAss.replace('Dialogue: 0,0:00:01.00', 'Dialogue: 5,0:00:01.00')
    .replace('Dialogue: 0,0:00:01.50', 'Dialogue: 7,0:00:01.50')
  await writeFile(join(directory, 'sparse.ass'), sparseAss)
  picks.unshift('sparse.ass')
  await click('import-subtitles')
  await expect(`[...document.querySelectorAll('.track-name')].map(node => node.textContent).join(',') === 'S7,S6,S5,S4,S3,S2,S1,S0' &&
    document.querySelector('.track-lane[data-layer-index="5"] .cue')?.textContent.includes('你好') &&
    document.querySelector('.track-lane[data-layer-index="7"] .cue')?.textContent.includes('备注')`, 'map ASS Layer 5 and 7 to S5 and S7')
  const cross = await exec(`(() => {
    const block = document.querySelector('.track-lane[data-layer-index="7"] .cue').getBoundingClientRect()
    const destination = document.querySelector('.track-lane[data-layer-index="6"]').getBoundingClientRect()
    return { x: block.left + 30, y: block.top + 10, to: destination.top + 13 }
  })()`)
  await mouse('mousePressed', cross.x, cross.y)
  await mouse('mouseMoved', cross.x, cross.to)
  await expect(`document.querySelector('.track-lane[data-layer-index="6"]').classList.contains('drop-target')`, 'preview a subtitle moving from S7 to S6')
  await mouse('mouseMoved', cross.x, cross.to + 2)
  await mouse('mouseReleased', cross.x, cross.to + 2)
  await expect(`document.querySelector('.track-lane[data-layer-index="6"] .cue')?.textContent.includes('备注') &&
    !document.querySelector('.track-lane[data-layer-index="7"] .cue')`, 'move the subtitle vertically without altering its timing')
  saves.unshift('layer-six.ass')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export the moved ASS from S6')
  assert.match(await readFile(join(directory, 'layer-six.ass'), 'utf8'), /^Dialogue: 6,0:00:01\.50,0:00:04\.00,/m)
  await click('undo')
  await expect(`!!document.querySelector('.track-lane[data-layer-index="7"] .cue') && !document.querySelector('.track-lane[data-layer-index="6"] .cue')`,
    'undo the cross-track move')
  await click('undo')
  await expect('document.querySelectorAll(".track-lane").length === 2 && !document.querySelector(".cue")', 'undo sparse import and restore default tracks')
  if (process.platform === 'darwin') {
    assert.deepEqual(window.getWindowButtonPosition(), { x: 14, y: 14 })
    assert.equal(window.getContentBounds().y, window.getBounds().y)
    assert(await exec('document.documentElement.classList.contains("inset-window-controls")'))
  }
  assert.equal(await exec('getComputedStyle(document.querySelector(".brand")).userSelect'), 'none')
  assert.equal(await exec('getComputedStyle(document.querySelector("#ruler")).cursor'), 'default')
  assert.equal(await exec('getComputedStyle(document.querySelector("#cue-text")).userSelect'), 'text')
  assert.equal(nativeTheme.themeSource, 'dark')
  assert.equal(nativeTheme.shouldUseDarkColors, true)
  for (const value of ['light', 'dark']) {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] })
    await expect(`matchMedia('(prefers-color-scheme: ${value})').matches &&
      getComputedStyle(document.documentElement).colorScheme === 'dark' &&
      ['.inspector', '#cue-editor-popover', '#quit-dialog'].every(selector => {
        const color = getComputedStyle(document.querySelector(selector)).backgroundColor
        return color.startsWith('rgb(') && color.match(/[0-9]+/g).every(channel => Number(channel) < 90)
      })`, `keep the workspace and dialogs dark with a ${value} appearance preference`)
  }
  await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
  await expect('!document.querySelector("#menu-preferences, #preferences-dialog, #ui-font-form")', 'remove the old interface font preference')
  await click('about-app')
  await expect("document.querySelector('#about-dialog').open && document.querySelector('#about-version').textContent.length > 0", 'show the running app version')
  await exec("document.querySelector('#about-dialog button').click()")
  await click('styles-tab')
  await expect(`(() => {
    const lanes = document.querySelector('#track-lanes')
    const rows = [...lanes.children]
    const center = box => (box.top + box.bottom) / 2
    const first = rows[0].getBoundingClientRect()
    const last = rows[1].getBoundingClientRect()
    return rows.length === 2 && Math.abs(center(lanes.getBoundingClientRect()) - (first.top + last.bottom) / 2) <= 1 &&
      Array.from(document.querySelectorAll('.tick')).at(-1).textContent === '00:00:10' &&
      document.querySelector('.style-list-item').title === '默认样式'
  })()`, 'center two starter tracks and end the empty ruler at ten seconds')
  await exec('document.querySelector(".style-list-item [aria-label=复制]").click()')
  await expect('document.querySelector(".style-list-item:last-child").title === "默认样式 副本"', 'append a copied style')
  await exec('document.querySelector(".style-list-item:last-child [aria-label=编辑]").click()')
  await expect('document.querySelector("#styles-list").hidden && !document.querySelector("#style-editor").hidden', 'replace the list with the style editor')
  await exec('document.querySelector("#style-editor [aria-label=删除]").click()')
  await expect('document.querySelector(".style-delete-confirm:popover-open")', 'anchor a confirmation to the delete button')
  await exec('document.querySelector(".style-delete-confirm:popover-open button:last-child").click()')
  await expect('!document.querySelector("#styles-list").hidden && document.querySelectorAll(".style-list-item").length === 1', 'delete a style and return to the list')
  await click('undo')
  await expect('document.querySelectorAll(".style-list-item").length === 2', 'undo style deletion')
  await click('undo')
  await click('settings-tab')
  await click('project-fade')
  await expect('document.querySelector("#project-fade").checked && !document.querySelector("#project-watermark").checked', 'change only project fade')
  await click('undo')
  await click('styles-tab')
  await click('compose-video')
  await expect("document.querySelector('#composition-dialog').open && document.querySelector('#composition-start').disabled", 'require source video and subtitles to start composition')
  await click('composition-cancel')
  const dividerPoint = id => exec(`(() => {
    const box = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  })()`)
  assert.equal(await exec("document.querySelectorAll('.divider .divider-handle').length"), 2, 'Expose a centered drag handle on each panel divider')
  const heightBeforeEdgeDrag = await exec('document.querySelector(".timeline").clientHeight')
  const dividerEdge = await exec("(() => { const box = document.querySelector('#horizontal-divider').getBoundingClientRect(); return { x: box.left + 24, y: box.top + box.height / 2 } })()")
  await mouse('mousePressed', dividerEdge.x, dividerEdge.y)
  await mouse('mouseMoved', dividerEdge.x, dividerEdge.y - 80)
  await mouse('mouseReleased', dividerEdge.x, dividerEdge.y - 80)
  assert.equal(await exec('document.querySelector(".timeline").clientHeight'), heightBeforeEdgeDrag, 'Ignore divider drags away from the centered handle')
  const vertical = await dividerPoint('vertical-divider')
  await mouse('mousePressed', vertical.x, vertical.y)
  await mouse('mouseMoved', 360, vertical.y)
  await mouse('mouseReleased', 360, vertical.y)
  const horizontal = await dividerPoint('horizontal-divider')
  await mouse('mousePressed', horizontal.x, horizontal.y)
  await mouse('mouseMoved', horizontal.x, 165)
  await mouse('mouseReleased', horizontal.x, 165)
  const wideInspector = await exec('document.querySelector(".inspector").clientWidth')
  const tallTimeline = await exec('document.querySelector(".timeline").clientHeight')
  assert(wideInspector > 760 && tallTimeline > 430, `Expand both panels with pointer input (inspector ${wideInspector}, timeline ${tallTimeline})`)
  window.setSize(...window.getMinimumSize())
  await expect('innerWidth <= 950 && innerHeight <= 660', 'shrink the Electron window to its minimum size')
  await expect(`(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect()
    return box('.monitor').width >= 340 && box('.upper').height >= 245 &&
      box('.timeline').bottom <= box('footer').top && box('footer').bottom <= innerHeight
  })()`, 'keep the preview and timeline inside the reduced viewport')
  window.setContentSize(1280, 800)
  await expect(`innerWidth === 1280 && innerHeight === 800 &&
    document.querySelector('.inspector').clientWidth === ${wideInspector} && document.querySelector('.timeline').clientHeight === ${tallTimeline}`,
  'restore the chosen panel sizes after widening the window')
  await exec(`(() => {
    const divider = document.querySelector('#horizontal-divider')
    divider.focus()
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })()`)
  await expect(`document.querySelector('.timeline').clientHeight === ${tallTimeline - 16}`, 'resize the timeline using the separator arrow key')
  await exec(`(() => {
    const divider = document.querySelector('#vertical-divider')
    divider.focus()
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })()`)
  await expect(`document.querySelector('.inspector').clientWidth === ${wideInspector - 16}`, 'resize the inspector using the separator arrow key')
  await exec(`(() => {
    document.querySelector('.workspace').style.removeProperty('--timeline-height')
    document.querySelector('.upper').style.removeProperty('--inspector-width')
    document.activeElement.blur()
  })()`)
  const pressEnter = () => contents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  }).then(() => contents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  }))
  const addCue = async text => {
    await click('add-cue')
    await expect('document.activeElement.matches(".cue.selected") && !document.querySelector("dialog[open]")', 'add and select a blank block without a dialog')
    await pressEnter()
    await expect('document.activeElement.id === "editor-text" && !document.querySelector("#cue-editor-popover").hidden', 'edit the selected cue in the inline editor with Enter')
    await exec('document.querySelector("#editor-text").value = ' + JSON.stringify(text))
    await exec('document.querySelector("#editor-text").dispatchEvent(new Event("input"))')
    await expect('document.querySelector("#editor-count").textContent === ' + JSON.stringify(String([...text].length)), 'count the characters in the inline editor')
    assert(await exec(`(() => {
      const popover = document.querySelector('#cue-editor-popover').getBoundingClientRect()
      const block = document.querySelector('.cue.selected').getBoundingClientRect()
      return popover.width === 420 && popover.bottom <= block.top - 4
    })()`), 'Anchor the inline editor to the cue block')
    await exec('document.querySelector("#editor-save").click()')
    await expect('document.querySelector("#status").textContent === "已更新字幕正文"', 'save cue text')
  }
  await addCue('第一条字幕')
  await expect('document.querySelector(".cue.selected").classList.contains("playing") && getComputedStyle(document.querySelector(".cue.selected")).color === "rgb(255, 196, 107)" && getComputedStyle(document.querySelector(".cue.selected")).backgroundColor === "rgb(168, 98, 26)"', 'highlight the cue under the playhead without changing its base fill')
  assert.equal(Math.round(await exec('document.querySelector(".cue").getBoundingClientRect().height')), 32, 'Match the cue visual height to the track height')
  assert.equal(Math.round(await exec('document.querySelector(".track-lane").getBoundingClientRect().height')), 32, 'Keep the single-lane track height at 32 pixels')
  assert.equal(await exec('document.querySelector(".cue")?.textContent'), '第一条字幕')
  assert.equal(await exec('document.querySelector("#cue-start").value'), '00:00:00.000')
  await click('add-cue')
  assert.equal(await exec('document.querySelector(".cue.selected").textContent'), '空字幕')
  const firstCue = await exec(`(() => {
    const bounds = document.querySelector('.cue:not(.selected)').getBoundingClientRect()
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
  })()`)
  for (const count of [1, 2]) {
    await mouse('mousePressed', firstCue.x, firstCue.y, count)
    await mouse('mouseReleased', firstCue.x, firstCue.y, count)
  }
  await expect('!document.querySelector("#cue-editor-popover").hidden && document.activeElement.value === "第一条字幕"', 'edit an existing block with a double click')
  await contents.debugger.sendCommand('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
  await expect('document.querySelector("#editor-text").value === "第一条字幕ni"', 'hold IME preedit in the compact editor')
  await contents.debugger.sendCommand('Input.insertText', { text: '你' })
  await expect('!document.querySelector("#cue-editor-popover").hidden && document.activeElement.value === "第一条字幕你"', 'commit Chinese text without closing the editor')
  await exec('document.querySelector("#editor-cancel").click()')
  assert.equal(await exec('document.querySelector(".cue.selected").textContent'), '第一条字幕')
  await click('undo')
  await expect('document.querySelectorAll(".cue").length === 1', 'cancelling text adds no undo entry')
  await click('delete-cue')
  await expect('document.querySelectorAll(".cue").length === 0', 'delete cue')
  await click('undo')
  await expect('document.querySelector(".cue")?.textContent === "第一条字幕"', 'restore deleted cue')
  await click('undo')
  await expect('document.querySelector(".cue")?.textContent === "空字幕"', 'undo text while retaining the timed block')
  await click('undo')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'undo first cue and retain the two starter tracks')
  await click('add-cue')
  saves.unshift('blank-block.subx')
  await click('save-project')
  await expect('document.querySelector("#status").textContent === "已保存工程"', 'save an empty timed cue')
  const blank = JSON.parse(await readFile(join(directory, 'blank-block.subx'), 'utf8')).tracks[0].cues[0]
  assert.deepEqual([blank.start, blank.end, blank.text], [0, 2000, ''])
  await click('new-project')
  await expect('document.querySelectorAll(".cue").length === 0', 'clear the saved test project')
  picks.unshift('blank-block.subx')
  await click('open-project')
  await expect('document.querySelector(".cue")?.textContent === "空字幕"', 'reopen the empty timed cue')
  await chooseExport('srt')
  await expect('document.querySelector("#status").textContent.includes("没有可导出的字幕正文")', 'explain an all-empty SRT export')
  await click('new-project')
  await expect('document.querySelectorAll(".cue").length === 0', 'start an independent media project')
  await click('open-media')
  await expect('document.querySelector("video").readyState >= 2', 'decode local MP4')
  await expect('document.querySelector("#ruler").dataset.frameIndex !== "loading"', 'complete video frame analysis')
  const indexed = await exec('document.querySelector("#ruler").dataset.frameIndex === "ready"')
  const tailPoint = await exec(`(() => {
    const zoom = document.querySelector('#zoom')
    zoom.value = zoom.max
    zoom.dispatchEvent(new Event('input'))
    const track = document.querySelector('#track-data')
    const end = parseFloat(track.style.getPropertyValue('--timeline-end'))
    const duration = document.querySelector('video').duration
    const scale = +zoom.value
    if (Math.abs(end - duration * scale) > 1 || Math.abs(track.clientWidth - end - 2 * scale) > 1) {
      throw Error('Expected two seconds of scrollable space beyond the video')
    }
    const scroll = document.querySelector('#timeline-scroll')
    scroll.scrollLeft = scroll.scrollWidth
    const ruler = document.querySelector('#ruler').getBoundingClientRect()
    return { x: ruler.left + end + scale, y: ruler.top + 8 }
  })()`)
  await mouse('mousePressed', tailPoint.x, tailPoint.y)
  await mouse('mouseReleased', tailPoint.x, tailPoint.y)
  const lastTime = indexed ? '00:00:04.833' : '00:00:05.000'
  await expect(`document.querySelector('#timecode').value === "${lastTime}" && !document.querySelector('video').seeking`,
    'clamp clicks in the two-second tail to the last video position')
  await exec(`document.querySelector('#ruler').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
  await expect(`document.querySelector('#timecode').value === "${lastTime}"`, 'keep the playhead at the last frame when nudged right')
  await exec(`(() => {
    const track = document.querySelector('#timeline-scroll')
    track.scrollLeft = track.scrollWidth
  })()`)
  await expect(`(() => {
    const finalTick = document.querySelector('.end-tick')
    if (!finalTick?.firstElementChild) return false
    const tick = finalTick.getBoundingClientRect()
    const label = finalTick.firstElementChild.getBoundingClientRect()
    return label.left > tick.left && label.bottom < tick.top
  })()`, 'put the last timestamp above and to the right of its tick')
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 0')
  if (indexed) {
    await expect('document.querySelectorAll(".frame-tick").length > 5', 'draw individual frame ticks at maximum zoom')
    const betweenFrames = await exec(`(() => {
      const ruler = document.querySelector('#ruler').getBoundingClientRect()
      return { x: ruler.left + Number(document.querySelector('#zoom').value) * .12, y: ruler.top + 10 }
    })()`)
    await mouse('mousePressed', betweenFrames.x, betweenFrames.y)
    await mouse('mouseReleased', betweenFrames.x, betweenFrames.y)
    await expect('document.querySelector("#timecode").value === "00:00:00.167"', 'snap a click between frames to the nearest video frame')
  }
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 0')
  await expect('document.querySelector("#zoom-thumb").style.transform === "translateX(0px)"', 'start the zoom grip at the left scroll boundary')
  const fullGrip = await exec(`(() => {
    const grip = document.querySelector('#zoom-thumb .zoom-grip[data-edge=right]').getBoundingClientRect()
    const bar = document.querySelector('#timeline-zoom').getBoundingClientRect()
    const x = grip.left + grip.width / 2
    const y = grip.top + grip.height / 2
    return { x, y, end: bar.right, hit: document.elementFromPoint(x, y)?.outerHTML.slice(0, 120) }
  })()`)
  await mouse('mousePressed', fullGrip.x, fullGrip.y)
  const captured = await exec('document.querySelector("#zoom-thumb").classList.contains("dragging")')
  await mouse('mouseMoved', fullGrip.end, fullGrip.y)
  await mouse('mouseReleased', fullGrip.end, fullGrip.y)
  assert(captured, 'Capture the right grip before stretching: ' + JSON.stringify(fullGrip))
  const zoomed = await exec(`(() => ({
    zoom: document.querySelector('#zoom').value, min: document.querySelector('#zoom').min,
    thumb: document.querySelector('#zoom-thumb').offsetWidth, bar: document.querySelector('#timeline-zoom').clientWidth,
  }))()`)
  assert.equal(zoomed.thumb, zoomed.bar, 'Stretch to the full bar: ' + JSON.stringify({ fullGrip, zoomed }))
  await expect(`(() => {
    const available = document.querySelector('#timeline-scroll').clientWidth - document.querySelector('#track-headings').offsetWidth
    const end = parseFloat(document.querySelector('#track-data').style.getPropertyValue('--timeline-end'))
    return Math.abs(available - end) < 1 && document.querySelector('#timeline-zoom').clientWidth === document.querySelector('#zoom-thumb').offsetWidth
  })()`, 'fit the complete video with a fully stretched zoom thumb')
  await exec('document.querySelector("video").currentTime = 0')
  if (process.env.SUBX_FFMPEG_PATH) {
    await expect('document.querySelector("#waveform").dataset.hasAudio === "true"', 'decode the source audio for timeline waveform')
  }
  await click('settings-tab')
  await click('project-watermark')
  const watermarkPixels = `(() => {
    const layer = document.querySelector('[data-layer="watermark"]')
    return layer?.dataset.ready === 'true' && layer.width > 0 &&
      layer.getContext('2d').getImageData(layer.width / 2, 0, layer.width / 2, layer.height / 3)
        .data.some((value, index) => index % 4 === 3 && value > 50)
  })()`
  await expect(watermarkPixels, 'render the project watermark with libass')
  await click('undo')
  await expect(`!document.querySelector('[data-layer="watermark"]')`, 'remove the watermark when undoing the project setting')
  await click('play')
  await expect('document.querySelector("video").currentTime > 0.15', 'play local MP4')
  await click('play')
  await exec('document.querySelector("video").currentTime = 2')
  await expect('document.querySelector("video").currentTime === 2 && !document.querySelector("video").seeking', 'seek local MP4')
  await writeFile(join(directory, 'unplayable.mp4'), 'this file contains no video')
  const originalMediaUrl = await exec('document.querySelector("video").src')
  await click('open-media')
  await expect('!document.querySelector("#open-media").disabled && document.querySelector("#status").textContent.includes("无法播放")', 'report an unreadable replacement video')
  assert.deepEqual(await exec(`(() => {
    const video = document.querySelector('video')
    return [video.src, video.currentTime, document.querySelector('#media-name').textContent]
  })()`), [originalMediaUrl, 2, 'video.mp4'])
  const originalRange = await net.fetch(originalMediaUrl, { headers: { range: 'bytes=0-31' } })
  assert.equal(originalRange.status, 206, 'The original media URL still serves new range requests')
  assert.deepEqual(Buffer.from(await originalRange.arrayBuffer()), (await readFile(join(directory, 'video.mp4'))).subarray(0, 32))
  await exec('document.querySelector("video").currentTime = 4.5')
  await expect('document.querySelector("video").currentTime === 4.5 && !document.querySelector("video").seeking && document.querySelector("video").readyState >= 2', 'seek and decode the original video after the failed replacement')
  await exec('document.querySelector("video").currentTime = 2')
  await expect('document.querySelector("video").currentTime === 2 && !document.querySelector("video").seeking', 'return the playhead to the original test position')
  await addCue('帧预览检查')
  await expect(`(() => {
    const layer = document.querySelector('[data-layer="plain-subtitles"]')
    return layer?.dataset.ready === 'true' && layer.width > 0 &&
      layer.getContext('2d').getImageData(0, layer.height / 2, layer.width, layer.height / 2)
        .data.some((value, index) => index % 4 === 3 && value > 100)
  })()`, 'render generated ASS subtitle pixels with libass')
  // Keep exercising the existing SRT basic-renderer timing assertions below.
  await exec(`(() => {
    const overlay = document.querySelector('#ass-overlays')
    const useBasicRenderer = () => {
      const layer = overlay.querySelector('[data-layer="plain-subtitles"][data-ready=true]')
      if (!layer) return
      layer.dataset.ready = 'false'
      layer.hidden = true
      document.querySelector('#video').dispatchEvent(new Event('timeupdate'))
    }
    new MutationObserver(useBasicRenderer).observe(overlay, { attributes: true, childList: true, subtree: true, attributeFilter: ['data-ready'] })
    useBasicRenderer()
  })()`)
  await exec(`(() => {
    document.querySelector('#cue-start').value = '00:00:03.800'
    document.querySelector('#cue-end').value = '00:00:03.860'
    document.querySelector('#cue-form').requestSubmit()
  })()`)
  if (indexed) assert.deepEqual(await exec(`[
    document.querySelector('#cue-start').value,
    document.querySelector('#cue-end').value,
  ]`), ['00:00:03.833', '00:00:04.000'], 'Align edited timestamps to frame starts and retain a full frame')
  // Deliver an actual decoded frame after seeked, with a PTS inside this cue.
  const holdFrame = () => exec(`(() => {
    const video = document.querySelector('video')
    const request = video.requestVideoFrameCallback
    video.requestVideoFrameCallback = function (callback) {
      return request.call(video, (now, frame) => {
        if (frame.mediaTime < 3.8 || frame.mediaTime >= 3.86) {
          callback(now, frame)
          return
        }
        video.requestVideoFrameCallback = request
        video.releaseHeldFrame = () => {
          delete video.releaseHeldFrame
          callback(now, frame)
          return frame.mediaTime
        }
      })
    }
    video.currentTime = 3.9
  })()`)
  await holdFrame()
  await expect(`!document.querySelector('video').seeking && typeof document.querySelector('video').releaseHeldFrame === 'function' && document.querySelector('#timecode').value === '00:00:03.900'`, 'await the seek clock and hold the decoded frame')
  assert.equal(await exec('Boolean(document.querySelector(".caption"))'), indexed, 'Use the target time while the frame callback is held')
  const frameTime = await exec('document.querySelector("video").releaseHeldFrame()')
  assert(frameTime >= 3.8 && frameTime < 3.86, 'Use a frame timestamp inside the short cue')
  assert.equal(await exec('document.querySelector("#timecode").value'), '00:00:03.900', 'A late frame must not replace the precise playhead time')
  assert.equal(await exec('document.querySelector(".caption")?.textContent'), '帧预览检查', 'Preview the subtitle at the displayed frame timestamp')
  await exec('document.querySelector("video").currentTime = 2')
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.000"', 'reset before testing a superseded seek')
  await holdFrame()
  await expect('typeof document.querySelector("video").releaseHeldFrame === "function"', 'hold a frame from the earlier seek')
  await exec('document.querySelector("video").currentTime = 2')
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.000"', 'settle the newer seek before releasing the old frame')
  await exec('document.querySelector("video").releaseHeldFrame()')
  assert.equal(await exec('Boolean(document.querySelector(".caption"))'), false, 'Ignore a frame captured before the most recent seek')
  await click('undo')
  await click('undo')
  await click('undo')
  await exec(`(() => {
    const zoom = document.querySelector('#zoom')
    zoom.value = zoom.max
    zoom.dispatchEvent(new Event('input'))
    document.querySelector('#ruler').focus({ preventScroll: true })
  })()`)
  const barGeometry = await exec(`(() => {
    const bar = document.querySelector('#timeline-zoom').getBoundingClientRect()
    const heads = document.querySelector('#track-headings').getBoundingClientRect()
    const area = document.querySelector('#timeline-scroll').getBoundingClientRect()
    const thumb = document.querySelector('#zoom-thumb').getBoundingClientRect()
    return { left: bar.left, right: bar.right, width: bar.width, heads: heads.right, area: area.right, thumb: thumb.width }
  })()`)
  assert(barGeometry.left >= barGeometry.heads - 1 && barGeometry.left <= barGeometry.heads + 8, 'Start the timeline scrollbar after the track headers')
  assert(Math.abs(barGeometry.right - barGeometry.area) < 12, 'End the timeline scrollbar at the track area edge')
  assert(barGeometry.thumb > 0 && barGeometry.thumb < barGeometry.width, 'Shrink the scrollbar thumb when zoomed in')
  await exec(`(() => {
    const zoom = document.querySelector('#zoom')
    zoom.value = String(Math.min(240, Number(zoom.max)))
    zoom.dispatchEvent(new Event('input'))
    document.querySelector('#timeline-scroll').scrollLeft = 0
    document.querySelector('video').currentTime = 2
  })()`)
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.000"', 'position the playhead for the zoom anchoring checks')
  await delay(150)
  const playheadBefore = await exec(`(() => {
    const head = document.querySelector('#playhead').getBoundingClientRect()
    const area = document.querySelector('#timeline-scroll').getBoundingClientRect()
    return { x: head.left, y: area.top + 90, scale: +document.querySelector('#zoom').value }
  })()`)
  await wheel(playheadBefore.x + 80, playheadBefore.y, -120)
  await delay(200)
  const playheadAfter = await exec(`(() => {
    const head = document.querySelector('#playhead').getBoundingClientRect()
    return { x: head.left, scale: +document.querySelector('#zoom').value }
  })()`)
  assert(playheadAfter.scale > playheadBefore.scale && Math.abs(playheadAfter.x - playheadBefore.x) <= 2, 'Keep the visible playhead in place while zooming in: ' + JSON.stringify({ playheadBefore, playheadAfter }))
  await wheel(playheadBefore.x + 80, playheadBefore.y, 120)
  await delay(200)
  const playheadBack = await exec(`(() => {
    const head = document.querySelector('#playhead').getBoundingClientRect()
    return { x: head.left, scale: +document.querySelector('#zoom').value }
  })()`)
  assert(playheadBack.scale < playheadAfter.scale && Math.abs(playheadBack.x - playheadAfter.x) <= 2, 'Keep the visible playhead in place while zooming out: ' + JSON.stringify({ playheadAfter, playheadBack }))
  await exec(`(() => {
    const zoom = document.querySelector('#zoom')
    zoom.value = zoom.max
    zoom.dispatchEvent(new Event('input'))
    document.querySelector('#timeline-scroll').scrollLeft = 0
  })()`)
  await delay(200)
  await exec('document.querySelector("video").currentTime = 4')
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:04.000"', 'move the playhead outside the zoomed-in viewport')
  await delay(150)
  const offscreenZoom = await exec(`(() => {
    const scroll = document.querySelector('#timeline-scroll')
    const heads = document.querySelector('#track-headings').getBoundingClientRect()
    const area = document.querySelector('#timeline-scroll').getBoundingClientRect()
    const head = document.querySelector('#playhead').getBoundingClientRect()
    const scale = +document.querySelector('#zoom').value
    return { leftTime: scroll.scrollLeft * 1000 / scale, scale, hidden: head.left >= area.right, x: heads.right + 40, y: area.top + 90 }
  })()`)
  assert(offscreenZoom.hidden, 'Keep the playhead outside the zoomed-in viewport for the left-anchor check')
  await wheel(offscreenZoom.x, offscreenZoom.y, 120)
  await delay(200)
  const offscreenAfter = await exec(`(() => {
    const scroll = document.querySelector('#timeline-scroll')
    const scale = +document.querySelector('#zoom').value
    return { leftTime: scroll.scrollLeft * 1000 / scale, scale }
  })()`)
  assert(offscreenAfter.scale < offscreenZoom.scale && Math.abs(offscreenAfter.leftTime - offscreenZoom.leftTime) <= 3, 'Anchor zoom on the leftmost visible time when the playhead is off-screen: ' + JSON.stringify({ offscreenZoom, offscreenAfter }))
  await exec('document.querySelector("video").currentTime = 2')
  await delay(150)
  const nudgeRuler = async (key, modifiers) => {
    const params = { key, code: key, modifiers, windowsVirtualKeyCode: key === 'ArrowLeft' ? 37 : 39 }
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  await nudgeRuler('ArrowRight', 8)
  await nudgeRuler('ArrowRight', 8)
  await expect('document.querySelector("video").currentTime === 4 && !document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:04.000"', 'seek one second per Shift+Arrow key')
  const playheadInView = `(() => {
    const head = document.querySelector('#playhead').getBoundingClientRect()
    const left = document.querySelector('#track-headings').getBoundingClientRect().right
    const right = document.querySelector('#timeline-scroll').getBoundingClientRect().right
    return head.left >= left && head.right <= right
  })()`
  assert(await exec(playheadInView), 'Reveal the keyboard playhead after moving past the right edge')
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 10000')
  await nudgeRuler('ArrowLeft', 0)
  await expect(`!document.querySelector("video").seeking && document.querySelector("#timecode").value === "${indexed ? '00:00:03.833' : '00:00:03.900'}"`, 'seek to the preceding video frame with ArrowLeft')
  assert(await exec(playheadInView), 'Reveal the keyboard playhead when it is behind the sticky track header')
  await exec(`(() => { const v = document.querySelector('video'); v.currentTime = 4; document.querySelector('#timeline-scroll').scrollLeft = 0; v.play() })()`)
  await expect(playheadInView, 'follow an offscreen playhead during playback')
  await exec('document.querySelector("video").pause()')
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 0')
  const edgeDrag = await exec(`(() => { const r = document.querySelector('#timeline-scroll').getBoundingClientRect(); const ruler = document.querySelector('#ruler').getBoundingClientRect(); return { left: document.querySelector('#track-headings').getBoundingClientRect().right, right: r.right, y: ruler.top + 7 } })()`)
  await mouse('mousePressed', edgeDrag.right - 80, edgeDrag.y)
  await mouse('mouseMoved', edgeDrag.right + 30, edgeDrag.y)
  await delay(350)
  const rightScroll = await exec('document.querySelector("#timeline-scroll").scrollLeft')
  assert(rightScroll > 0 && await exec(playheadInView), 'Scroll right continuously while dragging the playhead outside the viewport')
  await mouse('mouseMoved', edgeDrag.left - 30, edgeDrag.y)
  await delay(350)
  assert(await exec('document.querySelector("#timeline-scroll").scrollLeft') < rightScroll && await exec(playheadInView), 'Scroll left continuously while dragging the playhead outside the viewport')
  await mouse('mouseReleased', edgeDrag.left - 30, edgeDrag.y)
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 200')
  await expect('document.querySelector("#zoom-thumb").getBoundingClientRect().x > 210', 'settle the scrollbar thumb after scrolling')
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 0')
  await expect('document.querySelector("#zoom-thumb").style.transform === "translateX(0px)"', 'position the thumb for a partial zoom adjustment')
  const grip = await exec(`(() => {
    const box = document.querySelector('#zoom-thumb .zoom-grip[data-edge=right]').getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })()`)
  await mouse('mousePressed', grip.x, grip.y)
  await mouse('mouseMoved', grip.x + 80, grip.y)
  await mouse('mouseReleased', grip.x + 80, grip.y)
  assert(await exec('Number(document.querySelector("#zoom").value) < 320'), 'Zoom out by dragging the scrollbar grip')
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 0')
  await expect('document.querySelector("#zoom-thumb").getBoundingClientRect().x <= 210', 'settle the scrollbar thumb after resetting the scroll')
  const thumb = await exec(`(() => {
    const box = document.querySelector('#zoom-thumb').getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })()`)
  await mouse('mousePressed', thumb.x, thumb.y)
  await mouse('mouseMoved', thumb.x + 60, thumb.y)
  await mouse('mouseReleased', thumb.x + 60, thumb.y)
  assert(await exec('document.querySelector("#timeline-scroll").scrollLeft > 0'), 'Scroll the timeline by dragging the scrollbar thumb')
  await exec(`(() => {
    document.querySelector('#timeline-scroll').scrollLeft = 0
    const zoom = document.querySelector('#zoom')
    zoom.value = zoom.defaultValue
    zoom.dispatchEvent(new Event('input'))
    document.querySelector('video').currentTime = 2
  })()`)
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.000"', 'restore the timeline after keyboard seeking')
  await exec('for (const value of ["2", "4", "1"]) { const q = document.querySelector("#quality"); q.value = value; q.dispatchEvent(new Event("change")); const c = document.querySelector("canvas"); if (value === "1" ? !c.hidden : c.width !== 3840 / +value || c.height !== 2160 / +value) throw Error("quality width"); }')
  console.log('PASS switch 4K preview targets 3840x2160, 1920x1080, 960x540')
  await writeFile(join(directory, 'broken-encoding.srt'), Buffer.from([0xff, 0xfe, 0x31]))
  await click('import-subtitles')
  await expect('document.querySelector("#status").textContent.includes("UTF-8") && document.querySelectorAll(".track-lane").length === 2', 'reject a truncated Unicode subtitle without adding a track')
  const mixed = '1\r\n00:00:01,000 --> 00:00:02,000\r\n有效字幕\r\n \r\n\t\r\n2\r\n00:00:61,000 --> 00:00:03,000\r\n无效时间码\r\n\r\n3\r\n00:00:05,000 --> 00:00:04,000\r\n倒序时间\r\n'
  await writeFile(join(directory, 'mixed.srt'), mixed)
  await click('import-subtitles')
  await expect(`document.querySelector('#srt-import-dialog').open && document.querySelector('#srt-import-summary').textContent === 'mixed.srt · 1 条有效字幕，2 条有问题' &&
    document.querySelector('#srt-import-issues li:first-child').textContent === '第 2 条字幕（第 7 行）时间码格式或数值无效' &&
    document.querySelector('#srt-import-issues li:last-child').textContent === '第 3 条字幕（第 11 行）结束时间须晚于开始时间'`, 'show both invalid SRT source lines before adding a track')
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await expect('!document.querySelector("#import-subtitles").disabled && document.querySelectorAll(".track-lane").length === 2', 'cancel partial SRT import with Escape')
  await click('import-subtitles')
  await expect('document.querySelector("#srt-import-dialog").open', 'reopen the SRT diagnostics')
  await exec('document.querySelector("#srt-import-dialog button[value=confirm]").click()')
  await expect('document.querySelector("#status").textContent === "已导入 1 条字幕 · 跳过 2 条" && document.querySelector(".cue")?.textContent === "有效字幕"', 'import only valid SRT entries after confirmation')
  assert.equal(await readFile(join(directory, 'mixed.srt'), 'utf8'), mixed)
  await click('undo')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'undo partial SRT import in one step')
  await writeFile(join(directory, 'bad-timing.srt'), '1\n无效时间码\n')
  await click('import-subtitles')
  await expect('document.querySelector("#srt-import-dialog").open && document.querySelector("#srt-import-dialog button[value=confirm]").hidden', 'offer only close for an SRT with no valid entries')
  await exec('document.querySelector("#srt-import-dialog button[value=cancel]").click()')
  await expect('!document.querySelector("#import-subtitles").disabled && document.querySelectorAll(".track-lane").length === 2', 'leave the project unchanged after all-invalid SRT')
  const inputSrt = join(directory, 'input.srt')
  await writeFile(inputSrt, Buffer.from('\ufeff' + await readFile(inputSrt, 'utf8'), 'utf16le'))
  await click('import-subtitles')
  await expect('document.querySelector("#project-stats").textContent.endsWith("3 条字幕") && document.querySelector(".cue").textContent.includes("你好")', 'import a UTF-16LE bilingual SRT via preload')
  await click('compose-video')
  await expect("!document.querySelector('#composition-start').disabled && document.querySelector('#composition-cues').textContent.includes('3 条非空字幕')", 'prepare visible subtitles and source metadata for composition')
  if (process.env.SUBX_FFMPEG_PATH) {
    await exec("const fields = document.querySelector('#composition-form').elements; fields.height.value = '720'; fields.fps.value = '24'; fields.preset.value = 'fast'")
    await click('composition-start')
    await expect("!document.querySelector('#composition-dialog').open && document.querySelector('#status').textContent.includes('合成完成')", 'encode a subtitled video through the composition dialog')
    assert((await stat(join(directory, 'burned.mp4'))).size > 1000)
  } else await click('composition-cancel')
  await exec(`(() => {
    document.querySelector('.track-lane .cue').click()
    const text = document.querySelector('#cue-text')
    text.value += '草稿'
    text.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await click('split-track')
  await expect('!document.querySelector("#split-dialog").open && !document.querySelector("#cue-form .discard-draft").hidden && document.querySelector("#status").textContent.includes("先应用或取消")', 'protect pending text when splitting its track')
  await exec('document.querySelector("#cue-form .discard-draft").click()')
  await click('split-track')
  await expect(`document.querySelector('#split-dialog').open && document.querySelector('#split-preview').textContent.includes('上轨 你好') &&
    document.querySelector('#split-preview').textContent.includes('00:00:16.000') && document.querySelector('#split-preview').textContent.includes('3 行正文')`, 'show the original language order and the reason for an exception')
  await exec(`(() => {
    const order = document.querySelector('#split-order')
    order.value = 'reverse'
    order.dispatchEvent(new Event('change'))
  })()`)
  await expect('document.querySelector("#split-preview").textContent.includes("上轨 Hello")', 'preview reversed language order before splitting')
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await expect('!document.querySelector("#open-project").disabled && !document.querySelector("#split-dialog").open && document.querySelectorAll(".track-lane").length === 1 && document.querySelector(".cue").textContent.startsWith("你好")', 'cancel split without changing the active track')
  await exec('document.querySelector("video").currentTime = 2.1')
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.100" && document.querySelectorAll(".caption").length === 1', 'hold a frame inside the original bilingual cue')
  await click('split-track')
  await exec(`(() => {
    const order = document.querySelector('#split-order')
    order.value = 'original'
    order.dispatchEvent(new Event('change'))
  })()`)
  await exec('document.querySelector("#split-dialog button[value=confirm]").click()')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'split bilingual into two tracks')
  assert.deepEqual(await exec('Array.from(document.querySelectorAll(".caption")).map(node => node.textContent)'), ['你好', 'Hello'], 'update the paused preview after splitting')
  await expect('!document.querySelector("#next-review").hidden && document.querySelector("#next-review").textContent === "待校对 2"', 'list two exceptions after splitting')
  await click('split-track')
  await expect(`document.querySelector('#split-dialog').open && document.querySelector('#split-dialog button[value=confirm]').disabled &&
    document.querySelector('#split-preview').textContent.includes('已有链接')`, 'prevent a split with no eligible pairs')
  await exec('document.querySelector("#split-dialog button[value=cancel]").click()')
  await expect('!document.querySelector("#open-project").disabled && !document.querySelector("#split-dialog").open && document.querySelectorAll(".track-lane").length === 2', 'keep the current tracks when no pair is eligible')
  await click('link-tool')
  await click('next-review')
  await expect(`document.querySelector('#cue-text').value === '单行' && document.querySelector('#timecode').value === '00:00:02.750' && document.querySelector('#select-tool').getAttribute('aria-pressed') === 'true'`, 'locate the retained single line without starting a link')
  await exec('document.querySelector("video").currentTime = 2.9')
  await expect(`!document.querySelector('video').seeking && Array.from(document.querySelectorAll('.caption')).some(node => node.textContent === '单行')`, 'hold a frame inside the selected cue')
  await exec(`(() => {
    const input = document.querySelector('#cue-text')
    input.value += '（草稿）'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await expect(`Array.from(document.querySelectorAll('.caption')).some(node => node.textContent === '单行（草稿）') &&
    Array.from(document.querySelectorAll('.cue')).some(node => node.textContent === '单行')`, 'preview the SRT text draft before applying')
  await click('styles-tab')
  await expect(`Array.from(document.querySelectorAll('.caption')).some(node => node.textContent === '单行')`, 'show saved text outside the cue editor')
  await click('cue-tab')
  await expect(`Array.from(document.querySelectorAll('.caption')).some(node => node.textContent === '单行（草稿）')`, 'resume the preview when returning to the cue editor')
  await click('complete-review')
  await expect('document.querySelector("#status").textContent.includes("先应用或取消") && document.querySelector("#next-review").textContent === "待校对 2"', 'retain the review mark while the cue has a draft')
  await exec('document.querySelector("#cue-form .discard-draft").click()')
  await expect(`Array.from(document.querySelectorAll('.caption')).some(node => node.textContent === '单行')`, 'restore the SRT preview when discarding the draft')
  await click('complete-review')
  await expect('document.querySelector("#next-review").textContent === "待校对 1" && document.querySelector("#complete-review").hidden', 'mark the selected exception as reviewed')
  await click('undo')
  await expect('document.querySelector("#next-review").textContent === "待校对 2"', 'undo the review completion')
  await click('redo')
  await expect('document.querySelector("#next-review").textContent === "待校对 1"', 'redo the review completion')
  await click('next-review')
  await expect(`document.querySelector('#cue-text').value === '第一行\\n第二行\\n第三行' && document.querySelector('.cue.selected')?.classList.contains('review') && document.querySelector('#timeline-scroll').scrollLeft > 0`, 'reveal the offscreen three-line exception beyond the video')
  await click('undo')
  await exec(`(() => {
    document.querySelector('#timeline-scroll').scrollLeft = 0
    document.querySelector('video').currentTime = 2
  })()`)
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.000" && document.querySelector("#timeline-scroll").scrollLeft === 0 && document.querySelectorAll(".caption").length === 2', 'restore the position after navigating review items')
  const marqueeArea = await exec(`(() => { const lanes = [...document.querySelectorAll('.track-lane')]; const a = lanes[0].getBoundingClientRect(); const b = lanes.at(-1).getBoundingClientRect(); const left = document.querySelector('#track-headings').getBoundingClientRect().right; return { x: left + 3, y: a.top + 3, right: Math.min(document.querySelector('#timeline-scroll').getBoundingClientRect().right - 5, left + 500), bottom: b.bottom - 3 } })()`)
  await mouse('mousePressed', marqueeArea.x, marqueeArea.y)
  await mouse('mouseMoved', marqueeArea.right, marqueeArea.bottom)
  assert(await exec('!document.querySelector("#selection-box").hidden && getComputedStyle(document.querySelector("#selection-box")).borderTopStyle === "solid"'), 'Show a solid selection rectangle while dragging')
  assert(await exec('document.querySelectorAll(".cue.selected").length >= 2'), 'Select subtitle blocks intersected by the rectangle across tracks')
  await mouse('mouseReleased', marqueeArea.right, marqueeArea.bottom)
  assert(await exec('document.querySelector("#selection-box").hidden && document.querySelectorAll(".cue.selected").length >= 2'), 'Keep the selected blocks after releasing the rectangle')
  await exec(`(() => { const headings = document.querySelectorAll('.track-heading'); headings[0].click(); headings[1].click() })()`)
  const rulerPoint = await exec('(() => { const r = document.querySelector("#ruler").getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + 7), scale: +document.querySelector("#zoom").value }; })()')
  await mouse('mousePressed', rulerPoint.x + rulerPoint.scale, rulerPoint.y)
  await mouse('mouseMoved', rulerPoint.x + 2 * rulerPoint.scale, rulerPoint.y)
  await mouse('mouseReleased', rulerPoint.x + 2 * rulerPoint.scale, rulerPoint.y)
  await expect('Math.abs(document.querySelector("video").currentTime - 2) < 0.03', 'drag ruler with the default cursor')
  const point = await exec('(() => { const cue = Array.from(document.querySelectorAll(".cue")).find(item => item.title.startsWith("你好")); const r = cue.getBoundingClientRect(); return {x: r.left + 20, y: r.top + 10}; })()')
  await mouse('mousePressed', point.x, point.y)
  await mouse('mouseMoved', point.x + 282 * rulerPoint.scale / 94, point.y)
  await expect('document.querySelectorAll(".caption").length === 0 && document.querySelector("#drag-overlap").hidden', 'leave the overlap warning hidden outside another cue')
  await mouse('mouseMoved', point.x + 190 * rulerPoint.scale / 94, point.y)
  await expect('document.querySelectorAll(".caption").length === 0', 'drag pair out of playhead before release')
  await expect(`!document.querySelector('#drag-overlap')?.hidden &&
    Array.from(document.querySelectorAll('.track-lane .drag-overlap')).map(cue => cue.textContent.replace(/^⛓ /, '')).sort().join(',') === '你好,单行'`, 'mark both overlapping cues on the affected track during linked drag')
  await mouse('mouseReleased', point.x + 190 * rulerPoint.scale / 94, point.y)
  await expect('document.querySelector("#status").textContent.includes("已移动链接字幕 · 同轨字幕重叠") && document.querySelector("#drag-overlap").hidden', 'commit a linked drag with an overlap warning')
  await click('undo')
  await expect('document.querySelectorAll(".caption").length === 2', 'undo both cues')
  const bounds = await exec(`(() => {
    const cue = document.querySelector(".track-lane .cue").getBoundingClientRect()
    return { left: Math.ceil(cue.left) + 3, right: Math.floor(cue.right) - 3, y: cue.top + 8 }
  })()`)
  await mouse('mouseMoved', bounds.right, bounds.y)
  assert.equal(await exec('getComputedStyle(document.querySelector(".track-lane .cue")).cursor'), 'ew-resize')
  await mouse('mousePressed', bounds.right, bounds.y)
  await mouse('mouseMoved', bounds.right - 118 * rulerPoint.scale / 94, bounds.y)
  await expect('document.querySelectorAll(".caption").length === 1 && document.querySelector(".caption").textContent === "Hello"', 'trim one linked cue in the live overlay')
  await mouse('mouseReleased', bounds.right - 118 * rulerPoint.scale / 94, bounds.y)
  await expect('document.querySelector("#status").textContent === "已调整字幕边界"', 'commit one edge trim')
  assert.match(await exec('document.querySelector("#cue-end").value'), indexed ? /00:00:01\.667/ : /00:00:01\.74[0-9]/)
  await click('undo')
  await expect('document.querySelectorAll(".caption").length === 2', 'undo the edge trim without breaking the link')
  await mouse('mousePressed', bounds.left, bounds.y)
  await mouse('mouseMoved', bounds.left + 118 * rulerPoint.scale / 94, bounds.y)
  await expect('document.querySelectorAll(".caption").length === 1 && !document.querySelector("#drag-overlap").hidden', 'preview the start edge trim and its overlap')
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await mouse('mouseReleased', bounds.left + 118 * rulerPoint.scale / 94, bounds.y)
  await expect('document.querySelectorAll(".caption").length === 2 && document.querySelector("#drag-overlap").hidden && !document.querySelector(".cue.drag-overlap")', 'cancel an edge trim with Escape and clear its overlap warning')
  await mouse('mousePressed', bounds.right, bounds.y)
  await mouse('mouseMoved', bounds.right - 118 * rulerPoint.scale / 94, bounds.y)
  await mouse('mouseReleased', bounds.right - 118 * rulerPoint.scale / 94, bounds.y)
  await expect('document.querySelectorAll(".caption").length === 1', 'trim before testing undo during pointer capture')
  await mouse('mousePressed', bounds.left, bounds.y)
  await mouse('mouseMoved', bounds.left + 24 * rulerPoint.scale / 94, bounds.y)
  await exec(`document.body.dispatchEvent(new KeyboardEvent("keydown", {
    key: "z", ${process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'}: true,
    bubbles: true, cancelable: true,
  }))`)
  await mouse('mouseReleased', bounds.left + 24 * rulerPoint.scale / 94, bounds.y)
  await expect('document.querySelectorAll(".caption").length === 2 && !document.querySelector("#redo").disabled', 'undo during drag without committing a stale trim')
  await click('save-project')
  await expect('document.querySelector("#status").textContent === "已保存工程"', 'save versioned project')
  const saved = JSON.parse(await readFile(join(directory, 'saved.subx'), 'utf8'))
  assert.equal(saved.links.length, 1)
  assert.equal(saved.tracks[0].cues[0].start, 1000)
  assert.equal(saved.tracks[1].cues[0].start, 1000)
  const editTopCue = async text => {
    await exec('document.querySelector(".track-lane .cue").click()')
    await exec(`(() => {
      document.querySelector('#cue-text').value = ${JSON.stringify(text)}
      document.querySelector('#cue-form').requestSubmit()
    })()`)
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(directory, 'saved.subx'))).mode & 0o777, 0o600)
    await chmod(join(directory, 'saved.subx'), 0o640)
  }
  await exec(`(() => {
    document.querySelector('.track-lane .cue').click()
    const text = document.querySelector('#cue-text')
    text.value = '未应用'
    text.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await click('save-project')
  await expect('document.querySelector("#status").textContent.includes("请先应用字幕修改")', 'warn when a form has unapplied changes')
  assert.equal(await exec(`document.querySelector("#cue-text").dispatchEvent(new KeyboardEvent("keydown", {
    key: "s", keyCode: 229, ${process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'}: true,
    bubbles: true, cancelable: true,
  }))`), true, 'Leave IME boundary key events to the text editor')
  await exec(`(() => {
    const text = document.querySelector('#cue-text')
    text.focus()
    text.setSelectionRange(text.value.length, text.value.length)
  })()`)
  await contents.debugger.sendCommand('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
  await expect('document.querySelector("#cue-text").value === "未应用ni"', 'show an IME candidate after existing text')
  await contents.debugger.sendCommand('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await expect('document.querySelector("#cue-text").value === "未应用"', 'cancel composition without removing the existing draft')
  await exec(`(() => {
    const text = document.querySelector('#cue-text')
    text.select()
    text.addEventListener('compositionend', event => { text.dataset.committed = event.data }, { once: true })
  })()`)
  await contents.debugger.sendCommand('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  await expect('document.querySelector("#cue-text").value === "nihao" && !document.querySelector(".track-lane .cue").textContent.includes("nihao")', 'keep IME preedit in the subtitle field')
  await contents.debugger.sendCommand('Input.insertText', { text: '你好！' })
  await expect('document.querySelector("#cue-text").dataset.committed === "你好！" && document.querySelector("#cue-text").value === "你好！"', 'commit Chinese text through Chromium IME')
  await exec('document.querySelector("#cue-form").requestSubmit()')
  await exec(`document.querySelector("#cue-text").dispatchEvent(new KeyboardEvent("keydown", {
    key: "s", ${process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'}: true,
    bubbles: true, cancelable: true,
  }))`)
  await expect('document.querySelector("#status").textContent === "已保存工程"', 'save to the current file with the keyboard')
  const original = join(directory, 'saved.subx')
  if (process.platform !== 'win32') assert.equal((await stat(original)).mode & 0o777, 0o640)
  assert.equal(JSON.parse(await readFile(original, 'utf8')).tracks[0].cues[0].text, '你好！')
  const external = await readFile(original, 'utf8') + '\n'
  await writeFile(original, external, 'utf8')
  await editTopCue('你好，副本')
  await click('save-project')
  await expect('document.querySelector("#status").textContent.includes("磁盘上的工程已被修改")', 'protect an externally modified project')
  assert.equal(await readFile(original, 'utf8'), external)
  await click('save-project-as')
  await expect('!document.querySelector("#save-project-as").disabled && document.querySelector("#status").textContent.includes("选择其他文件")', 'protect the original when Save As selects the same path')
  assert.equal(await readFile(original, 'utf8'), external)
  beforeSavePath = () => editTopCue('另存为期间的修改')
  await click('save-project-as')
  await expect('document.querySelector("#status").textContent === "已写入工程，仍有尚未保存的修改"', 'keep edits made after Save As starts unsaved')
  const copy = join(directory, 'copied.subx')
  assert.equal(JSON.parse(await readFile(copy, 'utf8')).tracks[0].cues[0].text, '你好，副本')
  assert.equal(await exec('document.querySelector("#cue-text").value'), '另存为期间的修改')
  await click('undo')
  assert.equal(await exec('document.title.includes("●")'), false, 'Undo to the snapshot written by Save As')
  await editTopCue('你好，更新副本')
  assert(await exec('document.title.includes("●")'), 'A new edit after undo creates a distinct history state')
  await click('save-project')
  await expect('document.querySelector("#status").textContent === "已保存工程"', 'save again to the new file')
  assert.equal(JSON.parse(await readFile(copy, 'utf8')).tracks[0].cues[0].text, '你好，更新副本')
  assert.equal(await readFile(original, 'utf8'), external)
  await editTopCue('临时编辑')
  assert(await exec('document.title.includes("●")'), 'An edit after saving marks the project dirty')
  await click('undo')
  assert.equal(await exec('document.querySelector("#cue-text").value'), '你好，更新副本')
  assert.equal(await exec('document.title.includes("●")'), false, 'Undo back to the saved history state clears the dirty mark')
  await click('redo')
  assert(await exec('document.title.includes("●")'), 'Redo beyond the saved state marks the project dirty again')
  await click('undo')
  await click('undo')
  assert.equal(await exec('document.querySelector("#cue-text").value'), '你好，副本')
  assert(await exec('document.title.includes("●")'), 'Undo past the saved state also marks the project dirty')
  await click('redo')
  assert.equal(await exec('document.title.includes("●")'), false, 'Redo to the saved state clears the dirty mark')
  await chooseExport('srt')
  await expect('document.querySelector("#status").textContent === "已导出 SRT"', 'export selected track')
  assert.match(await readFile(join(directory, 'track.srt'), 'utf8'), /你好/)
  await click('open-project')
  await expect('document.querySelector("#status").textContent === "已打开工程"', 'reopen saved project')
  await editTopCue('你好，重新打开')
  if (process.platform !== 'win32') {
    await chmod(original, 0o440)
    await click('save-project')
    await expect('document.querySelector("#status").textContent.includes("目标工程文件不可写")', 'preserve read-only project')
    assert.equal(await readFile(original, 'utf8'), external)
    await chmod(original, 0o640)
  }
  await click('save-project')
  await expect('document.querySelector("#status").textContent === "已保存工程"', 'save a reopened project in place')
  assert.equal(JSON.parse(await readFile(original, 'utf8')).tracks[0].cues[0].text, '你好，重新打开')
  await expect('document.querySelector("video").readyState >= 2', 'restored local media')

  const beforeRelink = await readFile(original, 'utf8')
  await click('new-project')
  await expect('!document.querySelector("video").hasAttribute("src") && !document.querySelector("#open-project").disabled', 'release the video before moving its file')
  const movedVideo = join(directory, 'moved-video.mp4')
  await rename(join(directory, 'video.mp4'), movedVideo)
  await click('open-project')
  await expect('document.querySelector("#status").textContent.includes("原视频") && document.querySelectorAll(".track-lane").length === 2', 'open the subtitle project after its video moved')
  assert.equal(await exec('document.querySelector("#media-name").textContent'), 'video.mp4', 'Show the original video name when the file is unavailable')
  assert.equal(await exec('document.querySelector("#open-media").textContent'), '重新定位视频')
  assert(await exec('!document.querySelector("#empty-video").hidden && document.querySelector("#empty-video-message").textContent === "原视频不可用"'))
  assert(await exec('document.querySelector("#play").disabled'))
  await click('open-media')
  await expect('!document.querySelector("#open-media").disabled && document.querySelector("#open-media").textContent === "重新定位视频"', 'cancel locating the video without clearing the original reference')
  assert.equal(await readFile(original, 'utf8'), beforeRelink)
  await click('open-media')
  await expect(`!document.querySelector('#open-media').disabled && document.querySelector('#open-media').textContent === '重新定位视频' &&
    document.querySelector('#media-name').textContent === 'video.mp4' && document.querySelector('#status').textContent.includes('无法播放') &&
    !document.title.includes('●')`, 'retain the original missing path after choosing a corrupt replacement')
  await click('open-media')
  await expect('document.querySelector("video").readyState >= 2 && document.querySelector("#media-name").textContent === "moved-video.mp4"', 'relink and decode the relocated video')
  await editTopCue('临时更改已定位工程')
  await click('undo')
  assert.equal(await exec('document.querySelector("#cue-text").value'), '你好，重新打开')
  assert(await exec('document.title.includes("●") && document.querySelector("#media-name").textContent === "moved-video.mp4"'), 'Undoing a cue preserves the unsaved relocated reference')
  await click('save-project')
  await expect('document.querySelector("#status").textContent === "已保存工程"', 'save the relocated media reference')
  const relinked = JSON.parse(await readFile(original, 'utf8'))
  assert.deepEqual(relinked, { ...JSON.parse(beforeRelink), media: movedVideo })
  await click('open-project')
  await expect('document.querySelector("#status").textContent === "已打开工程" && document.querySelector("video").readyState >= 2 && document.querySelector("#media-name").textContent === "moved-video.mp4"', 'reopen the project with the new video location')

  await exec('document.querySelector("video").currentTime = 2')
  await expect('document.querySelector("video").currentTime === 2 && !document.querySelector("video").seeking', 'seek restored local media')
  await click('import-subtitles')
  await expect('document.querySelector(".ass-layer:not(.generated-layer)")?.dataset.ready === "true"', 'start libass WASM worker')
  const assPixels = `(() => {
    const c = document.querySelector(".ass-layer:not(.generated-layer)")
    const data = c.getContext("2d").getImageData(c.width * .35, c.height * .05, c.width * .30, c.height * .25).data
    return data.some((value, i) => i % 4 === 3 && value > 180)
  })()`
  await expect(assPixels, 'render positioned ASS into top band')
  await exec(`(() => {
    document.querySelector('.track-lane:first-child .cue').click()
    const input = document.querySelector('#cue-text')
    input.value = '{\\\\an2\\\\1c&H00FF00&}草稿预览'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const draftAssPixels = `(() => {
    const c = document.querySelector('.ass-layer:not(.generated-layer)')
    const data = c.getContext('2d').getImageData(c.width * .35, c.height * .70, c.width * .30, c.height * .30).data
    return data.some((value, i) => i % 4 === 1 && value > 200 && data[i - 1] < 40 && data[i + 1] < 40 && data[i + 2] > 180)
  })()`
  await expect('(' + draftAssPixels + ') && !(' + assPixels + ')', 'preview the ASS body draft and its positioning override')
  await exec('document.querySelector("#cue-form .discard-draft").click()')
  await expect(assPixels, 'restore the original ASS rendering when discarding the body draft')
  const assEdge = await exec(`(() => {
    const bounds = document.querySelector('.track-lane:first-child .cue').getBoundingClientRect()
    return { x: Math.ceil(bounds.left) + 3, y: bounds.top + 8 }
  })()`)
  await mouse('mousePressed', assEdge.x, assEdge.y)
  await mouse('mouseMoved', assEdge.x + 118 * rulerPoint.scale / 94, assEdge.y)
  await expect('!(' + assPixels + ')', 'hide the ASS bitmap while trimming before release')
  await mouse('mouseReleased', assEdge.x + 118 * rulerPoint.scale / 94, assEdge.y)
  await click('undo')
  await expect(assPixels, 'restore the ASS bitmap after undo')
  await click('styles-tab')
  await expect('[...document.querySelectorAll(".style-list-item")].some(row => row.title === "Default")', 'import named ASS style')
  await exec('[...document.querySelectorAll(".style-list-item")].find(row => row.title === "Default").querySelector("[aria-label=编辑]").click()')
  await contents.debugger.sendCommand('Profiler.enable')
  await contents.debugger.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
  await click('settings-tab')
  await click('styles-tab')
  const { result: coverage } = await contents.debugger.sendCommand('Profiler.takePreciseCoverage')
  await contents.debugger.sendCommand('Profiler.stopPreciseCoverage')
  await contents.debugger.sendCommand('Profiler.disable')
  const assRender = coverage.find(script => script.url.endsWith('/core/ass.mjs'))
    ?.functions.find(fn => fn.functionName === 'renderAss')
  assert.equal(assRender?.ranges[0].count ?? 0, 0, 'Switching tabs without a draft should not rebuild ASS')
  const greenAssPixels = `(() => {
    const canvas = document.querySelector('.ass-layer:not(.generated-layer)')
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 1] > 150 && data[i + 1] - data[i] > 80 && data[i + 1] - data[i + 2] > 80 && data[i + 3] > 180) return true
    }
    return false
  })()`
  const changeStyle = `(() => {
    const size = document.querySelector('#style-editor input[type=number]')
    size.value = '72'
    const hex = document.querySelector('.style-hex')
    const picker = document.querySelector('.style-swatch')
    picker.value = '#445566'
    picker.dispatchEvent(new Event('input', { bubbles: true }))
    if (hex.value !== '#445566') throw Error('Native color does not update hex')
    hex.value = '#11CC33'
    hex.dispatchEvent(new Event('input', { bubbles: true }))
    if (picker.value !== '#11cc33') throw Error('Hex does not update native color')
  })()`
  await exec(changeStyle)
  await expect(greenAssPixels, 'render the draft ASS color before saving')
  const blueAssPixels = `(() => {
    const canvas = Array.from(document.querySelectorAll('.ass-layer:not(.generated-layer)')).at(-1)
    const data = canvas.getContext('2d').getImageData(0, canvas.height * .7, canvas.width, canvas.height * .3).data
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 2] > 180 && data[i + 2] - data[i + 1] > 80 && data[i + 3] > 180) return true
    }
    return false
  })()`
  await expect(blueAssPixels, 'keep the overlapping Notes style visible while editing Default')
  await chooseExport('srt')
  await expect('document.querySelector("#status").textContent.startsWith("已导出 SRT")', 'export the selected ASS track as SRT')
  assert.equal(await readFile(join(directory, 'converted.srt'), 'utf8'), [
    '1', '00:00:01,000 --> 00:00:03,500', '你好, SubX', '',
    '2', '00:00:01,500 --> 00:00:04,000', '备注, Notes', '',
  ].join('\n'))
  const remainingExports = saves.length
  await click('export-subtitles')
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await expect('!document.querySelector("#export-format").open', 'cancel the export format picker with Escape')
  await exec('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  assert.equal(saves.length, remainingExports, 'Canceling must not reopen the previous SRT save dialog')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export ASS with saved styles while previewing a draft')
  assert.equal(await readFile(join(directory, 'roundtrip.ass'), 'utf8'), await readFile(join(directory, 'styles.ass'), 'utf8'))
  await click('settings-tab')
  await expect('(' + assPixels + ') && !(' + greenAssPixels + ')', 'use the saved style outside the style manager')
  await click('styles-tab')
  await expect(greenAssPixels, 'resume the draft preview when returning to the style manager')
  await exec("document.querySelector('#style-editor .discard-draft').click()")
  await expect('(' + assPixels + ') && !(' + greenAssPixels + ')', 'restore the saved ASS rendering after discarding the draft')
  const translucentWhite = `(() => {
    const canvas = document.querySelector('.ass-layer:not(.generated-layer)')
    const data = canvas.getContext('2d').getImageData(canvas.width * .35, canvas.height * .05, canvas.width * .30, canvas.height * .25).data
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240 && data[i + 3] >= 120 && data[i + 3] <= 130) return true
    }
    return false
  })()`
  await exec(`(() => {
    const [fill, outline] = document.querySelectorAll('.style-opacity')
    if (fill.value !== '100' || outline.value !== '74.9') throw Error('Import the original opacity values')
    fill.value = '50'
    outline.value = '0'
    outline.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await expect('(' + translucentWhite + ') && !(' + assPixels + ')', 'preview independently adjusted fill and outline opacity')
  await exec("document.querySelector('#style-editor form').requestSubmit()")
  await expect('document.querySelector("#status").textContent === "已保存样式"', 'save the ASS opacity changes')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export the saved opacity bytes')
  assert.match(await readFile(join(directory, 'opacity.ass'), 'utf8'), /Style: Default,Noto Sans SC,56,&H80FFFFFF,&H000000FF,&HFF111111,/)
  await exec(changeStyle)
  await exec("document.querySelector('#style-editor form').requestSubmit()")
  await expect('document.querySelector("#status").textContent === "已保存样式"', 'change RGB on a translucent style')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export RGB while preserving the opacity bytes')
  assert.match(await readFile(join(directory, 'opacity-rgb.ass'), 'utf8'), /Style: Default,Noto Sans SC,72,&H8033CC11,&H000000FF,&HFF111111,/)
  await click('undo')
  await click('undo')
  await expect(assPixels, 'restore the original opacity after undo')
  await exec(changeStyle)
  await exec("document.querySelector('#style-editor form').requestSubmit()")
  await expect('document.querySelector("#status").textContent === "已保存样式"', 'edit ASS shared style size')
  await expect(greenAssPixels, 'keep the ASS color after saving')
  await click('undo')
  await expect('(' + assPixels + ') && !(' + greenAssPixels + ')', 'restore ASS pixels after undoing the saved style')
  await click('redo')
  await expect(greenAssPixels, 'restore ASS pixels after redoing the saved style')
  await exec('document.querySelector("#style-editor [aria-label=返回样式列表]").click()')
  await exec('[...document.querySelectorAll(".style-list-item")].find(row => row.title === "Default").querySelector("[aria-label=复制]").click()')
  await expect('document.querySelector(".style-list-item:last-child")?.title === "Default 副本"', 'duplicate ASS style at the end of the list')
  await exec(`(() => {
    const cue = document.querySelector(".track-lane:first-child .cue")
    cue.click()
    const style = document.querySelector("#cue-style")
    style.value = Array.from(style.options).find(option => option.text === "Default 副本").value
    document.querySelector("#cue-end").value = "00:00:03.650"
    document.querySelector("#cue-form").requestSubmit()
  })()`)
  await expect('document.querySelector("#status").textContent === "已更新字幕"', 'apply style and edit cue time')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export changed ASS style')
  const styled = await readFile(join(directory, 'styled.ass'), 'utf8')
  assert.match(styled, /Style: Default 副本,Noto Sans SC,72,&H0033CC11,/)
  assert.match(styled, indexed ? /0:00:03\.67,Speaker,Default 副本,/ : /0:00:03\.65,Speaker,Default 副本,/)
  assert.match(styled, /Comment retained/)
  const originalAss = await readFile(join(directory, 'styles.ass'), 'utf8')
  for (const line of originalAss.split('\n').filter(line => /^(Style: Notes|Dialogue: .*Annotation,Default)/.test(line))) {
    assert(styled.includes(line), 'Preserve the unchanged Notes style and event')
  }
  if (process.env.SUBX_SMOKE_SCREENSHOT) {
    await click('styles-tab')
    await expect('!document.querySelector("#styles-panel").hidden', 'show style editor for capture')
    window.showInactive()
    await exec('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const image = await contents.capturePage()
    await writeFile(process.env.SUBX_SMOKE_SCREENSHOT, image.toPNG())
  }
  await addCue('新增 ASS')
  await exec('document.querySelector(".track-lane:first-child .cue").click()')
  await click('delete-cue')
  await expect('document.querySelectorAll(".track-lane:first-child .cue").length === 2', 'remove imported ASS event')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export added and removed ASS events')
  const mutated = await readFile(join(directory, 'mutated.ass'), 'utf8')
  assert.match(mutated, /新增 ASS/)
  assert.doesNotMatch(mutated, /你好, SubX/)
  assert.match(mutated, /Comment retained/)

  const otherAss = baseAss.replace(/^Dialogue: 0,/gm, 'Dialogue: 3,')
  await writeFile(join(directory, 'other-styles.ass'), otherAss)
  await click('import-subtitles')
  await expect('document.querySelectorAll(".ass-layer:not(.generated-layer)[data-ready=true]").length === 2', 'import a second ASS with the same style names')
  await click('styles-tab')
  await exec(`(() => {
    const defaults = Array.from(document.querySelectorAll('.style-list-item')).filter(row => row.title.startsWith('Default ·'))
    if (!defaults[0].querySelector('.style-list-source')?.textContent.endsWith(' · styles.ass') ||
        !defaults[1].querySelector('.style-list-source')?.textContent.endsWith(' · other-styles.ass')) {
      throw Error('Identical style names should show their source tracks')
    }
    defaults[1].querySelector('[aria-label=编辑]').click()
    const name = document.querySelector('#style-editor input[type=text]')
    name.value = 'Notes'
    name.form.requestSubmit()
  })()`)
  await expect('document.querySelector("#status").textContent.includes("已使用这个名称")', 'reject duplicate style names within one ASS track')
  await exec(`(() => {
    const name = document.querySelector('#style-editor input[type=text]')
    const size = document.querySelector('#style-editor input[type=number]')
    name.value = 'Default'
    size.value = '64'
    size.form.requestSubmit()
  })()`)
  await expect('document.querySelector("#status").textContent === "已保存样式"', 'edit a style whose name also appears in another ASS track')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export the edited second ASS track')
  assert.equal(await readFile(join(directory, 'other.ass'), 'utf8'), otherAss.replace('Noto Sans SC,56,', 'Noto Sans SC,64,'))
  await exec("Array.from(document.querySelectorAll('.track-name')).find(button => button.title === 'styles.ass').click()")
  await exec("document.querySelector('#status').textContent = ''")
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export the first ASS track after editing the second')
  assert.equal(await readFile(join(directory, 'first.ass'), 'utf8'), mutated)
  const renameNotes = `(() => {
    Array.from(document.querySelectorAll('.track-name')).find(button => button.title === 'other-styles.ass').click()
    document.querySelector('#style-editor [aria-label=返回样式列表]')?.click()
    Array.from(document.querySelectorAll('.style-list-item')).find(button => button.title.startsWith('Notes ·') && button.title.endsWith('other-styles.ass')).querySelector('[aria-label=编辑]').click()
    const name = document.querySelector('#style-editor input[type=text]')
    name.value = 'Review Notes'
    name.form.requestSubmit()
  })()`
  await exec(`(() => {
    Array.from(document.querySelectorAll('.track-lane:first-child .cue')).find(cue => cue.textContent.includes('备注')).click()
    const text = document.querySelector('#cue-text')
    text.value += '（草稿）'
    text.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await click('styles-tab')
  await exec(renameNotes)
  await expect('document.querySelector("#status").textContent.includes("先应用或取消")', 'protect an unapplied cue draft containing the old style reference')
  await click('cue-tab')
  assert.match(await exec('document.querySelector("#cue-text").value'), /（草稿）$/)
  await exec('document.querySelector("#cue-form .discard-draft").click()')
  await click('styles-tab')
  await exec(renameNotes)
  await expect('document.querySelector("#status").textContent === "已保存样式"', 'rename an ASS style used by an inline override')
  await expect(blueAssPixels, 'preserve the inline override color after renaming its style')
  await click('undo')
  await expect(blueAssPixels, 'undo the style name and override together')
  await click('redo')
  await expect(blueAssPixels, 'redo the style name and override together')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export the renamed inline style')
  assert.equal(await readFile(join(directory, 'renamed.ass'), 'utf8'), otherAss
    .replace('Noto Sans SC,56,', 'Noto Sans SC,64,').replace('Style: Notes,', 'Style: Review Notes,').replace('\\rNotes}', '\\rReview Notes}'))
  await exec(`(() => {
    const canvas = Array.from(document.querySelectorAll('.ass-layer:not(.generated-layer)')).at(-1)
    canvas.dataset.ready = 'false'
    canvas.hidden = true
    Array.from(document.querySelectorAll('.track-lane:first-child .cue')).find(cue => cue.textContent.includes('备注')).click()
    const style = document.querySelector('#cue-style')
    style.value = ''
    style.form.requestSubmit()
  })()`)
  await expect('document.querySelector("#status").textContent === "已更新字幕"', 'choose the default style for an ASS cue')
  await expect(`Array.from(document.querySelectorAll('#captions .caption')).some(node =>
    node.textContent === '备注, Notes' && node.style.webkitTextStrokeColor.startsWith('rgba(17, 17, 17,') &&
    node.style.textShadow === 'none')`, 'respect the implicit ASS style opacity in the basic text preview')
  await exec(`(() => {
    const canvas = Array.from(document.querySelectorAll('.ass-layer:not(.generated-layer)')).at(-1)
    canvas.dataset.ready = 'true'
    canvas.hidden = false
    document.querySelector('#video').dispatchEvent(new Event('timeupdate'))
  })()`)
  await click('styles-tab')
  await exec(`(() => {
    document.querySelector('#style-editor [aria-label=返回样式列表]')?.click()
    Array.from(document.querySelectorAll('.style-list-item')).find(button => button.title.startsWith('Default ·') && button.title.endsWith('other-styles.ass')).querySelector('[aria-label=编辑]').click()
    const name = document.querySelector('#style-editor input[type=text]')
    name.value = 'Review Main'
    name.form.requestSubmit()
  })()`)
  await expect('document.querySelector("#status").textContent === "已保存样式"', 'rename the imported Default style')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export ASS cues that used the renamed Default')
  const renamedDefault = await readFile(join(directory, 'default-renamed.ass'), 'utf8')
  assert.match(renamedDefault, /Annotation,Review Main,/, 'Keep the original style when renaming Default')
  assert.match(renamedDefault, /Speaker,Review Main,/)

  const choose = async (entry, answer) => {
    await click(entry)
    await expect('document.querySelector("#project-change-dialog").open', 'show unsaved project choices')
    await exec('document.querySelector("#project-change-dialog button[value=' + answer + ']").click()')
    await expect('!document.querySelector("#new-project").disabled', 'finish project switch request')
  }
  const newAssCue = `Array.from(document.querySelectorAll('.cue')).find(cue => cue.textContent === '新增 ASS')`
  const firstAssVisibility = `Array.from(document.querySelectorAll('.track-name')).find(button => button.title === 'styles.ass').nextElementSibling`
  await exec(`(() => {
    ${newAssCue}.click()
    const field = document.querySelector('#cue-text')
    field.value = '新增 ASS（待应用）'
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await click('new-project')
  await expect('document.querySelector("#project-change-dialog").open && document.querySelector("#project-change-dialog button[value=save]").disabled', 'require applying the form before saving and switching')
  await exec('document.querySelector("#project-change-dialog button[value=cancel]").click()')
  await expect('!document.querySelector("#project-change-dialog").open && !document.querySelector("#new-project").disabled', 'cancel without losing the draft')
  assert.equal(await exec('document.querySelector("#cue-text").value'), '新增 ASS（待应用）')
  await exec(`${newAssCue}.click()`)
  assert.equal(await exec('document.querySelector("#cue-text").value'), '新增 ASS（待应用）')
  await exec(`${firstAssVisibility}.click()`)
  assert.equal(await exec('document.querySelector("#cue-text").value'), '新增 ASS（待应用）')
  await exec(`${firstAssVisibility}.click()`)
  await exec('document.querySelector("#cue-form .discard-draft").click()')
  assert.equal(await exec('document.querySelector("#cue-text").value'), '新增 ASS')
  await choose('new-project', 'cancel')
  assert.equal(await exec('document.querySelectorAll(".track-lane").length'), 4)

  await choose('open-project', 'discard')
  assert.equal(await exec('document.querySelectorAll(".track-lane").length'), 4)
  assert(await exec('document.title.includes("●")'))

  const savedOnDisk = await readFile(original, 'utf8')
  await writeFile(original, savedOnDisk + '\n')
  await choose('new-project', 'save')
  await expect('document.querySelector("#status").textContent.includes("磁盘上的工程已被修改")', 'keep unsaved edits when save before switching fails')
  assert.equal(await exec('document.querySelectorAll(".track-lane").length'), 4)

  await writeFile(original, savedOnDisk)
  await choose('new-project', 'save')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'save modifications before starting a new project')
  const savedBeforeSwitch = JSON.parse(await readFile(original, 'utf8'))
  assert(savedBeforeSwitch.tracks.find(track => track.ass?.sourceName === 'styles.ass').cues.some(cue => cue.text === '新增 ASS'))

  await addCue('保留临时编辑')
  await choose('new-project', 'save')
  assert.equal(await exec('document.querySelector(".cue").textContent'), '保留临时编辑')
  assert(await exec('document.querySelector("#save-project").title.includes("未保存")'))

  await click('recent-projects')
  await expect('document.querySelector("#recent-dialog").open', 'list recent projects')
  await exec('document.querySelector("#recent-list button").click()')
  await expect('document.querySelector("#project-change-dialog").open', 'ask before switching to a recent project')
  await exec('document.querySelector("#project-change-dialog button[value=discard]").click()')
  await expect('document.querySelectorAll(".track-lane").length === 4', 'discard temporary edits and reopen recent project')
  assert(await exec('Array.from(document.querySelectorAll(".cue")).some(cue => cue.textContent === "新增 ASS")'))

  await click('new-project')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'start the independent SRT workflow')
  const alignmentTop = join(directory, 'alignment-top.srt')
  await writeFile(alignmentTop, Buffer.from('\ufeff' + await readFile(alignmentTop, 'utf8'), 'utf16le').swap16())
  await click('import-subtitles')
  await expect('document.querySelectorAll(".track-lane").length === 1', 'import independent bottom SRT')
  await click('import-subtitles')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'import UTF-16BE independent top SRT')
  const topCue = '.track-lane:first-child .cue:first-child'
  const extraCue = '.track-lane:first-child .cue:nth-child(2)'
  const bottomCue = '.track-lane:last-child .cue'
  const pressCue = selector => exec('document.querySelector(' + JSON.stringify(selector) + ').click()')
  const toggleBottom = () => exec('document.querySelector(".track-heading:last-child .visibility-button").click()')
  const startEdge = async () => {
    const point = await exec(`(() => {
      const box = document.querySelector(${JSON.stringify(topCue)}).getBoundingClientRect()
      return { x: Math.ceil(box.left) + 3, y: box.top + 8, delta: .17 * Number(document.querySelector('#zoom').value) }
    })()`)
    await mouse('mousePressed', point.x, point.y)
    await mouse('mouseMoved', point.x + point.delta, point.y)
    return point
  }
  await toggleBottom()
  const hiddenEdge = await startEdge()
  await expect(`document.querySelector(${JSON.stringify(topCue)}).title.includes('00:00:01.170') && document.querySelector('#snap-guide')?.hidden !== false`, 'ignore a hidden track while snapping an edge')
  await mouse('mouseReleased', hiddenEdge.x + hiddenEdge.delta, hiddenEdge.y)
  await click('undo')
  await toggleBottom()
  const visibleEdge = await startEdge()
  await expect(`document.querySelector(${JSON.stringify(topCue)}).title.includes('00:00:01.200') &&
    document.querySelector('#snap-guide')?.hidden === false && document.querySelector('#snap-guide').style.left === document.querySelector(${JSON.stringify(bottomCue)}).style.left`, 'align to a visible cue and show the snap guide')
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await mouse('mouseReleased', visibleEdge.x + visibleEdge.delta, visibleEdge.y)
  await expect(`document.querySelector(${JSON.stringify(topCue)}).title.includes('00:00:01.000') && document.querySelector('#snap-guide').hidden`, 'cancel a snapped trim and clear the guide')
  await toggleBottom()
  await exec(`(() => {
    const ruler = document.querySelector('#ruler')
    for (const shiftKey of [true, false, false]) {
      ruler.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey, bubbles: true }))
    }
  })()`)
  await expect('document.querySelector("#timecode").value === "00:00:01.200"', 'set the playhead as a snap target')
  const playheadEdge = await startEdge()
  await expect(`document.querySelector(${JSON.stringify(topCue)}).title.includes('00:00:01.200') &&
    !document.querySelector('#snap-guide').hidden && document.querySelector('#snap-guide').style.left === document.querySelector('#playhead').style.left`, 'snap to the playhead with the other track hidden')
  await mouse('mouseReleased', playheadEdge.x + playheadEdge.delta, playheadEdge.y)
  await expect('document.querySelector("#cue-start").value === "00:00:01.200" && document.querySelector("#snap-guide").hidden', 'commit exact snapped time and clear the guide')
  await click('undo')
  await toggleBottom()
  await click('snap-tool')
  await click('link-tool')
  await pressCue(topCue)
  await pressCue(extraCue)
  await expect('document.querySelector("#status").textContent === "请选择另一条轨道上的字幕"', 'reject a same-track pair')
  await exec('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
  await expect('document.querySelector("#status").textContent === "已取消配对"', 'cancel a pending manual pair')
  await pressCue(bottomCue)
  await expect('document.querySelector("#status").textContent.includes("选择另一条轨道")', 'start a new pair after cancelling')
  await pressCue(topCue)
  await expect('document.querySelector("#status").textContent === "已建立链接" && Boolean(document.querySelector(".cue.paired"))', 'link offset cues on two tracks')

  const timesOf = async selector => (await exec('document.querySelector(' + JSON.stringify(selector) + ').title')).split('\n').at(-1)
  const moveTopHalfSecond = async () => {
    const center = await exec(`(() => {
      const bounds = document.querySelector(${JSON.stringify(topCue)}).getBoundingClientRect()
      return { x: bounds.left + 20, y: bounds.top + 8, shift: +document.querySelector('#zoom').value / 2 }
    })()`)
    await mouse('mousePressed', center.x, center.y)
    await mouse('mouseMoved', center.x + center.shift, center.y)
    await mouse('mouseReleased', center.x + center.shift, center.y)
  }
  const assertPairTimes = async (top, bottom) => {
    assert.equal(await timesOf(topCue), top)
    assert.equal(await timesOf(bottomCue), bottom)
  }
  const topOriginal = '00:00:01.000 – 00:00:03.000'
  const bottomOriginal = '00:00:01.200 – 00:00:03.400'
  const topShifted = '00:00:01.500 – 00:00:03.500'
  const bottomShifted = '00:00:01.700 – 00:00:03.900'
  await click('select-tool')
  await moveTopHalfSecond()
  await expect('document.querySelector("#status").textContent === "已移动链接字幕"', 'shift a manual pair by half a second')
  await assertPairTimes(topShifted, bottomShifted)
  await click('undo')
  await assertPairTimes(topOriginal, bottomOriginal)
  await click('redo')
  await assertPairTimes(topShifted, bottomShifted)
  await click('link-tool')
  await pressCue(topCue)
  await expect('document.querySelector("#status").textContent === "已解除链接"', 'unlink the manual pair')
  await click('select-tool')
  await moveTopHalfSecond()
  await expect('document.querySelector("#status").textContent === "已移动字幕"', 'move only the selected cue after unlinking')
  await assertPairTimes('00:00:02.000 – 00:00:04.000', bottomShifted)
  assert.equal(await timesOf(extraCue), '00:00:04.000 – 00:00:04.800')
  const menuCommand = async (target, label) => {
    await exec(`(() => {
      const node = document.querySelector(${JSON.stringify(target)})
      const box = node.getBoundingClientRect()
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 12, clientY: box.top + 8, button: 2 }))
    })()`)
    await expect(`document.querySelector('#timeline-menu:popover-open')`, 'open the timeline context menu')
    await exec(`Array.from(document.querySelectorAll('#timeline-menu button')).find(item => item.textContent === ${JSON.stringify(label)}).click()`)
  }
  await menuCommand(topCue, '复制字幕')
  await exec('document.querySelector(".track-heading:last-child .track-name").click()')
  await expect('document.querySelector(".track-heading:last-child").classList.contains("active") && document.querySelector(".track-lane:last-child").classList.contains("active")', 'highlight the selected track header and lane')
  const firstHeaderPoint = await exec(`(() => {
    const box = document.querySelector('.track-heading:first-child').getBoundingClientRect()
    return { x: box.x + 24, y: box.y + box.height / 2 }
  })()`)
  await mouse('mousePressed', firstHeaderPoint.x, firstHeaderPoint.y)
  await mouse('mouseReleased', firstHeaderPoint.x, firstHeaderPoint.y)
  await expect('document.querySelector(".track-heading:first-child").classList.contains("active")', 'select a track by clicking its header row')
  const emptyLanePoint = await exec(`(() => {
    const view = document.querySelector('#timeline-scroll').getBoundingClientRect()
    const lane = document.querySelector('.track-lane:last-child').getBoundingClientRect()
    return { x: view.right - 60, y: lane.y + lane.height / 2 }
  })()`)
  await mouse('mousePressed', emptyLanePoint.x, emptyLanePoint.y, 1)
  await mouse('mouseReleased', emptyLanePoint.x, emptyLanePoint.y, 1)
  await mouse('mousePressed', emptyLanePoint.x, emptyLanePoint.y, 2)
  await mouse('mouseReleased', emptyLanePoint.x, emptyLanePoint.y, 2)
  await expect('document.querySelector(".track-heading:last-child").classList.contains("active")', 'select a track by double-clicking its lane')
  assert.equal(await exec('getComputedStyle(document.querySelector(".cue:not(.playing)")).borderTopColor'), 'rgb(68, 45, 15)', 'draw a dark border around unselected cue blocks')
  const narrowHeading = await exec('document.querySelector("#track-headings").offsetWidth')
  assert(narrowHeading >= 96 && narrowHeading <= 128, 'Use a narrower default track header width')
  await exec(`(() => {
    const handle = document.querySelector('#heading-resizer')
    handle.focus()
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })()`)
  await expect(`document.querySelector('#track-headings').offsetWidth === ${narrowHeading + 8}`, 'widen the track header area from the keyboard')
  await exec('document.querySelector(".track-heading:last-child .lock-button").click()')
  await expect('document.querySelector(".track-heading:last-child .lock-button").getAttribute("aria-pressed") === "true" && document.querySelector(".track-lane:last-child").classList.contains("locked-track") && document.querySelector(".track-lane:last-child .cue.locked") && document.querySelector("#export-subtitles").disabled', 'lock a track and disable its cues and exports')
  await exec('document.querySelector(".track-heading:last-child .lock-button").click()')
  await expect('document.querySelector(".track-heading:last-child .lock-button").getAttribute("aria-pressed") === "false" && !document.querySelector(".track-lane:last-child").classList.contains("locked-track") && !document.querySelector("#export-subtitles").disabled', 'unlock a track and re-enable its cues and exports')
  await menuCommand('#ruler', '粘贴字幕到当前轨道')
  await expect(`document.querySelector('.track-lane:last-child .cue.selected').title.endsWith('00:00:01.200 – 00:00:03.200')`, 'paste at the playhead into the selected track with the original duration')
  await menuCommand('.cue.selected', '删除字幕')
  await expect('document.querySelectorAll(".track-lane:last-child .cue").length === 1', 'delete a subtitle using its context menu')
  await click('undo')
  await expect('document.querySelectorAll(".track-lane:last-child .cue").length === 2', 'undo context-menu deletion')
  await click('undo')
  await exec('document.querySelector(".track-heading:first-child .track-name").click()')
  await menuCommand('#ruler', '选中当前轨道全部字幕块')
  await expect('document.querySelectorAll(".track-lane:first-child .cue.selected").length === 2', 'select every subtitle from the active track')
  await moveTopHalfSecond()
  await expect('document.querySelector("#status").textContent === "已移动成组字幕"', 'move the selected subtitles in a single group')
  assert.equal(await timesOf(topCue), '00:00:02.500 – 00:00:04.500')
  assert.equal(await timesOf(extraCue), '00:00:04.500 – 00:00:05.300')
  await click('undo')
  assert.equal(await timesOf(topCue), '00:00:02.000 – 00:00:04.000')
  assert.equal(await timesOf(extraCue), '00:00:04.000 – 00:00:04.800')
  await click('save-project')
  await expect('document.querySelector("#status").textContent === "已保存工程"', 'save the independent SRT project')
  const alignment = JSON.parse(await readFile(join(directory, 'alignment.subx'), 'utf8'))
  assert.deepEqual(alignment.links, [])
  assert.equal(alignment.tracks[1].cues[0].start, 1700)

  const unexpectedClose = () => fail(new Error('The window closed before resolving unsaved edits'))
  window.once('closed', unexpectedClose)
  await editTopCue('写入完成前关闭窗口')
  beforeSavePath = async () => {
    await click('undo')
    assert.equal(await exec('document.title.includes("●")'), false, 'Undo to the previous disk version while Save As is pending')
    const close = Promise.withResolvers()
    window.once('close', event => close.resolve(event.defaultPrevented))
    window.close()
    assert.equal(await close.promise, true, 'Keep the window open until the active project write settles')
  }
  await click('save-project-as')
  await expect('document.querySelector("#status").textContent === "已写入工程，仍有尚未保存的修改"', 'update the saved state before retrying the window close')
  await expect('document.querySelector("#quit-dialog").open', 'prompt to save before closing after the write settles')
  const quitGeometry = await exec("(() => { const box = document.querySelector('#quit-dialog').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2, viewWidth: innerWidth, viewHeight: innerHeight } })()")
  assert.equal(Math.round(quitGeometry.x), Math.round(quitGeometry.viewWidth / 2), 'Center the quit dialog horizontally')
  assert.equal(Math.round(quitGeometry.y), Math.round(quitGeometry.viewHeight / 2), 'Center the quit dialog vertically')
  assert.deepEqual(await exec("[...document.querySelectorAll('#quit-dialog .quit-actions button')].map(button => button.textContent)"), ['保存项目', '放弃保存', '取消退出'], 'Offer save, discard and cancel in the quit dialog')
  assert.equal(await exec('document.querySelector("#quit-save").classList.contains("primary")'), true, 'Highlight the save action with the accent color')
  assert.deepEqual(await exec("(() => { const style = getComputedStyle(document.querySelector('#quit-dialog .quit-app-icon')); return { radius: style.borderRadius, width: style.borderTopWidth, background: style.backgroundColor } })()"), { radius: '0px', width: '0px', background: 'rgba(0, 0, 0, 0)' }, 'Show the app icon without an added background or border')
  await exec('document.querySelector("#quit-cancel").click()')
  await expect('!document.querySelector("#quit-dialog").open && getComputedStyle(document.querySelector("#quit-dialog")).display === "none"', 'cancel the close request from the quit dialog')
  const closingProject = JSON.parse(await readFile(join(directory, 'close-after-save.subx'), 'utf8'))
  assert.equal(closingProject.tracks[0].cues[0].text, '写入完成前关闭窗口')
  assert.equal(await exec('document.querySelector("#cue-text").value'), alignment.tracks[0].cues[0].text)

  await expect('!document.querySelector("#save-project-as").disabled', 'continue editing after declining the deferred close')
  beforeSavePath = async () => {
    const quit = Promise.withResolvers()
    app.once('before-quit', event => quit.resolve(event.defaultPrevented))
    app.quit()
    assert.equal(await quit.promise, true, 'Defer application quit while the Save As picker is active')
  }
  await click('save-project-as')
  await expect('document.querySelector("#quit-dialog").open', 'prompt to save before quitting after the write settles')
  await exec('document.querySelector("#quit-cancel").click()')
  await expect('!document.querySelector("#quit-dialog").open && !document.querySelector("#save-project-as").disabled && document.title.includes("●")', 'retry quit after canceling Save As without discarding unsaved edits')
  window.off('closed', unexpectedClose)
}
