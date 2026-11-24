import assert from 'node:assert/strict'
import test from 'node:test'
import { fontCheckSummary, missingStyleFonts, normalizeFontName } from '../src/core/fonts.mjs'

const styles = [
  { id: 'a', fields: { Name: '正文', Fontname: 'Noto Sans SC' } },
  { id: 'b', fields: { Name: '标题', Fontname: 'Helvetica' } },
  { id: 'c', fields: { Name: '重复', Fontname: 'noto sans sc' } },
  { id: 'd', fields: { Name: '空', Fontname: '' } },
]

test('reports unique missing font families case-insensitively', () => {
  const missing = missingStyleFonts(styles, ['Helvetica', 'PingFang SC'])
  assert.deepEqual(missing, [{ styleId: 'a', styleName: '正文', font: 'Noto Sans SC' }])
})

test('normalizes leading @ and summarizes results', () => {
  assert.equal(normalizeFontName(' @Noto Sans SC '), 'noto sans sc')
  assert.equal(fontCheckSummary([], 3), '所有样式字体均已安装')
  assert.equal(fontCheckSummary([{ font: 'X' }], 3), '1 个字体缺失，涉及 1 个样式')
  assert.equal(fontCheckSummary([], 0), '当前工程没有样式')
})
