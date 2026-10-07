const installedBots = new WeakMap()

export const DIG_GROUND_TIMEOUT_MS = 15_000
export const DIG_LOOK_TIMEOUT_MS = 5_000
export const DIG_CONFIRMATION_GRACE_MS = 2_000

const SPECIAL_MOVEMENT_BLOCKS = new Set([
  'water', 'flowing_water', 'bubble_column', 'ladder', 'vine', 'scaffolding'
])

function samePosition (a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.z === b.z
}

function goalSatisfied (goal, bot) {
  if (!goal || typeof goal.isEnd !== 'function' || !bot.entity?.position) return false
  const position = bot.entity.position
  const floored = typeof position.floored === 'function' ? position.floored() : position
  try {
    return goal.isEnd(floored) || goal.isEnd(floored.offset?.(0, 1, 0) ?? floored)
  } catch {
    return false
  }
}

function installGotoContract (bot) {
  const pathfinder = bot.pathfinder
  if (!pathfinder || typeof pathfinder.setGoal !== 'function') return

  pathfinder.goto = goal => new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      bot.removeListener('goal_reached', onGoalReached)
      bot.removeListener('path_update', onPathUpdate)
      bot.removeListener('goal_updated', onGoalUpdated)
      bot.removeListener('path_stop', onPathStop)
      bot.removeListener('end', onLifecycleEnd)
      bot.removeListener('death', onLifecycleEnd)
    }
    const finish = (error, stopCurrentGoal = false) => {
      if (settled) return
      settled = true
      cleanup()
      if (stopCurrentGoal && pathfinder.goal === goal) pathfinder.setGoal(null)
      setTimeout(() => error ? reject(error) : resolve(), 0)
    }
    const onGoalReached = reachedGoal => {
      if (reachedGoal === goal && goalSatisfied(goal, bot)) finish(null)
    }
    const onPathUpdate = result => {
      if (pathfinder.goal !== goal) return
      if (result?.status === 'noPath') {
        finish(Object.assign(new Error('No path to the goal'), { name: 'NoPath' }), true)
      } else if (result?.status === 'timeout') {
        finish(Object.assign(new Error('Path search timed out'), { name: 'Timeout' }), true)
      } else if (result?.status === 'success' && result.path?.length === 0 && !goalSatisfied(goal, bot)) {
        finish(Object.assign(new Error('Path completed without reaching the goal'), { name: 'NoPath' }), true)
      }
    }
    const onGoalUpdated = nextGoal => {
      if (nextGoal !== goal) finish(Object.assign(new Error('Goal changed before completion'), { name: 'GoalChanged' }))
    }
    const onPathStop = () => finish(Object.assign(new Error('Path stopped before reaching the goal'), { name: 'PathStopped' }))
    const onLifecycleEnd = () => finish(Object.assign(new Error('Bot stopped before reaching the goal'), { name: 'BotStopped' }), true)

    if (goalSatisfied(goal, bot)) {
      if (pathfinder.goal) pathfinder.setGoal(null)
      setTimeout(resolve, 0)
      return
    }

    bot.on('goal_reached', onGoalReached)
    bot.on('path_update', onPathUpdate)
    bot.on('goal_updated', onGoalUpdated)
    bot.on('path_stop', onPathStop)
    bot.on('end', onLifecycleEnd)
    bot.on('death', onLifecycleEnd)
    pathfinder.setGoal(goal)
  })
}

function shouldCorrectPickaxeMaterial (block, registry) {
  if (block?.material !== 'incorrect_for_wooden_tool' || !block.harvestTools || !registry?.items) return false
  return Object.keys(block.harvestTools).some(id => registry.items[id]?.name?.endsWith('_pickaxe'))
}

function installToolSpeedContract (bot, state) {
  const tool = bot.tool
  if (!tool || typeof tool !== 'object' || state.wrappedTools.has(tool)) return
  state.wrappedTools.add(tool)
  for (const method of ['getDigTime', 'equipForBlock', 'isBetterMiningTool']) {
    if (typeof tool[method] !== 'function') continue
    const original = tool[method]
    tool[method] = function (block, ...args) {
      return original.call(this, state.decorateBlock(block), ...args)
    }
  }
}

function isSpecialMovement (bot) {
  if (bot.game?.gameMode === 'creative' || bot.entity?.isInWater) return true
  const position = bot.entity?.position
  if (!position || !bot.blockAt) return false
  const feet = bot.blockAt(position.floored?.() ?? position)
  const eyes = bot.blockAt(position.offset?.(0, bot.entity.eyeHeight ?? 1.62, 0))
  return SPECIAL_MOVEMENT_BLOCKS.has(feet?.name) || SPECIAL_MOVEMENT_BLOCKS.has(eyes?.name)
}

function waitForGround (bot, timeoutMs, state) {
  if (bot.entity?.onGround || isSpecialMovement(bot)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      bot.removeListener('physicsTick', onPhysicsTick)
      bot.removeListener('death', onDeath)
      bot.removeListener('end', onEnd)
    }
    const finish = error => {
      if (settled) return
      settled = true
      cleanup()
      if (state.cancelGroundWait === cancel) state.cancelGroundWait = null
      error ? reject(error) : resolve()
    }
    const cancel = () => finish(new Error('Digging aborted while waiting for ground contact'))
    const onPhysicsTick = () => {
      if (bot.entity?.onGround || isSpecialMovement(bot)) finish()
    }
    const onDeath = () => finish(new Error('Bot died while waiting to land'))
    const onEnd = () => finish(new Error('Bot ended while waiting to land'))
    bot.on('physicsTick', onPhysicsTick)
    bot.on('death', onDeath)
    bot.on('end', onEnd)
    state.cancelGroundWait = cancel
    timer = setTimeout(() => finish(new Error('Timed out waiting for ground contact')), timeoutMs)
    onPhysicsTick()
  })
}

function freshTargetBlock (bot, block) {
  const current = bot.blockAt(block.position)
  if (!current || current.type !== block.type || current.type === 0) {
    throw new Error(`Target block changed before digging at ${block.position}`)
  }
  return current
}

function installStopContract (bot, state) {
  let savedTarget = null
  let savedFace = null
  const wrapStop = original => function (...args) {
    const active = state.activeDig
    if (active?.serverConfirmed && active.startedAt != null) return
    state.cancelGroundWait?.()
    if (active) {
      active.cancelled = true
      active.cancelLookAt?.(new Error('Digging aborted while turning to the block'))
    }
    if (active && !active.serverConfirmed && !bot.targetDigBlock && savedTarget &&
        samePosition(savedTarget.position, active.position)) {
      bot.targetDigBlock = savedTarget
      bot.targetDigFace = savedFace
    }
    try {
      return original.apply(this, args)
    } finally {
      savedTarget = null
      savedFace = null
    }
  }
  let stopDigging = wrapStop(bot.stopDigging)

  Object.defineProperty(bot, 'stopDigging', {
    configurable: true,
    enumerable: true,
    get: () => stopDigging,
    set: next => {
      if (bot.targetDigBlock) {
        savedTarget = bot.targetDigBlock
        savedFace = bot.targetDigFace
      }
      stopDigging = wrapStop(next)
    }
  })

  bot.on('end', () => {
    if (state.activeDig) bot.stopDigging()
  })
}

function installDigContract (bot, state, options) {
  const originalBlockAt = bot.blockAt
  const decoratedBlocks = new WeakSet()
  const decorateBlock = block => {
    if (!block || typeof block !== 'object' || decoratedBlocks.has(block)) return block
    decoratedBlocks.add(block)
    if (shouldCorrectPickaxeMaterial(block, bot.registry)) block.material = 'mineable/pickaxe'
    return block
  }
  state.decorateBlock = decorateBlock
  if (typeof originalBlockAt === 'function') {
    bot.blockAt = function (...args) {
      const block = originalBlockAt.apply(this, args)
      return decorateBlock(block)
    }
  }

  if (typeof bot.digTime === 'function') {
    const originalDigTime = bot.digTime
    bot.digTime = function (block, ...args) { return originalDigTime.call(this, decorateBlock(block), ...args) }
  }
  if (bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function') {
    const bestHarvestTool = bot.pathfinder.bestHarvestTool
    bot.pathfinder.bestHarvestTool = function (block, ...args) { return bestHarvestTool.call(this, decorateBlock(block), ...args) }
  }
  installToolSpeedContract(bot, state)
  // collectblock defers its mineflayer-tool plugin until the next timer turn.
  setTimeout(() => installToolSpeedContract(bot, state), 0)

  const originalUpdateBlockState = bot._updateBlockState
  if (typeof originalUpdateBlockState === 'function') {
    bot._updateBlockState = function (position, stateId, ...args) {
      const active = state.activeDig
      if (active && stateId === 0 && samePosition(position, active.position)) {
        active.inferredAir = true
        return
      }
      return originalUpdateBlockState.call(this, position, stateId, ...args)
    }
  }

  const originalClientWrite = bot._client?.write
  if (typeof originalClientWrite === 'function') {
    bot._client.write = function (name, packet, ...args) {
      const active = state.activeDig
      if (name === 'block_dig' && packet?.status === 0 && active && samePosition(packet.location, active.position)) {
        if (active.cancelled) throw new Error('Digging aborted before start packet')
        if (active.timer) clearTimeout(active.timer)
        active.startedAt = Date.now()
        active.deadline = active.startedAt + active.expectedDigMs + options.confirmationGraceMs
        active.timer = setTimeout(() => {
          active.timedOut = true
          bot.stopDigging()
        }, Math.max(0, active.deadline - Date.now()))
      }
      return originalClientWrite.call(this, name, packet, ...args)
    }
  }

  const originalDig = bot.dig
  if (typeof originalDig !== 'function') return
  bot.dig = async function (block, forceLook, digFace) {
    if (!block?.position) throw new Error('dig requires a block with a position')
    if (bot.interrupt_code) throw new Error('Digging aborted by interrupt')
    if (state.activeDig) bot.stopDigging()

    if (!bot.entity?.onGround && !isSpecialMovement(bot)) {
      await waitForGround(bot, options.groundTimeoutMs, state)
    }
    if (bot.interrupt_code) throw new Error('Digging aborted by interrupt')
    block = decorateBlock(freshTargetBlock(bot, block))
    if (bot.interrupt_code) throw new Error('Digging aborted by interrupt')
    if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) throw new Error(`Block out of digging range: ${block.position}`)
    if (typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(block)) throw new Error(`Block is not visible: ${block.position}`)

    const expectedDigMs = bot.digTime(block)
    if (!Number.isFinite(expectedDigMs)) throw new Error(`Cannot dig ${block.name} with the current tool`)
    const operation = {
      block,
      position: { x: block.position.x, y: block.position.y, z: block.position.z },
      startedAt: null,
      expectedDigMs,
      deadline: null,
      inferredAir: false,
      serverConfirmed: false,
      cancelled: false,
      waitingForLookAt: false,
      cancelLookAt: null,
      timer: null
    }
    let rejectLookAt
    operation.lookCancelPromise = new Promise((_, reject) => { rejectLookAt = reject })
    operation.lookCancelPromise.catch(() => {})
    operation.cancelLookAt = error => rejectLookAt(error)
    state.activeDig = operation
    const eventName = `blockUpdate:${block.position}`
    const onGlobalServerUpdate = (oldBlock, newBlock) => {
      if (newBlock?.type === 0 && samePosition(oldBlock?.position, operation.position)) {
        if (operation.startedAt == null) {
          operation.cancelled = true
          operation.cancelLookAt?.(new Error('Target block changed before dig start'))
        } else {
          operation.serverConfirmed = true
        }
      }
    }
    const onServerUpdate = (_oldBlock, newBlock) => {
      if (newBlock?.type === 0 && operation.startedAt != null) operation.serverConfirmed = true
    }
    bot.prependListener('blockUpdate', onGlobalServerUpdate)
    bot.on(eventName, onServerUpdate)

    try {
      const originalLookAt = bot.lookAt
      if (typeof originalLookAt === 'function') {
        bot.lookAt = function (...args) {
          operation.waitingForLookAt = true
          const lookTimer = setTimeout(() => {
            operation.cancelled = true
            operation.cancelLookAt(new Error('Timed out turning to the block'))
          }, options.lookTimeoutMs)
          return Promise.race([
            Promise.resolve(originalLookAt.apply(this, args)),
            operation.lookCancelPromise
          ]).finally(() => {
            clearTimeout(lookTimer)
            operation.waitingForLookAt = false
            operation.cancelLookAt = null
          })
        }
      }
      let digPromise
      try {
        digPromise = originalDig.call(bot, block, forceLook, digFace)
      } finally {
        if (typeof originalLookAt === 'function') bot.lookAt = originalLookAt
      }
      try {
        return await digPromise
      } catch (error) {
        if (operation.timedOut) throw new Error(`Server did not confirm digging ${block.name} before its deadline`, { cause: error })
        throw error
      }
    } finally {
      clearTimeout(operation.timer)
      bot.removeListener('blockUpdate', onGlobalServerUpdate)
      bot.removeListener(eventName, onServerUpdate)
      if (state.activeDig === operation) state.activeDig = null
    }
  }
}

export function installMiningSync (bot, config = {}) {
  if (!bot || (typeof bot !== 'object' && typeof bot !== 'function')) throw new TypeError('A bot instance is required')
  if (installedBots.has(bot)) return installedBots.get(bot)

  const options = {
    groundTimeoutMs: config.groundTimeoutMs ?? DIG_GROUND_TIMEOUT_MS,
    lookTimeoutMs: config.lookTimeoutMs ?? DIG_LOOK_TIMEOUT_MS,
    confirmationGraceMs: config.confirmationGraceMs ?? DIG_CONFIRMATION_GRACE_MS
  }
  if (!Number.isFinite(options.groundTimeoutMs) || options.groundTimeoutMs <= 0 ||
      !Number.isFinite(options.lookTimeoutMs) || options.lookTimeoutMs <= 0 ||
      !Number.isFinite(options.confirmationGraceMs) || options.confirmationGraceMs <= 0) {
    throw new RangeError('Mining timeouts must be positive finite numbers')
  }
  const state = { activeDig: null, wrappedTools: new WeakSet() }
  installStopContract(bot, state)
  installDigContract(bot, state, options)
  installGotoContract(bot)
  installedBots.set(bot, state)
  return state
}

export function miningSyncPlugin (bot) {
  installMiningSync(bot)
}

export function getMiningState (bot) {
  const operation = installedBots.get(bot)?.activeDig
  if (!operation) return null
  return {
    target: { ...operation.position },
    startedAt: operation.startedAt,
    expectedDigMs: operation.expectedDigMs,
    deadline: operation.deadline,
    inferredAir: operation.inferredAir,
    serverConfirmed: operation.serverConfirmed
  }
}
