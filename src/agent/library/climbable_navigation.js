// Vanilla climbing starts whenever the feet are in a climbable block while the
// player pushes against a wall or holds jump. Pathfinder walks through vines and
// ladders as ordinary air, so a small overshoot into the wall lifts the bot. Its
// arrival check ignores vertical error below one block and keeps pressing
// forward, so the lift continues until the stuck timer resets the path.

// Extra cost for a same-height move that ends inside a climbable block, so
// searches prefer routes that keep the feet out of vines and ladders.
export const CLIMBABLE_HORIZONTAL_COST = 2
// Height above the next path node, while in a climbable block, at which the
// bot stops pushing and lets the climbable lower it back to the node.
export const CLIMB_DRIFT_TOLERANCE = 0.5

const penalizedMovements = new WeakSet()

export function penalizeHorizontalClimbableMoves (movements) {
  if (!movements || penalizedMovements.has(movements)) return movements
  const getNeighbors = movements.getNeighbors
  movements.getNeighbors = function (node) {
    const neighbors = getNeighbors.call(this, node)
    for (const move of neighbors) {
      if (move.y === node.y && this.getBlock(move, 0, 0, 0).climbable) move.cost += CLIMBABLE_HORIZONTAL_COST
    }
    return neighbors
  }
  penalizedMovements.add(movements)
  return movements
}

export function climbableNavigationPlugin (bot) {
  const getPathFromTo = bot.pathfinder.getPathFromTo
  bot.pathfinder.getPathFromTo = function (movements, ...args) {
    return getPathFromTo.call(this, penalizeHorizontalClimbableMoves(movements), ...args)
  }

  // Pathfinder shifts the emitted path array in place as nodes are reached.
  let path = null
  bot.on('path_update', results => { path = results.path })
  for (const event of ['path_reset', 'path_stop', 'goal_reached']) bot.on(event, () => { path = null })

  // Registered after pathfinder's own physicsTick listener, so these controls
  // replace the ones it just set for the next tick.
  bot.on('physicsTick', () => {
    const next = path?.[0]
    if (!next || next.toBreak.length > 0 || next.toPlace.length > 0 || !bot.pathfinder.isMoving()) return
    const position = bot.entity.position
    const feet = bot.blockAt(position)
    if (!feet || !bot.pathfinder.movements?.climbables?.has(feet.type)) return
    if (next.y > position.y) return
    bot.setControlState('jump', false)
    if (position.y - next.y > CLIMB_DRIFT_TOLERANCE) {
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
    }
  })
}
