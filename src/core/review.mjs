// 校对进度：cue.reviewed === true 视为已校对。
export function reviewStats(project) {
  let total = 0
  let reviewed = 0
  for (const track of project?.tracks ?? []) {
    for (const cue of track.cues ?? []) {
      total += 1
      if (cue.reviewed === true) reviewed += 1
    }
  }
  return { total, reviewed, pending: total - reviewed, percent: total ? Math.round(reviewed / total * 100) : 0 }
}

export function firstPendingCue(project) {
  for (const track of project?.tracks ?? []) {
    for (const cue of track.cues ?? []) {
      if (cue.reviewed !== true) return { track, cue }
    }
  }
  return null
}
