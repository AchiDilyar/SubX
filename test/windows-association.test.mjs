import assert from 'node:assert/strict'
import test from 'node:test'
import { associationArgs, associationEntries, parseRegDefault } from '../src/main/windows-association.mjs'

test('builds HKCU entries for .subx and the open command', () => {
  const entries = associationEntries('C:\\Program Files\\SubX\\SubX.exe')
  assert.deepEqual(entries[0], ['HKCU\\Software\\Classes\\.subx', '', 'SubX.Project'])
  assert.equal(entries[2][2], '"C:\\Program Files\\SubX\\SubX.exe",0')
  assert.equal(entries[3][2], '"C:\\Program Files\\SubX\\SubX.exe" "%1"')
})

test('uses /ve for the default value and /v for named values', () => {
  assert.deepEqual(associationArgs('HKCU\\Software\\Classes\\.subx', '', 'SubX.Project'), ['ADD', 'HKCU\\Software\\Classes\\.subx', '/ve', '/d', 'SubX.Project', '/f'])
  assert.deepEqual(associationArgs('key', 'Name', 'Value'), ['ADD', 'key', '/v', 'Name', '/d', 'Value', '/f'])
})

test('parses the default value from reg query output', () => {
  assert.equal(parseRegDefault('\r\nHKEY_CURRENT_USER\\Software\\Classes\\.subx\r\n    (Default)    REG_SZ    SubX.Project\r\n'), 'SubX.Project')
  assert.equal(parseRegDefault('no default'), null)
})
