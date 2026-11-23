import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron'
import { constants, createReadStream } from 'node:fs'
import { access, chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeStyleNames, validateProject } from '../core/project.mjs'
import { bundledEncoders, encodeVideo, findEncoder, readFrameTimes, readWaveform, validateComposition } from './video-export.mjs'

const entry = 'subx://app/renderer/index.html'
const appFiles = new Set([
  '/renderer/index.html', '/renderer/workspace.css', '/renderer/workspace.mjs',
  '/renderer/composition.mjs', '/renderer/ass-preview.mjs', '/assets/NotoSansSC.ttf', '/assets/SubXIcon.png', '/assets/textLOGO.png', '/assets/about-qr.svg',
  '/core/project.mjs', '/core/srt.mjs', '/core/ass.mjs', '/core/frame-grid.mjs', '/core/text.mjs', '/core/merge.mjs', '/core/qc.mjs', '/core/text-tools.mjs', '/core/vtt.mjs',
])
const iconFiles = ["new", "folder", "recent", "save", "copy", "import", "export", "film", "monitor", "sliders", "style", "plus", "play", "pause", "undo", "redo", "track", "cue", "split", "select", "link", "snap", "eye", "eye-off", "info", "arrow", "pencil", "back", "trash", "power", "check", "keyboard", "external", "close", "lock", "expand", "collapse", "razor", "blade", "select-forward", "select-backward", "trim-start", "trim-end", "marker", "remove-track", "wave-symmetric", "wave-asymmetric", "wave-off", "unlock"].map(name => '/assets/icons/' + name + '.png')
for (const path of iconFiles) appFiles.add(path)
const require = createRequire(import.meta.url)
const libass = dirname(require.resolve('@jellyfin/libass-wasm'))
const libassFiles = new Set([
  'subtitles-octopus.js', 'subtitles-octopus-worker.js', 'subtitles-octopus-worker-legacy.js',
  'subtitles-octopus-worker.wasm', 'default.woff2',
])
const fileTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript'], ['.mjs', 'application/javascript'],
  ['.wasm', 'application/wasm'], ['.ttf', 'font/ttf'], ['.woff2', 'font/woff2'], ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
])
const mediaTypes = new Map([
  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'], ['.mkv', 'video/x-matroska'],
])
const media = new Map()
const activeMedia = new WeakMap()
const pendingMedia = new WeakMap()
const mediaSessions = new WeakMap()
const pendingProjectSaves = new Map()
const closeAllowedWindows = new WeakSet()
let quitRequested = false
const compositions = new Map()
const waveformRequests = new WeakMap()
const frameRequests = new WeakMap()
let quitAfterSave = false

async function finishProjectSave(window, id) {
  const pending = pendingProjectSaves.get(window)
  if (!pending || (id !== undefined && pending.id !== id)) return false
  await pending.write.catch(() => {})
  if (pendingProjectSaves.get(window) !== pending) return false
  pendingProjectSaves.delete(window)
  const closing = quitAfterSave || pending.closeRequested
  if (quitAfterSave && !pendingProjectSaves.size) {
    quitAfterSave = false
    app.quit()
  } else if (!quitAfterSave && pending.closeRequested && !window.isDestroyed()) {
    window.close()
  }
  return closing
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'subx', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'subx-media', privileges: { standard: true, secure: true, stream: true } },
])

async function streamMedia(request) {
  const url = new URL(request.url)
  const file = url.hostname === 'video' && media.get(url.pathname.slice(1))
  if (!file) return new Response(null, { status: 404 })
  try {
    const { size } = await stat(file)
    if (!size) return new Response(null, { status: 404 })
    const range = request.headers.get('range')
    let start = 0
    let end = size - 1
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Type': mediaTypes.get(extname(file).toLowerCase()),
    }
    if (range) {
      const bits = range.match(/^bytes=(\d*)-(\d*)$/)
      if (bits?.[1]) {
        start = Number(bits[1])
        end = bits[2] ? Math.min(Number(bits[2]), end) : end
      } else if (bits?.[2]) {
        start = Math.max(0, size - Number(bits[2]))
      }
      if (!bits || !bits[1] && !bits[2] || start >= size || end < start) {
        return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } })
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
    }
    headers['Content-Length'] = String(end - start + 1)
    const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file, { start, end }))
    return new Response(body, { headers, status: range ? 206 : 200 })
  } catch {
    return new Response(null, { status: 404 })
  }
}

function decodeText(contents, file, encoding = 'utf-8') {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(contents)
    if (!text.includes('\0')) return text
  } catch {
    // Report malformed bytes and unsupported encodings with the same recovery step.
  }
  throw new Error('无法解码 ' + basename(file) + '，请另存为 UTF-8 后重试')
}

async function readText(file) {
  return decodeText(await readFile(file), file)
}

const digest = data => createHash('sha256').update(data).digest('hex')

async function writeAtomically(file, text, { projectFile = false, previousDigest } = {}) {
  const temporary = join(dirname(file), '.subx-' + randomUUID() + '.tmp')
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', ...(projectFile && { mode: 0o600 }) })
    if (projectFile) {
      const destination = await lstat(file).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (destination) {
        if (!destination.isFile() || !(destination.mode & 0o222)) {
          throw new Error('目标工程文件不可写，请使用「另存为」选择其他文件。')
        }
        await access(file, constants.W_OK)
        if (process.platform !== 'win32') await chmod(temporary, destination.mode & 0o777)
      }
    }
    if (previousDigest) {
      const disk = await readFile(file).catch(error => {
        if (error.code === 'ENOENT') throw new Error('原工程文件已移动或删除，请使用「另存为」。')
        throw error
      })
      if (digest(disk) !== previousDigest) {
        throw new Error('磁盘上的工程已被修改，请使用「另存为」选择其他文件。')
      }
    }
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

function bind(name, callback) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.senderFrame?.url !== entry || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('无法确认应用窗口')
    }
    return callback(BrowserWindow.fromWebContents(event.sender), ...args)
  })
}

async function selectFile(window, name, extensions) {
  const result = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    filters: [{ name, extensions }],
  })
  return result.filePaths[0]
}

async function mediaReference(file, window, session) {
  if (!file || !mediaTypes.has(extname(file).toLowerCase())) return null
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return null
  if (!await access(file, constants.R_OK).then(() => true, () => false)) return null
  if (window.isDestroyed() || mediaSessions.get(window) !== session) return null
  const token = randomUUID()
  media.set(token, file)
  return { file, name: basename(file), url: 'subx-media://video/' + token, token }
}

function releaseMedia(references, window) {
  media.delete(references.get(window))
  references.delete(window)
}

function setActiveMedia(window, token) {
  waveformRequests.get(window)?.abort()
  frameRequests.get(window)?.abort()
  releaseMedia(activeMedia, window)
  if (token) activeMedia.set(window, token)
}

// 访达双击 .subx 时先排队，等渲染进程就绪再交给它打开。
const pendingOpenPaths = []
function openPathFromSystem(file) {
  if (!file || !/\.subx$/i.test(file)) return
  const [window] = BrowserWindow.getAllWindows()
  if (window && !window.webContents.isLoadingMainFrame()) window.webContents.send('app:open-path', file)
  else pendingOpenPaths.push(file)
}
app.on('open-file', (event, file) => {
  event.preventDefault()
  openPathFromSystem(file)
})
// 命令行参数里带的工程路径：Windows 文件关联和终端启动都会走这里。
const argvProject = process.argv.slice(1).find(argument => /\.subx$/i.test(argument))
if (argvProject) pendingOpenPaths.push(argvProject)

function createWindow() {
  const window = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 950,
    minHeight: 660,
    backgroundColor: '#191919',
    title: 'SubX',
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 14 },
    }),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (process.platform === 'darwin') {
    const applicationMenu = [{ label: 'SubX', submenu: [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }] }]
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu))
  }
  const { session } = window.webContents
  const canReadFonts = (contents, permission, details) => permission === 'local-fonts' &&
    contents?.getURL() === entry && details.isMainFrame && details.requestingUrl === entry
  session.setPermissionCheckHandler((contents, permission, _origin, details) => canReadFonts(contents, permission, details))
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(canReadFonts(contents, permission, details)))
  // 关闭窗口时先交给渲染进程确认未保存内容；渲染进程会用 app:allow-close 放行。
  window.on('close', event => {
    if (closeAllowedWindows.has(window)) return
    const pending = pendingProjectSaves.get(window)
    if (pending) {
      event.preventDefault()
      pending.closeRequested = true
      return
    }
    event.preventDefault()
    if (window.webContents.isDestroyed()) {
      closeAllowedWindows.add(window)
      window.close()
      return
    }
    window.webContents.send('app:request-close', { quitting: quitRequested })
  })
  const resetWindowMedia = () => {
    compositions.get(window)?.controller.abort()
    mediaSessions.set(window, Symbol())
    setActiveMedia(window, null)
    releaseMedia(pendingMedia, window)
    void finishProjectSave(window)
  }
  window.on('closed', resetWindowMedia)
  window.webContents.on('render-process-gone', resetWindowMedia)
  window.webContents.on('did-navigate', resetWindowMedia)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.loadURL(entry)
  window.webContents.on('did-finish-load', () => {
    while (pendingOpenPaths.length) window.webContents.send('app:open-path', pendingOpenPaths.shift())
  })
}

async function initialize() {
  nativeTheme.themeSource = 'dark'
  // 打包后的资源可能丢失可执行位，启动时给内置 FFmpeg 补一次权限。
  for (const binary of bundledEncoders()) chmod(binary, 0o755).catch(() => {})
  protocol.handle('subx-media', streamMedia)
  protocol.handle('subx', async request => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response(null, { status: 404 })
    const asset = url.pathname.slice('/libass/'.length)
    let source
    if (appFiles.has(url.pathname)) source = new URL('..' + url.pathname, import.meta.url)
    else if (url.pathname.startsWith('/libass/') && libassFiles.has(asset)) source = pathToFileURL(join(libass, asset))
    if (!source) return new Response(null, { status: 404 })
    const response = await net.fetch(source.href)
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': fileTypes.get(extname(url.pathname)), 'X-Content-Type-Options': 'nosniff' },
    })
  })

  const recentFile = join(app.getPath('userData'), 'recent-projects.json')
  const recent = await readText(recentFile).then(JSON.parse).catch(() => [])
  const documents = new WeakMap()
  function rememberDocument(window, file, contents) {
    const handle = { id: randomUUID(), name: basename(file) }
    documents.set(window, { handle, file, digest: digest(contents) })
    return handle
  }

  const projects = new Map()
  for (const entry of Array.isArray(recent) ? recent : []) {
    const file = typeof entry === 'string' ? entry : entry?.file
    const openedAt = typeof entry === 'string' ? 0 : Number(entry?.openedAt) || 0
    if (typeof file === 'string' && file) projects.set(file, openedAt)
  }
  let persistRecent = Promise.resolve()
  function remember(file, exists = true) {
    projects.delete(file)
    if (exists) projects.set(file, Date.now())
    while (projects.size > 12) projects.delete(projects.keys().next().value)
    const snapshot = JSON.stringify([...projects].map(([file, openedAt]) => ({ file, openedAt })))
    persistRecent = persistRecent.catch(() => {}).then(() => writeAtomically(recentFile, snapshot))
    return persistRecent.catch(error => console.warn('Could not save recent projects:', error.message))
  }
  const autosaveDirectory = join(app.getPath('userData'), 'autosave')
  const autosaveFile = join(autosaveDirectory, 'current.json')
  let autosaveQueue = Promise.resolve()
  function queueAutosave(task) {
    const next = autosaveQueue.catch(() => {}).then(task)
    autosaveQueue = next.catch(() => {})
    return next
  }
  function sanitizeDrafts(drafts) {
    const pairs = value => Array.isArray(value)
      ? value.filter(item => Array.isArray(item) && typeof item[0] === 'string' && Array.isArray(item[1]) &&
          item[1].every(change => Array.isArray(change) && Number.isInteger(change[0]) && typeof change[1] === 'string'))
        .map(([id, changes]) => [id, changes])
      : []
    const editor = drafts?.editor && typeof drafts.editor.cueId === 'string' && typeof drafts.editor.text === 'string'
      ? { cueId: drafts.editor.cueId, text: drafts.editor.text.slice(0, 20000) }
      : null
    return { cues: pairs(drafts?.cues), styles: pairs(drafts?.styles), editor }
  }
  function parseAutosave(text) {
    if (typeof text !== 'string' || !text) return null
    try {
      const data = JSON.parse(text)
      if (!data || typeof data !== 'object' || data.version !== 1) return null
      validateProject(data.project)
      return {
        savedAt: Number.isFinite(data.savedAt) ? data.savedAt : 0,
        documentName: typeof data.documentName === 'string' ? data.documentName : '',
        documentPath: typeof data.documentPath === 'string' ? data.documentPath : null,
        project: data.project,
        drafts: sanitizeDrafts(data.drafts),
      }
    } catch {
      return null
    }
  }
  bind('autosave:write', (window, payload) => {
    if (!payload || typeof payload !== 'object' || !payload.project) throw new Error('无效的自动保存内容')
    validateProject(payload.project)
    const document = documents.get(window)
    const text = JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      documentName: document?.handle.name ?? '未命名工程',
      documentPath: document?.file ?? null,
      project: payload.project,
      drafts: sanitizeDrafts(payload.drafts),
    })
    if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new Error('工程过大，暂未自动保存')
    return queueAutosave(async () => {
      await mkdir(autosaveDirectory, { recursive: true })
      await writeAtomically(autosaveFile, text)
      await chmod(autosaveFile, 0o600).catch(() => {})
      return true
    })
  })
  bind('autosave:info', async () => {
    const data = parseAutosave(await readText(autosaveFile).catch(() => ''))
    return data ? { savedAt: data.savedAt, documentName: data.documentName, documentPath: data.documentPath } : null
  })
  bind('autosave:restore', async window => {
    const data = parseAutosave(await readText(autosaveFile).catch(() => ''))
    if (!data) return null
    const session = mediaSessions.get(window)
    const media = typeof data.project.media === 'string'
      ? await mediaReference(data.project.media, window, session)
      : null
    if (window.isDestroyed() || mediaSessions.get(window) !== session) return null
    releaseMedia(pendingMedia, window)
    setActiveMedia(window, media?.token)
    return {
      project: data.project,
      media,
      drafts: data.drafts,
      documentName: data.documentName,
      documentPath: data.documentPath,
      savedAt: data.savedAt,
    }
  })
  bind('autosave:clear', () => queueAutosave(async () => {
    await unlink(autosaveFile).catch(() => {})
    return true
  }))

  bind('media:choose', async window => {
    const session = mediaSessions.get(window)
    const file = await selectFile(window, '视频', [...mediaTypes.keys()].map(extension => extension.slice(1)))
    if (!file) return null
    const reference = await mediaReference(file, window, session)
    if (!reference) throw new Error('所选视频无法读取')
    releaseMedia(pendingMedia, window)
    pendingMedia.set(window, reference.token)
    return reference
  })
  bind('media:finish-selection', (window, token, accepted) => {
    if (typeof accepted !== 'boolean' || typeof token !== 'string' || pendingMedia.get(window) !== token) return false
    if (accepted) {
      pendingMedia.delete(window)
      setActiveMedia(window, token)
    } else releaseMedia(pendingMedia, window)
    return true
  })
  async function chooseText(window, name, extensions) {
    const file = await selectFile(window, name, extensions)
    if (!file) return null
    const contents = await readFile(file)
    const [first, second] = contents
    let encoding = 'utf-8'
    if (first === 0xff && second === 0xfe) encoding = 'utf-16le'
    if (first === 0xfe && second === 0xff) encoding = 'utf-16be'
    return { name: basename(file), extension: extname(file).toLowerCase(), text: decodeText(contents, file, encoding) }
  }
  bind('subtitles:choose', window => chooseText(window, '字幕', ['srt', 'ass', 'vtt']))
  async function readImageFile(file) {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('请选择一张图片作为水印。')
    if (info.size > 8 * 1024 * 1024) throw new Error('水印图片过大，请选择 8MB 以内的图片。')
    const extension = extname(file).toLowerCase()
    const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    return { path: file, name: basename(file), dataUrl: 'data:' + mime + ';base64,' + (await readFile(file)).toString('base64') }
  }
  bind('watermark:choose', async window => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择水印图片', properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    const file = result.filePaths[0]
    return file ? readImageFile(file) : null
  })
  bind('watermark:read', (_window, file) => {
    if (typeof file !== 'string' || !file || file.includes('\0')) return null
    return readImageFile(file).catch(() => null)
  })
  bind('script:choose', window => chooseText(window, '文稿', ['txt']))
  async function readProject(window, file) {
    const session = mediaSessions.get(window)
    let contents
    let project
    let location
    try {
      location = await realpath(file)
      contents = await readFile(location)
      project = JSON.parse(decodeText(contents, file))
    } catch (error) {
      if (error.code === 'ENOENT') {
        await remember(file, false)
        throw new Error('工程文件已不存在，可能被移动或删除。')
      }
      // 内容不是合法工程时给出可读提示，而不是把 JSON 解析错误直接抛给界面。
      if (error instanceof SyntaxError) throw new Error('无法打开工程：文件内容不是有效的 SubX 工程。')
      throw error
    }
    normalizeStyleNames(project)
    validateProject(project)
    await remember(file)
    const media = typeof project.media === 'string' ? await mediaReference(project.media, window, session) : null
    if (window.isDestroyed() || mediaSessions.get(window) !== session) return null
    releaseMedia(pendingMedia, window)
    setActiveMedia(window, media?.token)
    return { project, media, document: rememberDocument(window, location, contents) }
  }
  bind('project:open', async (window, recent) => {
    const file = recent === undefined ? await selectFile(window, 'SubX 工程', ['subx']) : recent
    if (!file || recent !== undefined && !projects.has(file)) return null
    return readProject(window, file)
  })
  // 访达双击或命令行传入的工程路径，不受“最近工程”列表限制。
  bind('project:open-path', (window, file) => {
    if (typeof file !== 'string' || !/\.subx$/i.test(file)) return null
    return readProject(window, file)
  })
  bind('project:recent', () => [...projects]
    .map(([file, openedAt]) => ({ file, openedAt }))
    .sort((left, right) => right.openedAt - left.openedAt))
  async function saveProject(window, project, documentId, saveAs) {
    validateProject(project)
    const current = documents.get(window)
    const active = documentId && current?.handle.id === documentId ? current : null
    if (documentId && !active) throw new Error('工程保存位置已失效，请先重新打开工程。')
    const contents = JSON.stringify(project, null, 2) + '\n'
    let file = active?.file
    if (!file || saveAs) {
      const result = await dialog.showSaveDialog(window, {
        defaultPath: file ? join(dirname(file), basename(file, extname(file)) + ' 副本.subx') : 'SubX 工程.subx',
        filters: [{ name: 'SubX 工程', extensions: ['subx'] }],
      })
      file = result.filePath
      if (!file) return null
      file = await realpath(file).catch(async error => {
        if (error.code !== 'ENOENT') throw error
        return join(await realpath(dirname(file)), basename(file))
      })
    }
    const previousDigest = file === active?.file ? active.digest : undefined
    await writeAtomically(file, contents, { projectFile: true, previousDigest })
    await remember(file)
    return rememberDocument(window, file, contents)
  }
  bind('project:save', (window, project, documentId, saveAs, id) => {
    if (!window || typeof id !== 'string' || pendingProjectSaves.has(window)) {
      throw new Error('无法启动工程保存，请稍后再试。')
    }
    const write = Promise.resolve().then(() => saveProject(window, project, documentId, saveAs))
    pendingProjectSaves.set(window, { id, write, closeRequested: false })
    return write
  })
  bind('project:save-finished', (window, id) => typeof id === 'string' && finishProjectSave(window, id))
  bind('app:version', () => app.getVersion())
  ipcMain.on('app:quit', event => {
    if (event.senderFrame?.url !== entry || event.senderFrame !== event.sender.mainFrame) return
    app.quit()
  })
  ipcMain.on('app:allow-close', event => {
    if (event.senderFrame?.url !== entry || event.senderFrame !== event.sender.mainFrame) return
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    closeAllowedWindows.add(window)
    if (quitRequested) app.quit()
    else window.close()
  })
  ipcMain.on('app:cancel-close', event => {
    if (event.senderFrame?.url !== entry || event.senderFrame !== event.sender.mainFrame) return
    quitRequested = false
  })
  bind('app:open-external', async (_window, url) => {
    const link = new URL(url)
    if (link.protocol !== 'https:') throw new Error('只允许打开 HTTPS 链接')
    await shell.openExternal(link.href)
  })
  const encoderPreference = join(app.getPath('userData'), 'video-encoder.json')
  bind('media:cancel-waveform', window => {
    waveformRequests.get(window)?.abort()
    frameRequests.get(window)?.abort()
  })
  async function analyzeMedia(window, token, requests, analyze) {
    if (!token || token !== activeMedia.get(window)) return null
    const source = media.get(token)
    if (!source) return null
    requests.get(window)?.abort()
    const controller = new AbortController()
    requests.set(window, controller)
    const signal = controller.signal
    try {
      const saved = await readText(encoderPreference).then(JSON.parse).catch(() => null)
      return await analyze(typeof saved === 'string' ? saved : null, source, signal)
    } catch {
      return null
    } finally {
      if (requests.get(window) === controller) requests.delete(window)
    }
  }
  bind('media:waveform', (window, token, duration) => {
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) return null
    return analyzeMedia(window, token, waveformRequests, async (saved, source, signal) => {
      const binary = await findEncoder(null, saved, signal)
      return binary ? readWaveform(binary, source, duration, signal) : null
    })
  })
  bind('media:frame-times', (window, token) => analyzeMedia(window, token, frameRequests, readFrameTimes))
  async function compose(window, options, source, token, signal) {
    const saved = await readText(encoderPreference).then(JSON.parse).catch(() => null)
    let binary = await findEncoder(options, typeof saved === 'string' ? saved : null, signal)
    if (!binary) {
      const result = await dialog.showMessageBox(window, {
        type: 'info', message: '需要兼容的 FFmpeg 才能合成视频',
        detail: '请选择支持 libass、所选视频编码器和 AAC 的本机 FFmpeg 可执行文件。',
        buttons: ['选择 FFmpeg', '取消'], cancelId: 1,
      })
      if (result.response !== 0 || signal.aborted) return false
      const choice = await dialog.showOpenDialog(window, {
        title: '选择 FFmpeg 可执行文件', properties: ['openFile'],
        ...(process.platform === 'win32' && { filters: [{ name: 'FFmpeg', extensions: ['exe'] }] }),
      })
      if (!choice.filePaths.length || signal.aborted) return false
      binary = await findEncoder(options, null, signal, choice.filePaths[0])
      if (!binary) throw new Error('所选 FFmpeg 缺少所需滤镜或编码器，或文件名不是 ffmpeg / ffmpeg.exe。')
      await writeAtomically(encoderPreference, JSON.stringify(binary))
    }
    signal.throwIfAborted()
    const solid = options.solid ?? null
    const base = solid ? join(app.getPath('videos'), '空白视频') : join(dirname(source), basename(source, extname(source)))
    const result = await dialog.showSaveDialog(window, {
      title: '合成视频', defaultPath: base + ' - 字幕.mp4',
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    })
    if (!result.filePath || signal.aborted) return false
    if (!solid && activeMedia.get(window) !== token) throw new Error('源视频已更换，请重新开始合成。')
    await encodeVideo({ binary, source, solid, destination: result.filePath, options, signal,
      progress: seconds => { if (!window.isDestroyed()) window.webContents.send('video:progress', seconds) },
    })
    return true
  }
  bind('video:compose', (window, options) => {
    validateComposition(options)
    if (compositions.has(window)) throw new Error('已有视频正在合成。')
    const token = activeMedia.get(window)
    const source = media.get(token)
    if (!options.solid && !source) throw new Error('请先打开源视频。')
    const controller = new AbortController()
    const done = compose(window, options, source, token, controller.signal)
      .catch(error => { if (controller.signal.aborted) return false; throw error })
      .finally(() => compositions.delete(window))
    compositions.set(window, { controller, done })
    return done
  })
  bind('video:cancel', window => { compositions.get(window)?.controller.abort() })
  bind('subtitles:export', async (window, data) => {
    const { name, text, format } = data
    if (!['srt', 'ass', 'vtt'].includes(format) || typeof text !== 'string' || typeof name !== 'string') {
      throw new Error('无效的导出内容')
    }
    const title = name.replace(/[\\/:*?"<>|]/g, '_')
    const result = await dialog.showSaveDialog(window, {
      defaultPath: title + '.' + format,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
    if (!result.filePath) return false
    await writeAtomically(result.filePath, text)
    return true
  })
  ipcMain.on('menu:update', (event, groups) => {
    if (process.platform !== 'darwin' || event.senderFrame?.url !== entry || event.senderFrame !== event.sender.mainFrame) return
    if (!Array.isArray(groups) || groups.length !== 4) return
    const source = BrowserWindow.fromWebContents(event.sender)
    if (!source) return
    const template = [{ label: 'SubX', submenu: [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }] }]
    for (const group of groups) {
      if (!['文件', '编辑', '导出', '关于'].includes(group.label) || !Array.isArray(group.items)) return
      template.push({ label: group.label, submenu: group.items.map(item => {
        if (item.separator) return { type: 'separator' }
        return {
          label: String(item.label).slice(0, 80), enabled: Boolean(item.enabled),
          ...({ '⌘N': 'Command+N', '⌘O': 'Command+O', '⌘S': 'Command+S',
            '⇧⌘S': 'Command+Shift+S', '⌘I': 'Command+I', '⌘F': 'Command+F', '⌘E': 'Command+E',
            '⌘Q': 'Command+Q', '⌘Z': 'Command+Z', '⇧⌘Z': 'Command+Shift+Z',
            }[item.accelerator]
            ? { registerAccelerator: false, accelerator: { '⌘N': 'Command+N', '⌘O': 'Command+O', '⌘S': 'Command+S',
              '⇧⌘S': 'Command+Shift+S', '⌘I': 'Command+I', '⌘F': 'Command+F', '⌘E': 'Command+E',
              '⌘Q': 'Command+Q', '⌘Z': 'Command+Z', '⇧⌘Z': 'Command+Shift+Z',
              }[item.accelerator] } : {}),
          ...(item.checked === undefined ? {} : { type: 'checkbox', checked: Boolean(item.checked) }),
          click: () => { if (!source.isDestroyed()) source.webContents.send('menu:command', item.id) },
        }
      }) })
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else if (process.platform === 'win32' && require('electron-squirrel-startup')) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    // Windows 会把双击的文件路径作为参数传给已有实例。
    const file = argv.find(argument => /\.subx$/i.test(argument))
    if (file) window.webContents.send('app:open-path', file)
  })
  if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.SubX.SubX')
  app.whenReady().then(initialize).catch(error => {
    console.error(error)
    dialog.showErrorBox('SubX 启动失败', error.message)
    app.exit(1)
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', event => {
    quitRequested = true
    if (compositions.size) {
      event.preventDefault()
      const jobs = [...compositions.values()]
      for (const job of jobs) job.controller.abort()
      void Promise.allSettled(jobs.map(job => job.done)).then(() => app.quit())
      return
    }
    if (!pendingProjectSaves.size) return
    event.preventDefault()
    quitAfterSave = true
  })
}
