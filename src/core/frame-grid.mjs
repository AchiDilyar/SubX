// Project timestamps are integer milliseconds; frame timestamps can be fractional.
export function frameBoundaries(times, duration) {
  if (!times?.length) return []
  return [...new Set([...times.map(Math.round), Math.round(duration)].filter(Number.isSafeInteger))].sort((a, b) => a - b)
}

export function nearestBoundary(boundaries, value, min = -Infinity, max = Infinity) {
  function lowerBound(target) {
    let low = 0, high = boundaries.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (boundaries[mid] < target) low = mid + 1
      else high = mid
    }
    return low
  }
  const first = lowerBound(min), last = lowerBound(max + 1) - 1
  if (first > last) return undefined
  const index = Math.max(first, Math.min(last, lowerBound(value)))
  if (index > first && value - boundaries[index - 1] <= boundaries[index] - value) return boundaries[index - 1]
  return boundaries[index]
}

export function alignCue(boundaries, start, end) {
  if (boundaries.length < 2) return { start: Math.round(start), end: Math.round(end) }
  const alignedStart = nearestBoundary(boundaries, start, -Infinity, boundaries.at(-2))
  const alignedEnd = nearestBoundary(boundaries, end, alignedStart + 1)
  return { start: alignedStart, end: alignedEnd }
}
