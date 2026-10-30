// Drops the leading path nodes the bot has already passed (upstream
// pathFromPlayer).
//
// autonomy fork: postProcessPath centers only plain movement nodes; a node with
// toBreak/toPlace keeps its raw block-corner coordinates. The distance to such
// a node cannot tell whether the node before it was passed, and upstream used
// it anyway: next to a pillar column the move into that column was dropped,
// the pillar ran from the neighboring column, placed its scaffold beside the
// bot and the next plan dug it out again. Before an edit node, the preceding
// move is dropped only once it is actually reached.
function trimPassedNodes (path, position) {
  if (path.length === 0) return
  let minI = 0
  let minDistance = 1000
  for (let i = 0; i < path.length; i++) {
    const node = path[i]
    if (node.toBreak.length !== 0 || node.toPlace.length !== 0) break
    const dist = position.distanceSquared(node)
    if (dist < minDistance) {
      minDistance = dist
      minI = i
    }
  }
  // check if we are between 2 nodes
  const n1 = path[minI]
  // check if node already reached
  const dx = n1.x - position.x
  const dy = n1.y - position.y
  const dz = n1.z - position.z
  const reached = Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < 1
  if (minI + 1 < path.length && n1.toBreak.length === 0 && n1.toPlace.length === 0) {
    const n2 = path[minI + 1]
    const n2Edits = n2.toBreak.length > 0 || n2.toPlace.length > 0
    const d2 = position.distanceSquared(n2)
    const d12 = n1.distanceSquared(n2)
    minI += reached || (!n2Edits && d12 > d2) ? 1 : 0
  }

  path.splice(0, minI)
}

module.exports = { trimPassedNodes }
