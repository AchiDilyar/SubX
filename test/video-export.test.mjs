import assert from 'node:assert/strict'
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeVideo, validateComposition } from '../src/main/video-export.mjs'

const options = { codec: 'h264', crf: 20, preset: 'medium', height: 'source', fps: 'source', audio: '192', layers: [] }

test('视频合成仅接受面板支持的编码参数', () => {
  for (const invalid of [{ crf: 52 }, { crf: 2.5 }, { codec: 'copy' }, { height: '-1' },
    { audio: 'copy' }, { fps: '0' }, { preset: '' }, { layers: [42] }]) {
    assert.throws(() => validateComposition({ ...options, ...invalid }), /设置/)
  }
  assert.doesNotThrow(() => validateComposition(options))
})

test('源片别名和编码器失败均保留原文件并清理临时目录', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subx-encoder-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source.mp4')
  const alias = join(directory, 'alias.mp4')
  const destination = join(directory, 'existing.mp4')
  await writeFile(source, 'input')
  await link(source, alias)
  await writeFile(destination, 'previous')
  const encode = target => encodeVideo({ source, destination: target, options,
    binary: join(directory, 'missing-ffmpeg'), signal: new AbortController().signal })
  await assert.rejects(encode(alias), /源视频相同/)
  await assert.rejects(encode(destination), { code: 'ENOENT' })
  assert.equal(await readFile(destination, 'utf8'), 'previous')
  assert.equal(await readFile(source, 'utf8'), 'input')
  assert.deepEqual((await readdir(directory)).sort(), ['alias.mp4', 'existing.mp4', 'source.mp4'])
})
