import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const executable = process.argv[2]
assert(executable, 'Provide the path to the installed SubX executable')
const profile = await mkdtemp(join(tmpdir(), 'subx-installed-lite-'))
let child
let exited
let socket
try {
  child = spawn(executable, [
    '--user-data-dir=' + profile,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
  ], { stdio: 'inherit' })
  exited = once(child, 'close')
  const portFile = join(profile, 'DevToolsActivePort')
  let target
  for (let attempt = 0; attempt < 120 && !target; attempt++) {
    if (child.exitCode !== null) throw new Error('SubX exited with code ' + child.exitCode)
    const contents = await readFile(portFile, 'utf8').catch(() => '')
    const port = Number(contents.split('\n')[0])
    if (port) {
      const pages = await fetch('http://127.0.0.1:' + port + '/json/list', {
        signal: AbortSignal.timeout(1000),
      }).then(response => response.json()).catch(() => [])
      target = pages.find(page => page.url === 'subx://app/renderer/index.html')
    }
    if (!target) await delay(250)
  }
  assert(target, 'Installed SubX did not expose its workspace')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  let nextId = 0
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++nextId
    const signal = AbortSignal.timeout(5000)
    const receive = event => {
      const reply = JSON.parse(event.data)
      if (reply.id !== id) return
      signal.removeEventListener('abort', timeout)
      socket.removeEventListener('message', receive)
      const error = reply.error?.message || reply.result?.exceptionDetails?.text
      if (error) reject(Error(error))
      else resolve(reply.result.result.value)
    }
    const timeout = () => {
      socket.removeEventListener('message', receive)
      reject(Error('Renderer evaluation timed out'))
    }
    signal.addEventListener('abort', timeout, { once: true })
    socket.addEventListener('message', receive)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
  let ready = false
  for (let attempt = 0; attempt < 120 && !ready; attempt++) {
    ready = await evaluate('document.querySelector("#ruler")?.children.length > 0').catch(() => false)
    if (!ready) await delay(250)
  }
  assert(ready, 'Installed SubX workspace did not finish initializing')
  const title = await evaluate('document.title')
  assert(title.includes('SubX'), 'Installed SubX window title is unexpected: ' + title)
  console.log('PASS installed SubX launches and initializes its workspace')
} finally {
  socket?.close()
  if (child?.pid) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {}
    } else {
      child.kill()
    }
    await exited?.catch(() => {})
  }
  if (process.platform === 'win32') await delay(500)
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
