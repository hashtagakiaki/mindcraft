// autonomy fork: vines and ladders on a same-height route.
//
// Vanilla climbing starts whenever the feet are in a climbable block while the
// player pushes against a wall or holds jump. Pathfinder walks through vines and
// ladders as ordinary air, so a small overshoot into the wall lifts the bot. Its
// arrival check ignores vertical error below one block and keeps pressing
// forward, so the lift continues until the stuck timer resets the path.

// Extra cost for a same-height move that ends inside a climbable block, so
// searches prefer routes that keep the feet out of vines and ladders.
const CLIMBABLE_HORIZONTAL_COST = 2
// Height above the next path node, while in a climbable block, at which the
// bot stops pushing and lets the climbable lower it back to the node.
const CLIMB_DRIFT_TOLERANCE = 0.5

function penalizeClimbableNeighbors (movements, node, neighbors) {
  for (const move of neighbors) {
    if (move.y === node.y && movements.getBlock(move, 0, 0, 0).climbable) move.cost += CLIMBABLE_HORIZONTAL_COST
  }
  return neighbors
}

// Runs after the controls for this tick were chosen.
function holdClimbableDrift (bot, next, climbables) {
  if (!next || next.toBreak.length > 0 || next.toPlace.length > 0) return
  const position = bot.entity.position
  const feet = bot.blockAt(position)
  if (!feet || !climbables?.has(feet.type)) return
  if (next.y > position.y) return
  bot.setControlState('jump', false)
  if (position.y - next.y > CLIMB_DRIFT_TOLERANCE) {
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
  }
}

module.exports = { CLIMBABLE_HORIZONTAL_COST, CLIMB_DRIFT_TOLERANCE, penalizeClimbableNeighbors, holdClimbableDrift }
