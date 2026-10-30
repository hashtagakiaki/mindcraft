// autonomy fork: goto settles only on observed outcomes.
//
// Upstream resolved on any goal_reached or empty path_update (including an
// empty partial path and a stale reached event for another goal), ignored the
// bot ending, and left the goal set after a failure. This contract rejects
// noPath/timeout and a completed empty path that does not satisfy the goal,
// rejects with the original error when a route dig, placement or equip fails,
// resolves only when this goal is reached and satisfied at the bot's feet,
// clears its own goal on failure, and settles on the next tick so callers can
// chain goals.

function error (name, message) {
  const err = new Error(message)
  err.name = name
  return err
}

function goalPosition (bot) {
  const position = bot.entity.position
  const floored = typeof position.floored === 'function' ? position.floored() : position
  const block = bot.blockAt?.(floored)
  const empty = bot.pathfinder.movements?.emptyBlocks
  if (bot.entity.onGround && position.y - floored.y > 0.001 && block && empty && !empty.has(block.type)) floored.y++
  return floored
}

function goalSatisfied (goal, bot) {
  if (!goal || typeof goal.isEnd !== 'function' || !bot.entity?.position) return false
  try {
    return goal.isEnd(goalPosition(bot))
  } catch {
    return false
  }
}

function goto (bot, goal) {
  const pathfinder = bot.pathfinder
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      bot.removeListener('goal_reached', onGoalReached)
      bot.removeListener('path_update', onPathUpdate)
      bot.removeListener('goal_updated', onGoalUpdated)
      bot.removeListener('path_stop', onPathStop)
      bot.removeListener('path_edit_error', onEditError)
      bot.removeListener('end', onLifecycleEnd)
      bot.removeListener('death', onLifecycleEnd)
    }
    const finish = (err, stopCurrentGoal = false) => {
      if (settled) return
      settled = true
      cleanup()
      if (stopCurrentGoal && pathfinder.goal === goal) pathfinder.setGoal(null)
      setTimeout(() => err ? reject(err) : resolve(), 0)
    }
    const onGoalReached = reachedGoal => {
      if (reachedGoal === goal && goalSatisfied(goal, bot)) finish(null)
    }
    const onPathUpdate = result => {
      if (pathfinder.goal !== goal) return
      if (result?.status === 'noPath') {
        finish(error('NoPath', 'No path to the goal'), true)
      } else if (result?.status === 'timeout') {
        finish(error('Timeout', 'Path search timed out'), true)
      } else if (result?.status === 'success' && result.path?.length === 0 && !goalSatisfied(goal, bot)) {
        finish(error('NoPath', 'Path completed without reaching the goal'), true)
      }
    }
    const onGoalUpdated = nextGoal => {
      if (nextGoal !== goal) finish(error('GoalChanged', 'Goal changed before completion'))
    }
    const onEditError = err => finish(err, true)
    const onPathStop = () => finish(error('PathStopped', 'Path stopped before reaching the goal'))
    const onLifecycleEnd = () => finish(error('BotStopped', 'Bot stopped before reaching the goal'), true)

    if (goalSatisfied(goal, bot)) {
      if (pathfinder.goal) pathfinder.setGoal(null)
      setTimeout(resolve, 0)
      return
    }

    bot.on('goal_reached', onGoalReached)
    bot.on('path_update', onPathUpdate)
    bot.on('goal_updated', onGoalUpdated)
    bot.on('path_stop', onPathStop)
    bot.on('path_edit_error', onEditError)
    bot.on('end', onLifecycleEnd)
    bot.on('death', onLifecycleEnd)
    pathfinder.setGoal(goal)
  })
}

module.exports = goto
module.exports.goalPosition = goalPosition
