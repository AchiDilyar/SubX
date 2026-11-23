import assert from 'node:assert/strict'
import test from 'node:test'
import { readAss } from '../src/core/ass.mjs'

const ssa = `[Script Info]
ScriptType: v4.00
PlayResX: 640
PlayResY: 480

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,1,1,0,2,10,10,10,0,1

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello\\Nworld
`

test('imports SSA v4 styles and events', () => {
  const result = readAss(ssa)
  assert.equal(result.issues.length, 0)
  assert.equal(result.resolution.width, 640)
  assert.equal(result.cues.length, 1)
  assert.equal(result.cues[0].text, 'Hello\nworld')
  assert.equal(result.styles.length, 1)
  assert.equal(result.styles[0].fields.Name, 'Default')
  assert.equal(result.styles[0].fields.Fontname, 'Arial')
})
