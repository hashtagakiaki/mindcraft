// Predicts how long the bot needs to reach the pathfinder's next node, using
// the pathfinder's own Physics.simulateUntil (prismarine-physics) from the
// current state. Navigation only uses the prediction to request one early
// replan of the same goal; it never decides a navigation failure.
//
// lib/physics is not part of mineflayer-pathfinder's public exports; the
// dependency is pinned (2.4.5) and read-only.
import Physics from '../../vendor/mineflayer-pathfinder/lib/physics.js'
import prismarinePhysics from 'prismarine-physics'

const { PlayerState } = prismarinePhysics

export const PREDICTION_HORIZON_TICKS = 80
const TICK_MS = 50
const CONTROL_NAMES = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

// Matches the pathfinder's own arrival test for the next node.
function reachedNode (state, next) {
  return Math.abs(next.x - state.pos.x) <= 0.175 && Math.abs(next.z - state.pos.z) <= 0.175 && Math.abs(next.y - state.pos.y) < 1
}

function cloneState (state) {
  return Object.assign(Object.create(Object.getPrototypeOf(state)), state,
    { pos: state.pos.clone(), vel: state.vel.clone(), control: { ...state.control } })
}

function simulate (physics, next, initial, controls, jumpAfter = 0) {
  let ticks = 0
  let reached = false
  physics.simulateUntil(state => {
    ticks++
    reached = reachedNode(state, next)
    return reached
  }, state => {
    state.yaw = Math.atan2(-(next.x - state.pos.x), -(next.z - state.pos.z))
    Object.assign(state.control, controls)
    state.control.jump = controls.jump && ticks >= jumpAfter
    if (state.isInWater || state.isInLava) {
      state.control.jump = true
      state.control.sprint = false
    }
  }, PREDICTION_HORIZON_TICKS, cloneState(initial))
  return reached ? ticks * TICK_MS : null
}

export function navigationPredictionPlugin (bot) {
  let physics = null
  bot.navigationPrediction = {
    // Milliseconds to the next node with the current input, else the first of
    // the pathfinder's walk/sprint and immediate/delayed jump inputs that
    // reaches it; null when none reaches it within the horizon.
    segmentMs (next) {
      physics ??= new Physics(bot)
      const current = Object.fromEntries(CONTROL_NAMES.map(name => [name, bot.getControlState(name)]))
      const initial = new PlayerState(bot, current)
      const currentMs = simulate(physics, next, initial, current)
      if (currentMs != null) return currentMs
      for (const sprint of [true, false]) {
        for (const jump of [false, true]) {
          for (const jumpAfter of jump ? [0, 1, 2, 3, 4, 5, 6] : [0]) {
            const controls = { forward: true, back: false, left: false, right: false, jump, sprint, sneak: false }
            const ms = simulate(physics, next, initial, controls, jumpAfter)
            if (ms != null) return ms
          }
        }
      }
      return null
    }
  }
}
