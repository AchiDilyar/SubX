// 帧率比例缩放：目标帧率 / 源帧率，时间按比例映射，至少保留 1ms 时长。
export function retimeCue(cue, sourceFps, targetFps) {
  const ratio = Number(targetFps) / Number(sourceFps)
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('帧率必须为正数')
  const start = Math.max(0, Math.round(cue.start * ratio))
  const end = Math.max(start + 1, Math.round(cue.end * ratio))
  return { ...cue, start, end }
}

export function retimeCues(cues, sourceFps, targetFps) {
  return cues.map(cue => retimeCue(cue, sourceFps, targetFps))
}

export const RETIME_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120]

export function nearestRetimeFps(fps) {
  if (!Number.isFinite(fps) || fps <= 0) return 25
  return RETIME_FPS.reduce((best, value) => Math.abs(value - fps) < Math.abs(best - fps) ? value : best, RETIME_FPS[0])
}
