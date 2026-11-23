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
  }
  // Preview runs stay on screen for real compositing, so attach the debugger in both modes.
  contents.debugger.attach('1.3')
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
  const menuCommand = async (target, label) => {
    await exec(`(() => {
      const node = document.querySelector(${JSON.stringify(target)})
      const box = node.getBoundingClientRect()
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 12, clientY: box.top + 8, button: 2 }))
    })()`)
    await expect(`document.querySelector('#timeline-menu:popover-open')`, 'open the timeline context menu')
    await exec(`Array.from(document.querySelectorAll('#timeline-menu button')).find(item => item.textContent === ${JSON.stringify(label)}).click()`)
  }

  const captureScreenshot = async path => {
    const capture = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
    await writeFile(path, Buffer.from(capture.data, 'base64'))
  }
  await expect('document.getElementById("ruler").children.length > 0', 'load Electron workspace')
  assert.equal(await exec('document.querySelector("#timecode").value'), '00:00:00.00', 'Use a 30 fps timebase for empty projects')
  assert.equal(await exec('getComputedStyle(document.querySelector("#styles-tab .icon")).color'), 'rgb(255, 255, 255)', 'Show the active tab icon in white')
  await click('settings-tab')
  assert.equal(await exec('getComputedStyle(document.querySelector("#settings-tab .icon")).color'), 'rgb(255, 255, 255)', 'Show the other active tab icon in white')
  assert.notEqual(await exec('getComputedStyle(document.querySelector("#styles-tab .icon")).color'), 'rgb(255, 255, 255)', 'Keep inactive tab icons muted')
  await click('styles-tab')
  await click('qc-tab')
  await expect('!document.querySelector("#qc-panel").hidden && document.querySelector("#qc-cps").value === "17" && document.querySelector("#qc-summary").textContent.includes("问题")', 'open the quality check panel')
  await click('text-tools-tab')
  await expect('!document.querySelector("#text-tools-panel").hidden && !document.querySelector("#text-upper").disabled', 'open the text tools panel')
  await click('styles-tab')
  const alignedChrome = await exec(`(() => {
    const rail = document.querySelector('.toolrail').getBoundingClientRect()
    const trackData = document.querySelector('#track-data').getBoundingClientRect()
    const zoom = document.querySelector('#timeline-zoom')
    const zoomBox = zoom.getBoundingClientRect()
    return {
      railWidth: rail.width,
      tokenWidth: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolrail-width')),
      zoomOffset: Math.abs((zoomBox.left - parseFloat(getComputedStyle(zoom).marginLeft)) - trackData.left),
    }
  })()`)
  assert.equal(alignedChrome.railWidth, alignedChrome.tokenWidth, 'Keep the timeline toolrail on its layout token')
  assert(alignedChrome.zoomOffset <= 1, 'Align the zoom bar with the timeline after the track headings: ' + JSON.stringify(alignedChrome))
  const viewportFit = await exec(`({
    horizontal: document.documentElement.scrollWidth - innerWidth,
    vertical: document.documentElement.scrollHeight - innerHeight,
  })`)
  assert(viewportFit.horizontal <= 1 && viewportFit.vertical <= 1,
    'Keep the workspace free of viewport overflow: ' + JSON.stringify(viewportFit))
  await exec(`document.querySelector('.upper').style.setProperty('--inspector-width', '255px')`)
  await delay(120)
  const narrowInspector = await exec(`(() => {
    const inspector = document.querySelector('.inspector')
    const body = document.querySelector('#styles-panel')
    const row = document.querySelector('.style-list-item')
    return {
      overflow: inspector.scrollWidth - inspector.clientWidth,
      bodyOverflow: body.scrollWidth - body.clientWidth,
      rowOverflow: row ? row.scrollWidth - row.clientWidth : 0,
    }
  })()`)
  assert(narrowInspector.overflow <= 1 && narrowInspector.bodyOverflow <= 1 && narrowInspector.rowOverflow <= 1,
    'Keep the inspector and style rows inside a 255px panel: ' + JSON.stringify(narrowInspector))
  await exec(`document.querySelector('.upper').style.removeProperty('--inspector-width')`)
  await delay(120)
  const tabStyles = await exec(`(() => {
    const active = getComputedStyle(document.querySelector('#styles-tab'))
    const inactive = getComputedStyle(document.querySelector('#settings-tab'))
    return { underline: active.borderBottomWidth, activeColor: active.color, inactiveColor: inactive.color }
  })()`)
  assert.equal(tabStyles.underline, '0px', 'Remove the active tab underline')
  const tabPoint = await exec(`(() => { const box = document.querySelector('#settings-tab').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 } })()`)
  await mouse('mouseMoved', tabPoint.x, tabPoint.y)
  await delay(150)
  const tabHover = await exec(`(() => { const style = getComputedStyle(document.querySelector('#settings-tab')); return { background: style.backgroundColor, color: style.color } })()`)
  assert.equal(tabHover.background, 'rgba(0, 0, 0, 0)', 'Keep tab hover free of a background block')
  assert.notEqual(tabHover.color, tabStyles.inactiveColor,
    'Brighten the hovered tab text: ' + JSON.stringify({ ...tabHover, point: tabPoint, hovered: await exec('document.querySelector("#settings-tab").matches(":hover")') }))
  await mouse('mouseMoved', 700, 250)
  await exec(`document.querySelector('#tabs-scroll').style.flex = '0 1 160px'`)
  await delay(300)
  await exec(`document.querySelector('#tabs-scroll').dispatchEvent(new Event('scroll'))`)
  await delay(150)
  const tabOverflow = await exec(`(() => ({ left: !document.querySelector('#tabs-more-left').hidden, right: !document.querySelector('#tabs-more-right').hidden }))()`)
  assert(tabOverflow.left || tabOverflow.right, 'Show an ellipsis when tabs overflow: ' + JSON.stringify(tabOverflow))
  await exec(`(document.querySelector('#tabs-more-right').hidden ? document.querySelector('#tabs-more-left') : document.querySelector('#tabs-more-right')).click()`)
  await delay(200)
  const tabMenu = await exec(`(() => {
    const menu = document.querySelector('#tabs-menu')
    const box = menu.getBoundingClientRect()
    return {
      open: menu.matches(':popover-open'),
      items: [...menu.querySelectorAll('button')].map(button => button.textContent.trim()),
      inside: box.left >= 3 && box.top >= 3 && box.right <= innerWidth - 3 && box.bottom <= innerHeight - 3,
    }
  })()`)
  assert(tabMenu.open && tabMenu.items.length > 0, 'List the hidden tabs in the ellipsis menu: ' + JSON.stringify(tabMenu))
  assert(tabMenu.inside, 'Keep the tab ellipsis menu inside the viewport: ' + JSON.stringify(tabMenu))
  await exec('document.querySelector("#tabs-menu button").click()')
  await delay(300)
  const revealedTab = await exec(`(() => {
    const tab = document.querySelector('[role=tab][aria-selected=true]')
    const view = document.querySelector('#tabs-scroll').getBoundingClientRect()
    const box = tab.getBoundingClientRect()
    return box.left >= view.left - 1 && box.right <= view.right + 1
  })()`)
  assert(revealedTab, 'Reveal the chosen tab after picking it from the ellipsis menu')
  await exec(`document.querySelector('#tabs-scroll').style.removeProperty('flex')`)
  await delay(250)
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
    assert.deepEqual(nativeEdit.submenu.items.filter(item => item.type !== 'separator').map(item => item.label), ['撤销', '重做', '整体平移…', '查找与替换…'], 'Expose undo, redo, shift and find in the native edit menu')
  }
  if (process.env.SUBX_SCREENSHOT_PATH) await captureScreenshot(process.env.SUBX_SCREENSHOT_PATH)
  assert(await exec('!document.querySelector("#empty-actions").hidden && !document.querySelector("#empty-timeline").hidden'), 'Show first-run actions and the empty timeline hint')
  await click('menu-file')
  await expect('!document.querySelector("#menu-file-popup").hidden && document.querySelector("#menu-file").getAttribute("aria-expanded") === "true"', 'open the file menu with icon items')
  assert.deepEqual(await exec('[...document.querySelectorAll("#menu-file-popup button")].map(button => button.id)'), ['new-project', 'open-project', 'recent-projects', 'save-project', 'save-project-as', 'menu-open-media', 'blank-video', 'import-subtitles', 'import-script', 'menu-quit'], 'List the file commands in order')
  assert(await exec('[...document.querySelectorAll("#menu-file-popup button")].every(button => button.querySelector("svg use"))'), 'Give every file command an icon')
  await mouse('mousePressed', 700, 250)
  await mouse('mouseReleased', 700, 250)
  await expect('document.querySelector("#menu-file-popup").hidden && document.querySelector("#menu-file").getAttribute("aria-expanded") === "false"', 'close the file menu when clicking outside')
  await click('menu-edit')
  await expect('!document.querySelector("#menu-edit-popup").hidden', 'open the edit menu')
  assert.deepEqual(await exec('[...document.querySelectorAll("#menu-edit-popup button")].map(button => button.id)'), ['menu-undo', 'menu-redo', 'menu-shift', 'menu-find'], 'Expose undo, redo, shift and find in the edit menu')
  await click('menu-shift')
  await expect('document.querySelector("#shift-dialog").open', 'open the shift dialog from the edit menu')
  await exec('document.querySelector("#shift-cancel").click()')
  await expect('!document.querySelector("#shift-dialog").open', 'close the shift dialog')
  await click('menu-edit')
  await click('menu-find')
  await expect('!document.querySelector("#find-panel").hidden', 'open the find panel from the edit menu')
  await exec('document.querySelector("#find-close").click()')
  await expect('document.querySelector("#find-panel").hidden', 'close the find panel')
  for (const type of ['rawKeyDown', 'keyUp']) {
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 4 })
  }
  await expect('!document.querySelector("#find-panel").hidden', 'open the find panel with Cmd+F')
  await exec('document.querySelector("#find-close").click()')
  await exec('(() => { const quality = document.querySelector("#quality"); quality.value = "4"; quality.dispatchEvent(new Event("change")) })()')
  await expect('document.querySelector("#quality").value === "4"', 'switch the preview quality from the preview select')
  await exec('(() => { const quality = document.querySelector("#quality"); quality.value = "1"; quality.dispatchEvent(new Event("change")) })()')
  await click('menu-about')
  await click('menu-shortcuts')
  await expect('document.querySelector("#shortcuts-dialog").open', 'open the shortcuts window from the about menu')
  await expect('document.querySelectorAll("#shortcuts-dialog kbd").length >= 10 && document.querySelector("#shortcuts-dialog").textContent.includes("Space")', 'show shortcut keys as keycaps')
  await exec('document.querySelector("#shortcuts-dialog button").click()')
  await expect('!document.querySelector("#shortcuts-dialog").open && document.querySelector("#menu-about-popup").hidden', 'close the shortcuts window and its menu')
  await exec('document.querySelector("#styles-tab").focus({ preventScroll: true })')
  for (const type of ['rawKeyDown', 'keyUp']) {
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  }
  await expect('document.activeElement.id === "settings-tab" && document.querySelector("#settings-tab").getAttribute("aria-selected") === "true"', 'move between inspector tabs with the keyboard')
  await click('styles-tab')
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

    await captureScreenshot(process.env.SUBX_ICON_SCREENSHOT_PATH || '/private/tmp/subx-icons-check.png')
    // #next-review 是带文字的状态按钮，不参与图标按钮的正方形检查。
    const squares = await exec(`[...document.querySelectorAll('.timeline-controls button:not(#next-review), .toolrail button, .heading-actions button, .track-heading button')].every(button => { const r = button.getBoundingClientRect(); return Math.abs(r.width - r.height) < .01 })`)
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
  assert(await exec('getComputedStyle(document.querySelector("#quality")).backgroundImage.includes("svg")'), 'Keep the quality select arrow visible')
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
    editItems: [...document.querySelectorAll('#menu-edit-popup button')].map(button => button.id)
  })`))
  assert.deepEqual(timelineLayout.rail, ['select-tool', 'split-tool', 'select-forward', 'select-backward'], 'Lay out the four cursor modes on the timeline toolrail')
  assert.deepEqual(timelineLayout.actions, ['add-cue', 'undo', 'redo', 'split-cue', 'trim-start', 'trim-end', 'timeline-delete', 'toggle-marker'], 'Lay out the instant actions in the timeline header')
  assert.deepEqual(timelineLayout.states, ['snap-tool', 'waveform-mode'], 'Lay out the timeline state toggles on the right')
  assert(timelineLayout.addTrack, 'Place an icon-only add-track button in the timeline heading row')
  assert.deepEqual(timelineLayout.editItems, ['menu-undo', 'menu-redo', 'menu-shift', 'menu-find'], 'Keep the edit menu limited to undo, redo, shift and find')
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
    // 标尺与缩放条现在有键盘焦点环；按空格仍然播放/暂停，但不能改变面板边框。
    await expect(`(() => {
      const style = getComputedStyle(document.querySelector(${JSON.stringify(selector)}))
      return style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) >= 2 &&
        getComputedStyle(document.querySelector('.timeline')).borderTopColor === 'rgb(51, 51, 51)'
    })()`, 'show a keyboard focus ring on ' + selector + ' after Space')
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
  await expect("document.querySelector('#about-dialog').open && document.querySelector('#about-version').textContent.length > 0 && document.querySelector('#about-dialog img.about-icon')?.complete && document.querySelector('#about-dialog').textContent.includes('AchiDilyar')", 'show the app icon, version and developer')
  await exec("document.querySelector('#about-dialog button').click()")
  await click('styles-tab')
  await expect(`(() => {
    const lanes = document.querySelector('#track-lanes')
    const rows = [...lanes.children]
    const center = box => (box.top + box.bottom) / 2
    const first = rows[0].getBoundingClientRect()
    const last = rows[1].getBoundingClientRect()
    return rows.length === 2 && Math.abs(center(lanes.getBoundingClientRect()) - (first.top + last.bottom) / 2) <= 1 &&
      Array.from(document.querySelectorAll('.tick')).at(-1).textContent === '00:00:10.00' &&
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
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })()`)
  await expect(`document.querySelector('.timeline').clientHeight === ${tallTimeline - 16}`, 'resize the timeline using the separator arrow key')
  await exec(`(() => {
    const divider = document.querySelector('#vertical-divider')
    divider.focus()
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
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
  await expect('document.querySelector(".cue.selected").classList.contains("playing") && getComputedStyle(document.querySelector(".cue.selected")).color === "rgb(255, 255, 255)" && getComputedStyle(document.querySelector(".cue.selected")).backgroundColor === "rgb(168, 98, 26)"', 'highlight the cue under the playhead without changing its base fill')
  assert(await exec('!document.querySelector("#cue-meta").hidden && document.querySelector("#cue-meta-duration").textContent.includes("秒") && document.querySelector("#cue-meta-cps").textContent.includes("字/秒")'), 'Show cue duration and reading speed')
  assert.equal(Math.round(await exec('document.querySelector(".cue").getBoundingClientRect().height')), 32, 'Match the cue visual height to the track height')
  assert.equal(Math.round(await exec('document.querySelector(".track-lane").getBoundingClientRect().height')), 32, 'Keep the single-lane track height at 32 pixels')
  assert.equal(await exec('document.querySelector(".cue")?.textContent'), '第一条字幕')
  assert.equal(await exec('document.querySelector("#cue-start").value'), '00:00:00.000')
  await click('menu-find')
  await expect('!document.querySelector("#find-panel").hidden', 'open the find panel for the current track')
  await exec('(() => { const q = document.getElementById("find-query"); q.value = "第一条"; q.dispatchEvent(new Event("input")) })()')
  await expect('document.querySelector("#find-summary").textContent.includes("第 1 / 1 个匹配")', 'count the matching subtitle text')
  await exec('document.getElementById("find-replacement").value = "第二条"')
  await exec('document.getElementById("find-replace-all").click()')
  await expect('document.querySelector(".cue")?.textContent === "第二条字幕"', 'replace matching subtitle text')
  await click('undo')
  await expect('document.querySelector(".cue")?.textContent === "第一条字幕"', 'undo the replacement')
  await exec('document.getElementById("find-close").click()')
  await click('menu-edit')
  await click('menu-shift')
  await expect('document.querySelector("#shift-dialog").open', 'open the shift dialog for the current track')
  await exec('(() => { const input = document.getElementById("shift-time"); input.value = "+00:00:00.500"; input.dispatchEvent(new Event("input")) })()')
  await exec('document.querySelector("#shift-form").requestSubmit()')
  await expect('document.querySelector("#cue-start").value === "00:00:00.500"', 'shift the current track by 500 ms')
  await click('undo')
  await expect('document.querySelector("#cue-start").value === "00:00:00.000"', 'undo the track shift')
  await exec(`(() => { for (let i = 0; i < 15; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })()`)
  await expect('document.querySelector("#timecode").value === "00:00:01.15"', 'move the playhead before adding an overlapping cue')
  await click('add-cue')
  assert.equal(await exec('document.querySelector(".cue.selected").textContent'), '')
  // 一条轨道只有一行：重叠字幕块不能上下叠成两行。
  assert(await exec(`(() => {
    const blocks = [...document.querySelectorAll('.cue')]
    const tops = new Set(blocks.map(block => Math.round(block.getBoundingClientRect().top)))
    return blocks.length === 2 && tops.size === 1 &&
      Math.round(document.querySelector('.track-lane').getBoundingClientRect().height) === 32
  })()`), 'Keep overlapping cues on one timeline row instead of stacking lanes')
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
  await expect('document.querySelector(".cue")?.textContent === ""', 'undo text while retaining the timed block')
  await click('undo')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'undo first cue and retain the two starter tracks')
  await exec(`(() => { for (let i = 0; i < 15; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })) })()`)
  await expect('document.querySelector("#timecode").value === "00:00:00.00"', 'return the playhead to the start before the blank cue')
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
  await expect('document.querySelector(".cue")?.textContent === ""', 'reopen the empty timed cue')
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
  const lastTime = indexed ? '00:00:04.05' : '00:00:05.000'
  await expect(`document.querySelector('#timecode').value === "${lastTime}" && !document.querySelector('video').seeking`,
    'clamp clicks in the two-second tail to the last video position')
  await exec(`document.querySelector('#ruler').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))`)
  await expect(`document.querySelector('#timecode').value === "${lastTime}"`, 'keep the playhead at the last frame when nudged right')
  await exec(`(() => {
    const scroll = document.querySelector('#timeline-scroll')
    const track = document.querySelector('#track-data')
    const end = parseFloat(track.style.getPropertyValue('--timeline-end'))
    const usable = scroll.clientWidth - document.querySelector('#track-headings').offsetWidth
    scroll.scrollLeft = Math.max(0, end - usable + 120)
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
    await expect('document.querySelector("#timecode").value === "00:00:00.01"', 'snap a click between frames to the nearest video frame')
    const rulerScheme = await exec(`(() => ({
      labels: [...document.querySelectorAll('#ruler .tick-label')].map(node => node.textContent),
      grid: getComputedStyle(document.querySelector('.track-lane')).backgroundImage,
    }))()`)
    assert(rulerScheme.labels.length > 4 && rulerScheme.labels.every(label => /^\d{2}:\d{2}:\d{2}\.[0-5]\d$/.test(label)),
      'Label the ruler in frame time at maximum zoom: ' + JSON.stringify(rulerScheme.labels))
    assert(rulerScheme.labels.some(label => !label.endsWith('.00')), 'Show sub-second frame labels at maximum zoom: ' + JSON.stringify(rulerScheme.labels))
    assert.equal(rulerScheme.grid, 'none', 'Draw no grid inside track lanes')
  }
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 0')
  await expect('document.querySelector("#zoom-thumb").style.transform === "translateX(0px)"', 'start the zoom grip at the left scroll boundary')
  const zoomBarGeometry = await exec(`(() => {
    const bar = document.querySelector('#timeline-zoom').getBoundingClientRect()
    const thumb = document.querySelector('#zoom-thumb').getBoundingClientRect()
    const grips = [...document.querySelectorAll('.zoom-grip')].map(grip => { const box = grip.getBoundingClientRect(); return { width: box.width, height: box.height } })
    return { bar: bar.height, thumb: thumb.height, grips }
  })()`)
  assert.equal(zoomBarGeometry.thumb, zoomBarGeometry.bar, 'Match the drag bar height to the zoom track: ' + JSON.stringify(zoomBarGeometry))
  assert(zoomBarGeometry.grips.every(grip => Math.abs(grip.height - zoomBarGeometry.thumb) < .01 && Math.abs(grip.width - zoomBarGeometry.thumb) < .01), 'Match both zoom grip diameters to the drag bar height: ' + JSON.stringify(zoomBarGeometry))
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
  await expect('!document.querySelector("#watermark-fields").hidden && document.querySelector("#watermark-overlay").hidden',
    'reveal the watermark controls and keep the preview empty until an image is chosen')
  await click('undo')
  await expect('document.querySelector("#watermark-fields").hidden', 'hide the watermark controls when undoing the project setting')
  await click('play')
  await expect('document.querySelector("video").currentTime > 0.15', 'play local MP4')
  await click('play')
  await exec('document.querySelector("video").currentTime = 2')
  await expect('document.querySelector("video").currentTime === 2 && !document.querySelector("video").seeking', 'seek local MP4')
  await writeFile(join(directory, 'unplayable.mp4'), 'this file contains no video')
  const originalMediaUrl = await exec('document.querySelector("video").src')
  await click('open-media')
  await expect('!document.querySelector("#open-media").disabled && document.querySelector("#status").textContent.includes("无法播放")', 'report an unreadable replacement video')
  assert.equal(await exec('document.querySelector("#status").dataset.tone'), 'error', 'Mark an unreadable video as an error status')
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
  await expect(`!document.querySelector('video').seeking && typeof document.querySelector('video').releaseHeldFrame === 'function' && document.querySelector('#timecode').value === '00:00:03.05'`, 'await the seek clock and hold the decoded frame')
  assert.equal(await exec('Boolean(document.querySelector(".caption"))'), indexed, 'Use the target time while the frame callback is held')
  const frameTime = await exec('document.querySelector("video").releaseHeldFrame()')
  assert(frameTime >= 3.8 && frameTime < 3.86, 'Use a frame timestamp inside the short cue')
  assert.equal(await exec('document.querySelector("#timecode").value'), '00:00:03.05', 'A late frame must not replace the precise playhead time')
  assert.equal(await exec('document.querySelector(".caption")?.textContent'), '帧预览检查', 'Preview the subtitle at the displayed frame timestamp')
  await exec('document.querySelector("video").currentTime = 2')
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.00"', 'reset before testing a superseded seek')
  await holdFrame()
  await expect('typeof document.querySelector("video").releaseHeldFrame === "function"', 'hold a frame from the earlier seek')
  await exec('document.querySelector("video").currentTime = 2')
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.00"', 'settle the newer seek before releasing the old frame')
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
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.00"', 'position the playhead for the zoom anchoring checks')
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
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:04.00"', 'move the playhead outside the zoomed-in viewport')
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
  const offscreenMarker = await exec(`(() => {
    const marker = document.querySelector('#zoom-playhead')
    const bar = document.querySelector('#timeline-zoom').getBoundingClientRect()
    const box = marker.getBoundingClientRect()
    return { hidden: marker.hidden, inside: box.left >= bar.left - 1 && box.right <= bar.right + 1, width: box.width }
  })()`)
  assert(!offscreenMarker.hidden && offscreenMarker.inside && offscreenMarker.width >= 1,
    'Mark the offscreen playhead position in the zoom bar: ' + JSON.stringify(offscreenMarker))
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
  await expect('document.querySelector("video").currentTime === 4 && !document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:04.00"', 'seek one second per Shift+Arrow key')
  const playheadInView = `(() => {
    const head = document.querySelector('#playhead').getBoundingClientRect()
    const left = document.querySelector('#track-headings').getBoundingClientRect().right
    const right = document.querySelector('#timeline-scroll').getBoundingClientRect().right
    return head.left >= left && head.right <= right
  })()`
  assert(await exec(playheadInView), 'Reveal the keyboard playhead after moving past the right edge')
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 10000')
  await nudgeRuler('ArrowLeft', 0)
  await expect(`!document.querySelector("video").seeking && document.querySelector("#timecode").value === "${indexed ? '00:00:03.05' : '00:00:03.900'}"`, 'seek to the preceding video frame with ArrowLeft')
  assert(await exec(playheadInView), 'Reveal the keyboard playhead when it is behind the sticky track header')
  await exec(`(() => { const v = document.querySelector('video'); v.currentTime = 4; document.querySelector('#timeline-scroll').scrollLeft = 0; v.play() })()`)
  await expect(playheadInView, 'page an offscreen playhead into view during playback')
  await exec('document.querySelector("video").pause()')
  // 播放中越过右边缘时整屏右移一格：播放头回到左侧重新向右走，而不是贴住右边缘连续滚动。
  const pageSetup = await exec(`(() => {
    const scroll = document.querySelector('#timeline-scroll')
    const heads = document.querySelector('#track-headings')
    const zoom = document.querySelector('#zoom')
    zoom.value = zoom.max
    zoom.dispatchEvent(new Event('input'))
    scroll.scrollLeft = 0
    const ruler = document.querySelector('#ruler').getBoundingClientRect()
    const usable = scroll.clientWidth - heads.offsetWidth
    return { usable, scale: Number(zoom.value), x: ruler.left + usable - 60, y: ruler.top + 7 }
  })()`)
  await mouse('mousePressed', pageSetup.x, pageSetup.y)
  await mouse('mouseReleased', pageSetup.x, pageSetup.y)
  await expect('!document.querySelector("video").seeking && document.querySelector("#timeline-scroll").scrollLeft === 0', 'hold the timeline at the left with the paused playhead near the right edge')
  await exec('document.querySelector("#play").click()')
  await expect('document.querySelector("#timeline-scroll").scrollLeft > 0', 'page the timeline once the playing playhead leaves the right edge')
  const pageJump = await exec(`(() => {
    const scroll = document.querySelector('#timeline-scroll')
    const heads = document.querySelector('#track-headings')
    const head = document.querySelector('#playhead').getBoundingClientRect()
    return { scroll: scroll.scrollLeft, left: head.left - heads.getBoundingClientRect().right, time: document.querySelector('#timecode').value }
  })()`)
  assert(pageJump.scroll > pageSetup.usable * .4, 'Jump the timeline by about one window when the playing playhead leaves the right edge: ' + JSON.stringify({ pageSetup, pageJump }))
  assert(pageJump.left < 260, 'Restart the playing playhead near the left edge after a page jump: ' + JSON.stringify({ pageSetup, pageJump }))
  await delay(300)
  const pageHold = await exec('document.querySelector("#timeline-scroll").scrollLeft')
  assert(Math.abs(pageHold - pageJump.scroll) < 4, 'Hold the timeline still after a page jump until the playhead reaches the right edge again: ' + JSON.stringify({ pageJump, pageHold }))
  await exec('document.querySelector("video").pause()')
  await exec('document.querySelector("video").currentTime = 2')
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 0')
  // 点击过的控件不能吃掉全局快捷键：空格仍是播放/暂停，方向键仍是移动播放头。
  const snapPoint = await exec(`(() => {
    const box = document.querySelector('#snap-tool').getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })()`)
  await mouse('mousePressed', snapPoint.x, snapPoint.y)
  await mouse('mouseReleased', snapPoint.x, snapPoint.y)
  await expect('document.activeElement === document.querySelector("#snap-tool")', 'keep focus on a pointer-clicked toolbar button for this check')
  const snapPressed = await exec('document.querySelector("#snap-tool").getAttribute("aria-pressed")')
  const pressShortcut = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, modifiers })
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
  }
  await pressShortcut(' ', 'Space', 32)
  await delay(300)
  assert(await exec('!document.querySelector("video").paused'), 'Play with Space while a toolbar button has focus')
  assert.equal(await exec('document.querySelector("#snap-tool").getAttribute("aria-pressed")'), snapPressed, 'Keep the focused toolbar button unchanged when Space plays')
  await exec('document.querySelector("video").pause()')
  await delay(150)
  const arrowTime = await exec('document.querySelector("#timecode").value')
  await pressShortcut('ArrowRight', 'ArrowRight', 39)
  await delay(200)
  assert.notEqual(await exec('document.querySelector("#timecode").value'), arrowTime, 'Nudge the playhead with ArrowRight while a toolbar button has focus')
  assert.equal(await exec('document.querySelector("#snap-tool").getAttribute("aria-pressed")'), snapPressed, 'Keep the focused toolbar button unchanged when arrows nudge the playhead')
  await click('snap-tool')
  await exec('(() => { document.activeElement?.blur(); document.querySelector("video").currentTime = 2; document.querySelector("#timeline-scroll").scrollLeft = 0 })()')
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
  await exec(`(() => {
    const scroll = document.querySelector('#timeline-scroll')
    scroll.scrollLeft = Math.round((scroll.scrollWidth - scroll.clientWidth) * .25)
  })()`)
  await expect('document.querySelector("#zoom-thumb").getBoundingClientRect().x > 210', 'settle the scrollbar thumb after scrolling')
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 0')
  await expect('document.querySelector("#zoom-thumb").style.transform === "translateX(0px)"', 'position the thumb for a partial zoom adjustment')
  const grip = await exec(`(() => {
    const box = document.querySelector('#zoom-thumb .zoom-grip[data-edge=right]').getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })()`)
  const zoomBefore = await exec('Number(document.querySelector("#zoom").value)')
  await mouse('mousePressed', grip.x, grip.y)
  await mouse('mouseMoved', grip.x + 80, grip.y)
  await mouse('mouseReleased', grip.x + 80, grip.y)
  assert(await exec(`Number(document.querySelector("#zoom").value) < ${zoomBefore}`), 'Zoom out by dragging the scrollbar grip')
  // 拖动缩放把柄时把柄跟手
  const gripTrack = await exec(`(() => {
    const grip = document.querySelector('#zoom-thumb .zoom-grip[data-edge=right]').getBoundingClientRect()
    return { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2 }
  })()`)
  await mouse('mousePressed', gripTrack.x, gripTrack.y)
  // 抓住任意一侧时两侧把柄一起加粗，松手后恢复细描边。
  const gripBorders = `(() => {
    const width = edge => parseFloat(getComputedStyle(document.querySelector('#zoom-thumb .zoom-grip[data-edge=' + edge + ']')).borderTopWidth)
    return { left: width('left'), right: width('right'), state: document.querySelector('#zoom-thumb').classList.contains('gripping') }
  })()`
  const grippingState = await exec(gripBorders)
  assert(grippingState.state && grippingState.left >= 2 && grippingState.right >= 2, 'Thicken both zoom grips while dragging one: ' + JSON.stringify(grippingState))
  await mouse('mouseMoved', gripTrack.x - 40, gripTrack.y)
  await mouse('mouseReleased', gripTrack.x - 40, gripTrack.y)
  const gripReleased = await exec(gripBorders)
  assert(!gripReleased.state && gripReleased.left < 2 && gripReleased.right < 2, 'Restore thin zoom grips after release: ' + JSON.stringify(gripReleased))
  const gripAfter = await exec(`(() => {
    const grip = document.querySelector('#zoom-thumb .zoom-grip[data-edge=right]').getBoundingClientRect()
    return grip.left + grip.width / 2
  })()`)
  assert(Math.abs(gripAfter - (gripTrack.x - 40)) <= 3, 'Keep the zoom handle under the pointer while dragging: ' + JSON.stringify({ before: gripTrack.x, after: gripAfter }))
  await exec('document.querySelector("#timeline-scroll").scrollLeft = 0')
  await expect('document.querySelector("#zoom-thumb").getBoundingClientRect().x <= 210', 'settle the scrollbar thumb after resetting the scroll')
  // 缩放条被点过之后，方向键仍然移动播放头，不再平移时间轴。
  const zoomFocusPoint = await exec(`(() => {
    const bar = document.querySelector('#timeline-zoom').getBoundingClientRect()
    return { x: bar.left + bar.width * .35, y: bar.top + bar.height / 2 }
  })()`)
  await mouse('mousePressed', zoomFocusPoint.x, zoomFocusPoint.y)
  await mouse('mouseReleased', zoomFocusPoint.x, zoomFocusPoint.y)
  await exec(`(() => {
    const scroll = document.querySelector('#timeline-scroll')
    const heads = document.querySelector('#track-headings').offsetWidth
    const usable = scroll.clientWidth - heads
    scroll.scrollLeft = Math.max(0, document.querySelector('#playhead').offsetLeft - usable / 2)
  })()`)
  const zoomFocus = await exec(`({ scroll: document.querySelector('#timeline-scroll').scrollLeft, time: document.querySelector('#timecode').value })`)
  await pressShortcut('ArrowRight', 'ArrowRight', 39)
  await delay(200)
  const zoomArrow = await exec(`({ scroll: document.querySelector('#timeline-scroll').scrollLeft, time: document.querySelector('#timecode').value })`)
  assert.notEqual(zoomArrow.time, zoomFocus.time, 'Move the playhead with the arrow keys after clicking the zoom bar')
  assert.equal(zoomArrow.scroll, zoomFocus.scroll, 'Keep the timeline scroll unchanged when arrows move the playhead')
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
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.00"', 'restore the timeline after keyboard seeking')
  await exec('for (const value of ["2", "4", "1"]) { const q = document.querySelector("#quality"); q.value = value; q.dispatchEvent(new Event("change")); const c = document.querySelector("canvas"); if (value === "1" ? !c.hidden : c.width !== 3840 / +value || c.height !== 2160 / +value) throw Error("quality width"); }')
  console.log('PASS switch 4K preview targets 3840x2160, 1920x1080, 960x540')
  // 全屏预览进度条可以拖动，把柄是白底蓝边
  await exec('document.querySelector("#fullscreen-preview").click()')
  await expect('document.querySelector(".monitor").classList.contains("preview-maximized")', 'maximize the preview for the progress bar check')
  const progressBar = await exec(`(() => {
    const input = document.querySelector('#preview-progress')
    const box = input.getBoundingClientRect()
    return { x: box.left + box.width * .2, y: box.top + box.height / 2, end: box.left + box.width * .7 }
  })()`)
  await mouse('mousePressed', progressBar.x, progressBar.y)
  await mouse('mouseMoved', progressBar.end, progressBar.y)
  await mouse('mouseReleased', progressBar.end, progressBar.y)
  await delay(300)
  const progressState = await exec(`({
    value: document.querySelector('#preview-progress').value,
    time: document.querySelector('video').currentTime,
    duration: document.querySelector('video').duration,
    seeking: document.querySelector('video').seeking,
  })`)
  assert(progressState.time > 2, 'Drag the fullscreen progress bar: ' + JSON.stringify(progressState))
  await exec('document.querySelector("#fullscreen-preview").click()')
  await expect('!document.querySelector(".monitor").classList.contains("preview-maximized")', 'leave the fullscreen preview')
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
  await writeFile(join(directory, 'sample.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nVTT 字幕\n')
  picks.unshift('sample.vtt')
  await click('import-subtitles')
  await expect('document.querySelector(".cue")?.textContent === "VTT 字幕"', 'import a WebVTT file')
  await click('undo')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'undo the WebVTT import in one step')
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
  await menuCommand('.cue', '拆分双语…')
  await expect('!document.querySelector("#split-dialog").open && !document.querySelector("#cue-form .discard-draft").hidden && document.querySelector("#status").textContent.includes("先应用或取消")', 'protect pending text when splitting its track')
  await exec('document.querySelector("#cue-form .discard-draft").click()')
  await menuCommand('.cue', '拆分双语…')
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
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.01" && document.querySelectorAll(".caption").length === 1', 'hold a frame inside the original bilingual cue')
  await menuCommand('.cue', '拆分双语…')
  await exec(`(() => {
    const order = document.querySelector('#split-order')
    order.value = 'original'
    order.dispatchEvent(new Event('change'))
  })()`)
  await exec('document.querySelector("#split-dialog button[value=confirm]").click()')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'split bilingual into two tracks')
  assert.deepEqual(await exec('Array.from(document.querySelectorAll(".caption")).map(node => node.textContent)'), ['你好', 'Hello'], 'update the paused preview after splitting')
  await expect('!document.querySelector("#next-review").hidden && document.querySelector("#next-review").textContent === "待校对 2"', 'list two exceptions after splitting')
  await click('export-subtitles')
  await expect('document.querySelector("#export-format").open && !document.querySelector("#export-merge-row").hidden && document.querySelector("#export-merge-summary").textContent.includes("链接字幕")', 'offer merged bilingual export for a linked track')
  await exec('document.querySelector("#export-merge").click()')
  await expect('!document.querySelector("#export-merge-preview").hidden && document.querySelector("#export-merge-preview").textContent.includes("示例")', 'preview merged bilingual lines before exporting')
  saves.unshift('merged.srt')
  await exec('document.querySelector("#export-format button[value=srt]").click()')
  await expect('document.querySelector("#status").textContent.startsWith("已导出 SRT")', 'export merged bilingual SRT')
  assert.match(await readFile(join(directory, 'merged.srt'), 'utf8'), /你好\r?\nHello/, 'merge upper and lower text into two lines')
  await click('menu-find')
  await exec('(() => { const scope = document.getElementById("find-scope"); scope.value = "all"; scope.dispatchEvent(new Event("change")); const query = document.getElementById("find-query"); query.value = "Hello"; query.dispatchEvent(new Event("input")) })()')
  await expect('document.querySelector("#find-summary").textContent.includes("匹配") && !document.querySelector("#find-summary").textContent.includes("没有")', 'find subtitle text across all tracks')
  await click('find-next')
  await expect('document.querySelector("#cue-text").value.includes("Hello") && !document.querySelector("#find-panel").hidden', 'navigate to a cross-track match')
  await exec('document.querySelector("#find-close").click()')
  await menuCommand('.cue', '拆分双语…')
  await expect(`document.querySelector('#split-dialog').open && document.querySelector('#split-dialog button[value=confirm]').disabled &&
    document.querySelector('#split-preview').textContent.includes('已有链接')`, 'prevent a split with no eligible pairs')
  await exec('document.querySelector("#split-dialog button[value=cancel]").click()')
  await expect('!document.querySelector("#open-project").disabled && !document.querySelector("#split-dialog").open && document.querySelectorAll(".track-lane").length === 2', 'keep the current tracks when no pair is eligible')
  await menuCommand('.cue', '链接字幕')
  await click('next-review')
  await expect(`document.querySelector('#cue-text').value === '单行' && document.querySelector('#timecode').value === '00:00:02.05' && document.querySelector('#select-tool').getAttribute('aria-pressed') === 'true'`, 'locate the retained single line without starting a link')
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
  await expect('!document.querySelector("video").seeking && document.querySelector("#timecode").value === "00:00:02.00" && document.querySelector("#timeline-scroll").scrollLeft === 0 && document.querySelectorAll(".caption").length === 2', 'restore the position after navigating review items')
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
  const point = await exec('(() => { const cue = Array.from(document.querySelectorAll(".cue")).find(item => item.textContent.includes("你好")); const r = cue.getBoundingClientRect(); return {x: r.left + 20, y: r.top + 10}; })()')
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
  saves.unshift('track.vtt')
  await chooseExport('vtt')
  await expect('document.querySelector("#status").textContent === "已导出 VTT"', 'export WebVTT from the same track')
  assert.match(await readFile(join(directory, 'track.vtt'), 'utf8'), /^WEBVTT\n\n/)
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
  await expect('document.querySelector("#style-editor").hidden && !document.querySelector("#styles-list").hidden', 'return to the style list after saving')
  await exec('[...document.querySelectorAll(".style-list-item")].find(row => row.title === "Default").querySelector("[aria-label=编辑]").click()')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export the saved opacity bytes')
  assert.match(await readFile(join(directory, 'opacity.ass'), 'utf8'), /Style: Default,Noto Sans SC,56,&H80FFFFFF,&H000000FF,&HFF111111,/)
  await exec(changeStyle)
  await exec("document.querySelector('#style-editor form').requestSubmit()")
  await expect('document.querySelector("#status").textContent === "已保存样式"', 'change RGB on a translucent style')
  await exec('[...document.querySelectorAll(".style-list-item")].find(row => row.title === "Default").querySelector("[aria-label=编辑]").click()')
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
  await expect('document.querySelector("#style-editor").hidden && !document.querySelector("#styles-list").hidden', 'stay on the style list after the last save')
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
  await expect(`(() => {
    const rows = [...document.querySelectorAll('.style-list-item')]
    const defaults = rows.filter(row => row.title === 'Default')
    const notes = rows.filter(row => row.title === 'Notes')
    const names = rows.map(row => row.title.trim().toLowerCase())
    return defaults.length === 1 && notes.length === 1 && !rows.some(row => row.querySelector('.style-list-source')) &&
      new Set(names).size === names.length
  })()`, 'overwrite same-name styles instead of listing duplicates')
  await exec(`(() => {
    [...document.querySelectorAll('.style-list-item')].find(row => row.title === 'Default').querySelector('[aria-label=编辑]').click()
    const name = document.querySelector('#style-editor input[type=text]')
    name.value = 'Notes'
    name.form.requestSubmit()
  })()`)
  await expect('document.querySelector("#status").textContent.includes("全工程唯一")', 'reject duplicate style names after merging')
  await exec(`(() => {
    const name = document.querySelector('#style-editor input[type=text]')
    const size = document.querySelector('#style-editor input[type=number]')
    name.value = 'Default'
    size.value = '64'
    size.form.requestSubmit()
  })()`)
  await expect('document.querySelector("#status").textContent === "已保存样式"', 'edit the merged ASS style')
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export the edited second ASS track')
  const otherExport = await readFile(join(directory, 'other.ass'), 'utf8')
  assert.match(otherExport, /Style: Default,Noto Sans SC,64,/, 'Write the overwritten style into the second track')
  assert.match(otherExport, /Comment retained/)
  await exec("Array.from(document.querySelectorAll('.track-name')).find(button => button.title === 'styles.ass').click()")
  await exec("document.querySelector('#status').textContent = ''")
  await chooseExport('ass')
  await expect('document.querySelector("#status").textContent === "已导出 ASS"', 'export the first ASS track after editing the merged style')
  const firstExport = await readFile(join(directory, 'first.ass'), 'utf8')
  assert.match(firstExport, /Style: Default,Noto Sans SC,64,/, 'Apply the overwritten style to the first track too')
  assert.match(firstExport, /Comment retained/)
  const renameNotes = `(() => {
    Array.from(document.querySelectorAll('.track-name')).find(button => button.title === 'other-styles.ass').click()
    document.querySelector('#style-editor [aria-label=返回样式列表]')?.click()
    Array.from(document.querySelectorAll('.style-list-item')).find(button => button.title === 'Notes').querySelector('[aria-label=编辑]').click()
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
  const renamed = await readFile(join(directory, 'renamed.ass'), 'utf8')
  assert.match(renamed, /Style: Review Notes,Noto Sans SC,48,/)
  assert(renamed.includes('Review Notes}'), 'Rename the inline style override too')
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
    Array.from(document.querySelectorAll('.style-list-item')).find(button => button.title === 'Default').querySelector('[aria-label=编辑]').click()
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
  const recentRow = await exec(`(() => {
    const row = document.querySelector('#recent-list button')
    const style = getComputedStyle(row)
    return { background: style.backgroundColor, height: row.getBoundingClientRect().height, time: row.querySelector('.recent-item-time')?.textContent ?? '' }
  })()`)
  assert.equal(recentRow.background, 'rgba(0, 0, 0, 0)', 'Keep recent rows flat instead of card-like')
  assert(recentRow.height < 60, 'Keep recent rows compact: ' + JSON.stringify(recentRow))
  assert(recentRow.time.length > 0, 'Show when the project was last opened: ' + JSON.stringify(recentRow))
  await exec('document.querySelector("#recent-list button").click()')
  await expect('document.querySelector("#project-change-dialog").open', 'ask before switching to a recent project')
  await exec('document.querySelector("#project-change-dialog button[value=discard]").click()')
  await expect('document.querySelectorAll(".track-lane").length === 4', 'discard temporary edits and reopen recent project')
  assert(await exec('Array.from(document.querySelectorAll(".cue")).some(cue => cue.textContent === "新增 ASS")'))

  // —— 空白视频与文稿打轴 ——
  const scriptFixture = join(directory, 'script.txt')
  await writeFile(scriptFixture, '第一句文稿\n第二句文稿\n第三句文稿\n')
  const bilingualFixture = join(directory, 'script-bilingual.txt')
  await writeFile(bilingualFixture, '第一条原文\n第一条译文\n第二条原文\n第二条译文\n')
  const blankProjectFile = join(directory, 'blank.subx')
  const ms = value => {
    const [hours, minutes, rest] = value.split(':')
    const [seconds, millis] = rest.split('.')
    return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(millis)
  }
  const pressPunch = (type, key) => contents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type, key, code: 'Key' + key.toUpperCase(), windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
  })

  await click('new-project')
  await expect('document.querySelectorAll(".track-lane").length === 2 && !document.querySelector("video").getAttribute("src")', 'start a blank video project')

  // 没有帧索引时，播放头也必须落在标尺最小刻度上。
  const emptyRuler = await exec(`(() => {
    const area = document.querySelector('#timeline-scroll').getBoundingClientRect()
    const heads = document.querySelector('#track-headings').getBoundingClientRect().right
    const ruler = document.querySelector('#ruler').getBoundingClientRect()
    return { x: heads + (area.right - heads) * 0.37, y: ruler.top + 7 }
  })()`)
  await mouse('mousePressed', emptyRuler.x, emptyRuler.y)
  await mouse('mouseReleased', emptyRuler.x, emptyRuler.y)
  await expect(`(() => {
    const [hours, minutes, rest] = document.querySelector('#timecode').value.split(':')
    const [seconds, frames] = rest.split('.')
    const count = ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 30 + Number(frames)
    const scale = Number(document.querySelector('#zoom').value)
    const expected = count * (1000 / 30) * scale / 1000
    return Math.abs(parseFloat(document.querySelector('#playhead').style.left) - expected) < 1
  })()`, 'land the playhead on a 30 fps frame in an empty project')

  await click('blank-video')
  await expect('document.querySelector("#blank-video-dialog").open', 'open the blank video dialog')
  const blankOptions = await exec(`(() => {
    const form = document.querySelector('#blank-video-form')
    const picker = form.querySelector('[data-picker] .picker-button')
    const swatch = form.elements.color.getBoundingClientRect()
    return {
      resolutions: form.elements.resolution.options.length,
      portrait: [...form.elements.resolution.options].filter(option => option.value === '1080x1920').length,
      fps: [...form.elements.fps.options].map(option => option.value),
      picker: picker.textContent,
      swatch: swatch.width,
    }
  })()`)
  assert.equal(blankOptions.resolutions, 45, 'Offer landscape and portrait resolutions across common ratios: ' + JSON.stringify(blankOptions))
  assert.equal(blankOptions.portrait, 1, 'Include the portrait 16:9 resolution')
  assert(blankOptions.fps.includes('23.976') && blankOptions.fps.includes('120'), 'Offer modern frame rates')
  assert(blankOptions.picker.includes('1920 × 1080'), 'Show the default resolution in the picker')
  assert(blankOptions.swatch < 80, 'Keep the color picker a small swatch')
  await exec('document.querySelector("#blank-video-form .picker-button").click()')
  await expect('!document.querySelector("#blank-video-form .picker-list").hidden', 'open the resolution picker')
  await exec(`document.querySelector('#blank-video-form .picker-list button[data-value="1280x720"]').click()`)
  await expect('document.querySelector("#blank-video-form").elements.resolution.value === "1280x720" && document.querySelector("#blank-video-form .picker-button").textContent.includes("1280 × 720")', 'choose a resolution from the picker')
  await exec(`(() => {
    const form = document.querySelector('#blank-video-form')
    form.elements.color.value = '#101820'
    form.elements.resolution.value = '1280x720'
    form.elements.fps.value = '25'
    form.elements.duration.value = '30'
    form.querySelector('button[value=create]').click()
  })()`)
  await expect(`getComputedStyle(document.querySelector('#solid-frame')).backgroundColor === 'rgb(16, 24, 32)' &&
    !document.querySelector('#solid-frame').hidden && document.querySelector('#media-name').textContent.includes('1280×720') &&
    document.querySelector('#media-name').textContent.includes('25 fps')`, 'show the blank video preview')
  await expect('document.querySelector("#play").disabled === false && document.querySelector("#ruler").dataset.frameIndex === "ready"', 'enable playback and frame ticks for the blank video')
  const frameRuler = await exec(`(() => {
    const area = document.querySelector('#timeline-scroll').getBoundingClientRect()
    const heads = document.querySelector('#track-headings').getBoundingClientRect().right
    const ruler = document.querySelector('#ruler').getBoundingClientRect()
    const x = heads + (area.right - heads) * 0.61
    const scale = Number(document.querySelector('#zoom').value)
    return { x, y: ruler.top + 7, frame: Math.round((x - ruler.left) * 1000 / scale / 40) }
  })()`)
  await mouse('mousePressed', frameRuler.x, frameRuler.y)
  await mouse('mouseReleased', frameRuler.x, frameRuler.y)
  await expect(`(() => {
    const [hours, minutes, rest] = document.querySelector('#timecode').value.split(':')
    const [seconds, frames] = rest.split('.')
    return Math.abs(((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 25 + Number(frames) - ${frameRuler.frame}) <= 1
  })()`, 'land the playhead on a video frame boundary')
  await exec('document.querySelector("#play").click()')
  await delay(500)
  await exec('document.querySelector("#play").click()')
  const blankTime = await exec('document.querySelector("#timecode").value')
  assert(/^\d{2}:\d{2}:\d{2}\.\d{2}$/.test(blankTime), 'Show the blank video timecode in frames: ' + blankTime)
  assert.notEqual(blankTime, '00:00:00.00', 'Advance the playhead while the blank video plays')

  await click('compose-video')
  await expect(`document.querySelector('#composition-dialog').open &&
    document.querySelector('#composition-source').textContent.includes('空白视频') &&
    document.querySelector('#composition-info').textContent.includes('1280 × 720')`, 'describe the blank video in the composition dialog')
  await exec('document.querySelector("#composition-cancel").click()')

  saves.unshift('blank.subx')
  await click('save-project')
  await expect('document.querySelector("#status").textContent === "已保存工程"', 'save the blank video project')
  const blankProject = JSON.parse(await readFile(blankProjectFile, 'utf8'))
  assert.equal(blankProject.media.kind, 'solid', 'Persist the blank video as solid media')
  assert.deepEqual([blankProject.media.width, blankProject.media.height, blankProject.media.fps, blankProject.media.duration], [1280, 720, 25, 30000])

  picks.unshift('script.txt')
  await click('import-script')
  await expect('document.querySelector("#script-dialog").open', 'open the script import dialog')
  await exec('document.querySelector("#script-dialog button[value=choose]").click()')
  await expect('document.querySelectorAll("#script-list .script-line").length === 3 && document.querySelector("#script-tab").getAttribute("aria-selected") === "true"', 'import a single-language script')

  // 按住 J 开始第一行，按住 K 无缝接上第二行，松开 K 结束第二行。
  await pressPunch('rawKeyDown', 'j')
  await delay(350)
  await pressPunch('rawKeyDown', 'k')
  await pressPunch('keyUp', 'j')
  await delay(350)
  await pressPunch('keyUp', 'k')
  await expect('document.querySelectorAll(".track-lane:first-child .cue").length === 2 && document.querySelector("#script-progress").textContent.startsWith("2 / 3")', 'punch two lines with alternating J and K')
  const punchTimes = await exec(`[...document.querySelectorAll('.track-lane:first-child .cue')].map(cue => cue.dataset.range)`)
  const [[firstStart, firstEnd], [secondStart, secondEnd]] = punchTimes.map(range => range.split(' – '))
  assert.equal(firstEnd, secondStart, 'Join the next punched line exactly at the previous end: ' + JSON.stringify(punchTimes))
  assert(ms(firstEnd) - ms(firstStart) >= 200 && ms(secondEnd) - ms(secondStart) >= 200, 'Size each punched block by how long the key was held: ' + JSON.stringify(punchTimes))
  assert(await exec('document.querySelector("#status").textContent.startsWith("第 2 行已打轴")'), 'report the punched line')

  await click('save-project')
  await expect('document.querySelector("#status").textContent === "已保存工程"', 'save the punched script project')
  const punchedProject = JSON.parse(await readFile(blankProjectFile, 'utf8'))
  assert.equal(punchedProject.script.lines.length, 3, 'Persist the imported script')
  assert(punchedProject.tracks.some(track => track.cues.some(cue => cue.scriptLine)), 'Persist the script line on each punched cue')

  await click('undo')
  await click('undo')
  await expect('document.querySelectorAll(".track-lane .cue").length === 0 && document.querySelector("#script-progress").textContent.startsWith("0 / 3")', 'undo both punched lines')

  picks.unshift('script-bilingual.txt')
  await click('import-script')
  await exec('document.querySelector("#script-dialog input[name=mode][value=bilingual]").click()')
  await exec('document.querySelector("#script-dialog button[value=choose]").click()')
  await expect('document.querySelectorAll("#script-list .script-line").length === 2', 'group a bilingual script into line pairs')
  await pressPunch('rawKeyDown', 'j')
  await delay(300)
  await pressPunch('keyUp', 'j')
  await expect(`document.querySelectorAll('.track-lane:first-child .cue').length === 1 &&
    document.querySelectorAll('.track-lane:nth-child(2) .cue').length === 1 &&
    document.querySelectorAll('.track-lane .cue svg').length === 2 &&
    document.querySelector('.track-lane:first-child .cue').textContent === '第一条原文' &&
    document.querySelector('.track-lane:nth-child(2) .cue').textContent === '第一条译文'`, 'split a punched bilingual line into two linked tracks')

  picks.unshift('blank.subx')
  await click('open-project')
  await exec(`(() => { const dialog = document.querySelector('#project-change-dialog'); if (dialog.open) dialog.querySelector('button[value=discard]').click() })()`)
  await expect(`document.querySelector('#media-name').textContent.includes('空白视频') &&
    document.querySelectorAll('#script-list .script-line').length === 3 &&
    document.querySelectorAll('.track-lane:first-child .cue').length === 2`, 'reopen the blank video project with its script and punched cues')

  await click('new-project')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'start the independent SRT workflow')
  const alignmentTop = join(directory, 'alignment-top.srt')
  await writeFile(alignmentTop, Buffer.from('\ufeff' + await readFile(alignmentTop, 'utf8'), 'utf16le').swap16())
  await click('import-subtitles')
  await expect('document.querySelectorAll(".track-lane").length === 1', 'import independent bottom SRT')
  await click('import-subtitles')
  await expect('document.querySelectorAll(".track-lane").length === 2', 'import UTF-16BE independent top SRT')
  assert(await exec('!document.querySelector(".cue").title.includes(" – ") && document.querySelector(".cue").dataset.range.includes(" – ")'), 'Show only the cue text in the hover tooltip')
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
  // 隐藏轨道的字幕块仍要可辨认，透明度从 .3 提高到 .55。
  assert.equal(await exec('getComputedStyle(document.querySelector(".track-lane:last-child .cue")).opacity'), '0.55', 'Dim the subtitle blocks of a hidden track')
  const hiddenEdge = await startEdge()
  await expect(`document.querySelector(${JSON.stringify(topCue)}).dataset.range.includes('00:00:01.170') && document.querySelector('#snap-guide')?.hidden !== false`, 'ignore a hidden track while snapping an edge')
  assert(await exec(`parseFloat(document.querySelector(${JSON.stringify(topCue)}).style.width) > 1`), 'Keep the dragged block at its real width instead of collapsing to 1px')
  await mouse('mouseReleased', hiddenEdge.x + hiddenEdge.delta, hiddenEdge.y)
  await click('undo')
  await toggleBottom()
  const visibleEdge = await startEdge()
  await expect(`document.querySelector(${JSON.stringify(topCue)}).dataset.range.includes('00:00:01.200') &&
    document.querySelector('#snap-guide')?.hidden === false && document.querySelector('#snap-guide').style.left === document.querySelector(${JSON.stringify(bottomCue)}).style.left`, 'align to a visible cue and show the snap guide')
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await mouse('mouseReleased', visibleEdge.x + visibleEdge.delta, visibleEdge.y)
  await expect(`document.querySelector(${JSON.stringify(topCue)}).dataset.range.includes('00:00:01.000') && document.querySelector('#snap-guide').hidden`, 'cancel a snapped trim and clear the guide')
  await toggleBottom()
  await exec(`(() => {
    const ruler = document.querySelector('#ruler')
    for (const shiftKey of [true, false, false]) {
      ruler.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey, bubbles: true, cancelable: true }))
    }
  })()`)
  await expect('document.querySelector("#timecode").value === "00:00:01.06"', 'set the playhead as a snap target')
  const playheadEdge = await startEdge()
  await expect(`document.querySelector(${JSON.stringify(topCue)}).dataset.range.includes('00:00:01.200') &&
    !document.querySelector('#snap-guide').hidden && document.querySelector('#snap-guide').style.left === document.querySelector('#playhead').style.left`, 'snap to the playhead with the other track hidden')
  await mouse('mouseReleased', playheadEdge.x + playheadEdge.delta, playheadEdge.y)
  await expect('document.querySelector("#cue-start").value === "00:00:01.200" && document.querySelector("#snap-guide").hidden', 'commit exact snapped time and clear the guide')
  await click('undo')
  await toggleBottom()
  await click('snap-tool')
  await menuCommand('.cue', '链接字幕')
  await pressCue(topCue)
  await pressCue(extraCue)
  await expect('document.querySelector("#status").textContent === "请选择另一条轨道上的字幕"', 'reject a same-track pair')
  await exec('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
  await expect('document.querySelector("#status").textContent === "已取消配对"', 'cancel a pending manual pair')
  await pressCue(bottomCue)
  await expect('document.querySelector("#status").textContent.includes("选择另一条轨道")', 'start a new pair after cancelling')
  await pressCue(topCue)
  await expect('document.querySelector("#status").textContent === "已建立链接" && Boolean(document.querySelector(".cue.paired"))', 'link offset cues on two tracks')

  const timesOf = async selector => await exec('document.querySelector(' + JSON.stringify(selector) + ').dataset.range')
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
  await menuCommand('.cue', '链接字幕')
  await pressCue(topCue)
  await expect('document.querySelector("#status").textContent === "已解除链接"', 'unlink the manual pair')
  await click('select-tool')
  await moveTopHalfSecond()
  await expect('document.querySelector("#status").textContent === "已移动字幕"', 'move only the selected cue after unlinking')
  await assertPairTimes('00:00:02.000 – 00:00:04.000', bottomShifted)
  assert.equal(await timesOf(extraCue), '00:00:04.000 – 00:00:04.800')
  await menuCommand(topCue, '复制')
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
  assert.equal(await exec('getComputedStyle(document.querySelector(".cue:not(.playing):not(.selected)")).borderTopColor'), 'rgb(68, 45, 15)', 'draw a dark border around unselected cue blocks')
  const narrowHeading = await exec('document.querySelector("#track-headings").offsetWidth')
  assert(narrowHeading >= 96 && narrowHeading <= 128, 'Use a narrower default track header width')
  await exec(`(() => {
    const handle = document.querySelector('#heading-resizer')
    handle.focus()
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })()`)
  await expect(`document.querySelector('#track-headings').offsetWidth === ${narrowHeading + 8}`, 'widen the track header area from the keyboard')
  await exec('document.querySelector(".track-heading:last-child .lock-button").click()')
  await expect('document.querySelector(".track-heading:last-child .lock-button").getAttribute("aria-pressed") === "true" && document.querySelector(".track-lane:last-child").classList.contains("locked-track") && document.querySelector(".track-lane:last-child .cue.locked") && document.querySelector("#export-subtitles").disabled', 'lock a track and disable its cues and exports')
  assert(await exec(`getComputedStyle(document.querySelector('.track-lane:last-child'), '::after').backgroundImage.includes('repeating-linear-gradient')`), 'Stripe a locked track')
  assert(await exec('document.querySelector(".track-heading:last-child .visibility-button").disabled'), 'Disable the visibility toggle while a track is locked')
  const lockedName = await exec(`(() => {
    const box = document.querySelector('.track-heading:last-child .track-name').getBoundingClientRect()
    return { x: box.left + 8, y: box.top + box.height / 2 }
  })()`)
  for (const count of [1, 2]) {
    await mouse('mousePressed', lockedName.x, lockedName.y, count)
    await mouse('mouseReleased', lockedName.x, lockedName.y, count)
  }
  await expect('!document.querySelector(".track-name-input") && document.querySelector("#status").textContent.includes("已锁定")', 'Ignore renaming a locked track')
  const lockedCue = await exec(`(() => {
    const box = document.querySelector('.track-lane:last-child .cue').getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + 10 }
  })()`)
  await mouse('mousePressed', lockedCue.x, lockedCue.y)
  await mouse('mouseReleased', lockedCue.x, lockedCue.y)
  await expect('document.querySelectorAll(".cue.selected").length === 0 && document.querySelector("#status").textContent.includes("已锁定")', 'ignore clicks on a locked track')
  await exec('document.querySelector(".track-heading:last-child .lock-button").click()')
  await expect('document.querySelector(".track-heading:last-child .lock-button").getAttribute("aria-pressed") === "false" && !document.querySelector(".track-lane:last-child").classList.contains("locked-track") && !document.querySelector("#export-subtitles").disabled', 'unlock a track and re-enable its cues and exports')
  const marquee = await exec(`(() => {
    const area = document.querySelector('#timeline-scroll').getBoundingClientRect()
    const heads = document.querySelector('#track-headings').getBoundingClientRect().right
    const lanes = document.querySelector('#track-lanes').getBoundingClientRect()
    const firstLane = document.querySelector('.track-lane').getBoundingClientRect()
    const startX = area.right - 20
    const startY = Math.min(lanes.bottom + 12, area.bottom - 8)
    const endX = heads + 12
    const endY = firstLane.top + 6
    const expected = [...document.querySelectorAll('.cue')].filter(cue => {
      const box = cue.getBoundingClientRect()
      return box.right > endX && box.left < startX && box.bottom > endY && box.top < startY
    }).length
    return { startX, startY, endX, endY, expected }
  })()`)
  await mouse('mousePressed', marquee.startX, marquee.startY)
  await mouse('mouseMoved', marquee.endX, marquee.endY)
  await mouse('mouseReleased', marquee.endX, marquee.endY)
  await expect(`document.querySelectorAll('.cue.selected').length === ${marquee.expected} && ${marquee.expected} > 1`, 'select subtitle blocks by dragging in an empty timeline area')
  await pressShortcut('v', 'KeyV', 86, process.platform === 'darwin' ? 4 : 2)
  await expect(`document.querySelector('.track-lane:last-child .cue.selected').dataset.range === '00:00:01.200 – 00:00:03.200'`, 'paste at the playhead into the selected track with the original duration')
  await menuCommand('.cue.selected', '删除')
  await expect('document.querySelectorAll(".track-lane:last-child .cue").length === 1', 'delete a subtitle using its context menu')
  await click('undo')
  await expect('document.querySelectorAll(".track-lane:last-child .cue").length === 2', 'undo context-menu deletion')
  await click('undo')
  await exec('document.querySelector(".track-heading:first-child .track-name").click()')
  await menuCommand('#ruler', '选中当前轨道全部字幕块')
  await expect('document.querySelectorAll(".track-lane:first-child .cue.selected").length === 2', 'select every subtitle from the active track')
  // 多选裁剪：拖动其中一条的左边，所有选中块按同一方向、同一时长调整。
  const multiTrimPoint = await exec(`(() => {
    const box = document.querySelector(${JSON.stringify(topCue)}).getBoundingClientRect()
    return { x: Math.ceil(box.left) + 3, y: box.top + 8, delta: .2 * Number(document.querySelector('#zoom').value) }
  })()`)
  await mouse('mousePressed', multiTrimPoint.x, multiTrimPoint.y)
  await mouse('mouseMoved', multiTrimPoint.x + multiTrimPoint.delta, multiTrimPoint.y)
  await delay(200)
  await mouse('mouseReleased', multiTrimPoint.x + multiTrimPoint.delta, multiTrimPoint.y)
  await expect('document.querySelector("#status").textContent === "已调整 2 条字幕边界"', 'trim every selected cue together')
  assert.equal(await timesOf(topCue), '00:00:02.200 – 00:00:04.000')
  assert.equal(await timesOf(extraCue), '00:00:04.200 – 00:00:04.800')
  await click('undo')
  assert.equal(await timesOf(topCue), '00:00:02.000 – 00:00:04.000')
  await menuCommand(topCue, '绑定')
  await expect('document.querySelectorAll(".cue.bound").length === 2 && document.querySelectorAll(".cue-binding-dot").length === 2', 'mark bound cues with a dot')
  // 直接拖动绑定块（不先点选）也要整组移动。
  const boundEmpty = await exec(`(() => { const lane = document.querySelector('.track-lane:first-child'); const box = lane.getBoundingClientRect(); return { x: box.left + 6, y: box.top + 8 } })()`)
  await mouse('mousePressed', boundEmpty.x, boundEmpty.y)
  await mouse('mouseReleased', boundEmpty.x, boundEmpty.y)
  await expect('document.querySelectorAll(".cue.selected").length === 0', 'deselect before dragging a bound cue directly')
  const boundPoint = await exec(`(() => { const box = document.querySelector(${JSON.stringify(extraCue)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2, shift: Number(document.querySelector('#zoom').value) / 2 } })()`)
  await mouse('mousePressed', boundPoint.x, boundPoint.y)
  await mouse('mouseMoved', boundPoint.x + boundPoint.shift, boundPoint.y)
  await mouse('mouseReleased', boundPoint.x + boundPoint.shift, boundPoint.y)
  await expect('document.querySelector("#status").textContent === "已移动成组字幕"', 'move a bound group when dragging one block directly')
  assert.equal(await timesOf(topCue), '00:00:02.500 – 00:00:04.500')
  assert.equal(await timesOf(extraCue), '00:00:04.500 – 00:00:05.300')
  await click('undo')
  await exec(`document.querySelector(${JSON.stringify(extraCue)}).click()`)
  await expect('document.querySelectorAll(".cue.selected").length === 2', 'select every cue bound to the clicked block')
  await moveTopHalfSecond()
  await expect('document.querySelector("#status").textContent === "已移动成组字幕"', 'move a bound group together')
  assert.equal(await timesOf(topCue), '00:00:02.500 – 00:00:04.500')
  assert.equal(await timesOf(extraCue), '00:00:04.500 – 00:00:05.300')
  await click('undo')
  await menuCommand(topCue, '解除绑定')
  await expect('document.querySelectorAll(".cue.bound").length === 0', 'remove binding dots after unbinding')
  await menuCommand(topCue, '清空')
  await expect(`document.querySelector(${JSON.stringify(topCue)}).textContent === ''`, 'clear cue text from the context menu')
  await click('undo')
  await menuCommand(topCue, '设置样式')
  await expect('document.querySelector("#cue-style-menu").matches(":popover-open") && document.querySelectorAll("#cue-style-menu button").length >= 1', 'list project styles from the context menu')
  await exec('document.querySelector("#cue-style-menu button").click()')
  await expect('document.querySelector("#status").textContent === "已设置字幕样式"', 'apply a style to the selected cues')
  await moveTopHalfSecond()
  await expect('document.querySelector("#status").textContent === "已移动成组字幕"', 'move the selected subtitles in a single group')
  assert.equal(await timesOf(topCue), '00:00:02.500 – 00:00:04.500')
  assert.equal(await timesOf(extraCue), '00:00:04.500 – 00:00:05.300')
  await click('undo')
  assert.equal(await timesOf(topCue), '00:00:02.000 – 00:00:04.000')
  assert.equal(await timesOf(extraCue), '00:00:04.000 – 00:00:04.800')
  // 快捷键：全选、复制、粘贴、删除
  const modifier = process.platform === 'darwin' ? 4 : 2
  await pressShortcut('a', 'KeyA', 65, modifier)
  await expect('document.querySelectorAll(".cue.selected").length === 2', 'select all cues in the track with the keyboard')
  await pressShortcut('c', 'KeyC', 67, modifier)
  await expect('document.querySelector("#status").textContent.includes("已复制")', 'copy the selection with the keyboard')
  await pressShortcut('v', 'KeyV', 86, modifier)
  await expect('document.querySelectorAll(".track-lane:first-child .cue").length === 4', 'paste the copied cues with the keyboard')
  await pressShortcut('z', 'KeyZ', 90, modifier)
  await expect('document.querySelectorAll(".track-lane:first-child .cue").length === 2', 'undo the keyboard paste with the shortcut')
  await pressShortcut('a', 'KeyA', 65, modifier)
  await exec('document.querySelector("#timeline-delete").click()')
  await expect('document.querySelectorAll(".track-lane:first-child .cue").length === 0', 'delete the selected cues from the timeline toolbar')
  await click('undo')
  await expect('document.querySelectorAll(".track-lane:first-child .cue").length === 2', 'undo the toolbar deletion')
  await pressShortcut('a', 'KeyA', 65, modifier)
  await pressShortcut('Delete', 'Delete', 46)
  await expect('document.querySelectorAll(".track-lane:first-child .cue").length === 0', 'delete the selected cues with the keyboard')
  await click('undo')
  await expect('document.querySelectorAll(".track-lane:first-child .cue").length === 2', 'undo the keyboard deletion')
  const emptyClick = await exec(`(() => {
    const area = document.querySelector('#timeline-scroll').getBoundingClientRect()
    const lanes = document.querySelector('#track-lanes').getBoundingClientRect()
    return { x: area.left + 220, y: Math.min(lanes.bottom + 12, area.bottom - 8) }
  })()`)
  await mouse('mousePressed', emptyClick.x, emptyClick.y)
  await mouse('mouseReleased', emptyClick.x, emptyClick.y)
  await expect('document.querySelectorAll(".cue.selected").length === 0', 'deselect subtitles by clicking an empty timeline area')
  await expect('document.querySelectorAll(".cue.selected").length === 0', 'deselect subtitles by clicking an empty timeline area')
  const renamePoint = await exec(`(() => {
    const box = document.querySelector('.track-heading:first-child .track-name').getBoundingClientRect()
    return { x: box.left + 8, y: box.top + box.height / 2 }
  })()`)
  for (const count of [1, 2]) {
    await mouse('mousePressed', renamePoint.x, renamePoint.y, count)
    await mouse('mouseReleased', renamePoint.x, renamePoint.y, count)
  }
  await expect('document.activeElement?.classList.contains("track-name-input")', 'start renaming a track by double-clicking its name')
  await exec(`(() => {
    const input = document.activeElement
    input.value = '中文轨'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await expect('document.querySelector(".track-heading:first-child .track-name").textContent === "中文轨"', 'rename a track')
  await click('save-project')
  await expect('document.querySelector("#status").textContent === "已保存工程"', 'save the independent SRT project')
  const alignment = JSON.parse(await readFile(join(directory, 'alignment.subx'), 'utf8'))
  assert.deepEqual(alignment.links, [])
  assert.equal(alignment.tracks[1].cues[0].start, 1700)
  assert.equal(alignment.tracks[0].label, '中文轨', 'Persist the renamed track')

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
  // 密集缩放下字幕块按真实时长绘制，块之间互不遮挡；播放头可以吸附到块边缘。
  picks.unshift('dense.srt')
  await choose('new-project', 'discard')
  await click('import-subtitles')
  await expect('document.querySelectorAll(".cue").length === 40', 'import a dense subtitle track')
  await delay(200)
  await exec(`(() => {
    const zoom = document.querySelector('#zoom')
    zoom.value = zoom.min
    zoom.dispatchEvent(new Event('input'))
    document.querySelector('#timeline-scroll').scrollLeft = 0
  })()`)
  await delay(300)
  const denseLayout = await exec(`(() => {
    const blocks = [...document.querySelectorAll('.cue')].map(block => {
      const box = block.getBoundingClientRect()
      return { left: box.left, right: box.right, dense: block.classList.contains('dense'), width: box.width }
    }).sort((left, right) => left.left - right.left)
    let overlaps = 0
    for (let index = 0; index < blocks.length - 1; index++) {
      if (blocks[index + 1].left < blocks[index].right - .5) overlaps++
    }
    return { count: blocks.length, dense: blocks.filter(block => block.dense).length, overlaps, maxWidth: Math.max(...blocks.map(block => block.width)) }
  })()`)
  assert(denseLayout.count === 40 && denseLayout.dense === 40 && denseLayout.overlaps === 0 && denseLayout.maxWidth < 20,
    'Draw dense cues at their true width without covering the next block: ' + JSON.stringify(denseLayout))
  if (await exec('document.querySelector("#snap-tool").getAttribute("aria-pressed") === "false"')) await click('snap-tool')
  const denseEdge = await exec(`(() => {
    const ruler = document.querySelector('#ruler').getBoundingClientRect()
    const scale = Number(document.querySelector('#zoom').value)
    return { x: ruler.left + scale + 5, y: ruler.top + 8 }
  })()`)
  await mouse('mousePressed', denseEdge.x, denseEdge.y)
  await delay(150)
  const denseSnap = await exec(`(() => ({
    time: document.querySelector('#timecode').value,
    guide: !document.querySelector('#snap-guide').hidden,
  }))()`)
  await mouse('mouseReleased', denseEdge.x, denseEdge.y)
  assert.equal(denseSnap.time, '00:00:01.00', 'Snap the playhead to a dense cue edge: ' + JSON.stringify(denseSnap))
  assert(denseSnap.guide, 'Show the snap guide while the playhead is magnetised')
  await expect('document.querySelector("#snap-guide").hidden', 'Clear the snap guide after releasing the playhead')
  // 长工程：拖动缩放把柄必须能到达和滚轮相同的最小 / 最大倍率。
  picks.unshift('long.srt')
  await choose('new-project', 'discard')
  await click('import-subtitles')
  await expect('document.querySelectorAll(".cue").length === 1', 'import a long subtitle timeline')
  await delay(200)
  await exec(`(() => {
    const zoom = document.querySelector('#zoom')
    zoom.value = zoom.min
    zoom.dispatchEvent(new Event('input'))
    document.querySelector('#timeline-scroll').scrollLeft = 0
  })()`)
  await delay(300)
  const longFit = await exec(`(() => {
    const ruler = document.querySelector('#ruler').getBoundingClientRect()
    const scroll = document.querySelector('#timeline-scroll')
    const usable = scroll.clientWidth - document.querySelector('#track-headings').offsetWidth
    return { x: ruler.left + usable / 2, y: ruler.top + 8 }
  })()`)
  await mouse('mousePressed', longFit.x, longFit.y)
  await mouse('mouseReleased', longFit.x, longFit.y)
  await delay(300)
  await exec(`(() => {
    const zoom = document.querySelector('#zoom')
    zoom.value = zoom.min
    zoom.dispatchEvent(new Event('input'))
    document.querySelector('#timeline-scroll').scrollLeft = 0
  })()`)
  await delay(300)
  const gripGeometry = await exec(`(() => {
    const grip = document.querySelector('#zoom-thumb .zoom-grip[data-edge=right]').getBoundingClientRect()
    const bar = document.querySelector('#timeline-zoom').getBoundingClientRect()
    return { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2, left: bar.left - 30, right: bar.right + 30 }
  })()`)
  await mouse('mousePressed', gripGeometry.x, gripGeometry.y)
  const gripping = await exec(`(() => {
    const width = edge => parseFloat(getComputedStyle(document.querySelector('#zoom-thumb .zoom-grip[data-edge=' + edge + ']')).borderTopWidth)
    return { left: width('left'), right: width('right'), state: document.querySelector('#zoom-thumb').classList.contains('gripping') }
  })()`)
  assert(gripping.state && gripping.left >= 2 && gripping.right >= 2, 'Thicken both zoom grips while dragging one: ' + JSON.stringify(gripping))
  for (let step = 1; step <= 8; step++) {
    await mouse('mouseMoved', gripGeometry.x + (gripGeometry.left - gripGeometry.x) * step / 8, gripGeometry.y)
    await delay(50)
  }
  await mouse('mouseReleased', gripGeometry.left, gripGeometry.y)
  await delay(300)
  const gripMax = await exec('(() => ({ value: +document.querySelector("#zoom").value, max: +document.querySelector("#zoom").max }))()')
  assert(gripMax.value >= gripMax.max - 1, 'Reach the wheel maximum zoom by dragging the grip: ' + JSON.stringify(gripMax))
  const released = await exec(`(() => {
    const width = edge => parseFloat(getComputedStyle(document.querySelector('#zoom-thumb .zoom-grip[data-edge=' + edge + ']')).borderTopWidth)
    return { left: width('left'), right: width('right'), state: document.querySelector('#zoom-thumb').classList.contains('gripping') }
  })()`)
  assert(!released.state && released.left < 2 && released.right < 2, 'Restore thin zoom grips after release: ' + JSON.stringify(released))
  const gripOut = await exec(`(() => {
    const grip = document.querySelector('#zoom-thumb .zoom-grip[data-edge=right]').getBoundingClientRect()
    const bar = document.querySelector('#timeline-zoom').getBoundingClientRect()
    return { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2, target: bar.right + 30 }
  })()`)
  await mouse('mousePressed', gripOut.x, gripOut.y)
  for (let step = 1; step <= 8; step++) {
    await mouse('mouseMoved', gripOut.x + (gripOut.target - gripOut.x) * step / 8, gripOut.y)
    await delay(50)
  }
  await mouse('mouseReleased', gripOut.target, gripOut.y)
  await delay(300)
  const gripMin = await exec('(() => ({ value: +document.querySelector("#zoom").value, min: +document.querySelector("#zoom").min }))()')
  assert(gripMin.value <= gripMin.min + .5, 'Return to the wheel minimum zoom by dragging the grip: ' + JSON.stringify(gripMin))
  window.off('closed', unexpectedClose)
}
