import assert from 'node:assert/strict'
import test from 'node:test'

import { newStyle, setField } from '../src/core/ass.mjs'
import { createAssPreview } from '../src/renderer/ass-preview.mjs'

function fakeCanvas() {
  const context = { clearRect() {} }
  return {
    className: '',
    dataset: {},
    hidden: false,
    style: {},
    width: 0,
    height: 0,
    getContext: () => context,
    remove() {},
  }
}

function installDom(windowOverrides) {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const canvas = fakeCanvas()
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas')
      return canvas
    },
  }
  globalThis.window = windowOverrides
  return {
    canvas,
    restore() {
      globalThis.window = previousWindow
      globalThis.document = previousDocument
    },
  }
}

test('falls back to text when the ASS renderer cannot initialize', async () => {
  const failures = []
  let redraws = 0
  const dom = installDom({
    queryLocalFonts: async () => [],
    SubtitlesOctopus: class {
      constructor() {
        throw Error('worker unavailable')
      }
    },
  })

  try {
    const preview = createAssPreview(
      { append() {}, clientWidth: 640, clientHeight: 360 },
      message => failures.push(message),
      () => { redraws++ },
    )
    preview.sync([{ track: { id: 'track-1', cues: [] }, styles: [], fade: null }])
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(dom.canvas.dataset.ready, 'false')
    assert.equal(dom.canvas.hidden, true)
    assert.equal(preview.pending('track-1'), false)
    assert.equal(preview.ready('track-1'), false)
    assert.deepEqual(failures, ['无法初始化 ASS 渲染器。worker unavailable'])
    assert.equal(redraws, 1)
  } finally {
    dom.restore()
  }
})

test('releases fonts once and never disposes a failed renderer twice', async () => {
  const failures = []
  const created = []
  const revoked = []
  const instances = []
  let redraws = 0
  const font = newStyle('测试样式')
  setField(font.fields, 'Fontname', 'Test Font')
  const worker = {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
  }
  const dom = installDom({
    queryLocalFonts: async () => [{
      family: 'Test Font',
      fullName: 'Test Font',
      postscriptName: 'TestFont',
      blob: async () => new Blob(['font']),
    }],
    SubtitlesOctopus: class {
      constructor(options) {
        this.options = options
        this.worker = worker
        this.disposeCalls = 0
        instances.push(this)
      }

      dispose() {
        this.disposeCalls++
      }
    },
  })
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = () => {
    const url = 'blob:subx-font-' + created.length
    created.push(url)
    return url
  }
  URL.revokeObjectURL = url => { revoked.push(url) }

  try {
    const preview = createAssPreview(
      { append() {}, clientWidth: 640, clientHeight: 360 },
      message => failures.push(message),
      () => { redraws++ },
    )
    preview.sync([{
      track: { id: 'track-1', cues: [{ id: 'cue-1', start: 0, end: 1000, text: '测试', style: font.id }] },
      styles: [font],
      fade: null,
    }])
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(instances.length, 1)
    assert.equal(created.length, 1)
    assert.deepEqual(instances[0].options.fonts, [created[0]])

    instances[0].options.onError()
    assert.equal(instances[0].disposeCalls, 0)
    assert.deepEqual(revoked, created.slice(0, 1))
    assert.equal(dom.canvas.dataset.ready, 'false')
    assert.equal(dom.canvas.hidden, true)
    assert.deepEqual(failures, ['ASS 渲染器未能启动，已改用基础文本预览。'])
    assert.equal(redraws, 1)
  } finally {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    dom.restore()
  }
})
