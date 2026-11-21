import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [mode, media] = process.argv.slice(2)
if (mode && (mode !== '--preview' || !media)) {
  throw Error('Usage: npm run test:preview -- <path-to-4k-video>')
}
const previewMedia = media ? resolve(media) : ''
if (previewMedia && !(await stat(previewMedia)).isFile()) throw Error('Provide a local 4K video file')
const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'subx-desktop-'))
try {
  await mkdir(join(directory, 'profile'))
  await cp(new URL('./fixtures/', import.meta.url), directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'subx-desktop-smoke',
    version: '0.0.0',
    main: 'main.mjs',
  }))
  await writeFile(join(directory, 'main.mjs'), 'import ' + JSON.stringify(new URL('./scenario.mjs', import.meta.url).href))

  const result = spawnSync(process.execPath, [require.resolve('electron/cli.js'), '--app=' + directory], {
    env: { ...process.env, SUBX_SMOKE_DIRECTORY: directory, SUBX_PREVIEW_MEDIA: previewMedia },
    stdio: 'inherit',
    timeout: 90000,
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
}
