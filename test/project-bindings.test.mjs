import assert from 'node:assert/strict'
import test from 'node:test'
import { createProject, createTrack, removeCue, validateProject } from '../src/core/project.mjs'

function projectWithCues() {
  const project = createProject()
  project.tracks = [createTrack('S0', [
    { start: 0, end: 1000, text: 'a' },
    { start: 1000, end: 2000, text: 'b' },
    { start: 2000, end: 3000, text: 'c' },
  ])]
  return project
}

test('accepts cue bindings and prunes them when a cue is removed', () => {
  const project = projectWithCues()
  const ids = project.tracks[0].cues.map(cue => cue.id)
  project.bindings = [[ids[0], ids[1]]]
  validateProject(project)
  removeCue(project, ids[1])
  assert.deepEqual(project.bindings, [])
})

test('rejects bindings that overlap or reference missing cues', () => {
  const project = projectWithCues()
  const ids = project.tracks[0].cues.map(cue => cue.id)
  project.bindings = [[ids[0], ids[1]], [ids[1], ids[2]]]
  assert.throws(() => validateProject(project), /字幕绑定/)
  project.bindings = [[ids[0], 'missing']]
  assert.throws(() => validateProject(project), /字幕绑定/)
})
