import assert from 'node:assert/strict'
import test from 'node:test'
import { createProject, createTrack, normalizeStyleNames, validateProject } from '../src/core/project.mjs'
import { newStyle } from '../src/core/ass.mjs'

function projectWithStyles(styles) {
  const project = createProject()
  const track = createTrack('S0', [{ start: 0, end: 1000, text: 'a' }])
  project.tracks = [track]
  project.styles = styles
  return { project, track }
}

test('merges duplicate style names and remaps cues when a project loads', () => {
  const first = newStyle('ZH')
  const second = newStyle('zh')
  const { project, track } = projectWithStyles([first, second])
  track.cues[0].style = second.id
  normalizeStyleNames(project)
  assert.equal(project.styles.length, 1)
  assert.equal(project.styles[0].id, first.id)
  assert.equal(track.cues[0].style, first.id)
  validateProject(project)
})

test('rejects duplicate style names that were not normalized', () => {
  const first = newStyle('ZH')
  const second = newStyle('zh')
  const { project } = projectWithStyles([first, second])
  assert.throws(() => validateProject(project), /样式名称重复/)
})
