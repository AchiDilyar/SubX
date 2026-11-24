// 时间码：毫秒 / 非丢帧 / 丢帧（29.97、59.94 等）。
import { printTime } from './srt.mjs'

export const TIMECODE_MODES = ['milliseconds', 'frames', 'drop']

export function nominalFps(fps) {
  return Math.max(1, Math.round(Number(fps) || 0))
}

export function isDropFrameFps(fps) {
  return Math.abs(fps - 29.97) < 0.02 || Math.abs(fps - 59.94) < 0.02
}

function dropCount(fps) {
  return Math.round(nominalFps(fps) * 0.066666)
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0')
}

export function formatTimecode(milliseconds, fps, mode = 'frames') {
  const time = Math.max(0, Number(milliseconds) || 0)
  if (mode === 'milliseconds') return printTime(Math.round(time), '.')
  const nominal = nominalFps(fps)
  const drop = mode === 'drop' && isDropFrameFps(fps)
  const dropFrames = drop ? dropCount(fps) : 0
  let frames = Math.round(time * (Number(fps) || nominal) / 1000)
  if (drop) {
    const per10Min = nominal * 600
    const perMin = nominal * 60
    const tenMins = Math.floor(frames / per10Min)
    const remainder = frames % per10Min
    frames += dropFrames * 9 * tenMins
    if (remainder > dropFrames) frames += dropFrames * Math.floor((remainder - dropFrames) / perMin)
  }
  const ff = frames % nominal
  const totalSeconds = Math.floor(frames / nominal)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + (drop ? ';' : ':') + pad(ff)
}

export function parseTimecode(value, fps, mode = 'frames') {
  const text = String(value ?? '').trim()
  if (!text) return NaN
  if (mode === 'milliseconds' || /^\d{1,2}:\d{2}:\d{2}\.\d{1,3}$/.test(text)) {
    const match = text.match(/^(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$/)
    if (!match) return NaN
    const [, h, m, s, fraction] = match
    const ms = fraction.padEnd(3, '0').slice(0, 3)
    return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms)
  }
  const match = text.match(/^(\d{1,2}):(\d{2}):(\d{2})([:;])(\d{2})$/)
  if (!match) return NaN
  const [, h, m, s, separator, frame] = match
  const nominal = nominalFps(fps)
  if (Number(frame) >= nominal) return NaN
  const drop = mode === 'drop' && separator === ';' && isDropFrameFps(fps)
  let frames = nominal * (Number(h) * 3600 + Number(m) * 60 + Number(s)) + Number(frame)
  if (drop) {
    const totalMinutes = Number(h) * 60 + Number(m)
    frames -= dropCount(fps) * (totalMinutes - Math.floor(totalMinutes / 10))
  }
  if (frames < 0) return NaN
  return frames * 1000 / (Number(fps) || nominal)
}

export function timecodeModeLabel(mode) {
  return { milliseconds: '毫秒', frames: '非丢帧', drop: '丢帧' }[mode] ?? mode
}
