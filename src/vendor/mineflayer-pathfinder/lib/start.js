const { Vec3 } = require('vec3')

// Half the player's hitbox width. A sneaking bot can stand with the column under its
// position over air while its hitbox still rests on a neighbouring block.
const HALF_WIDTH = 0.3

const supports = (blockAt, column) => blockAt(column.offset(0, -1, 0))?.boundingBox === 'block'

// Column a search should start from: the floored position, unless the bot is on the ground
// over air there, then the nearest column under its hitbox that holds it up. Starting over air
// made the pathfinder centre the bot in that column and drop it into a ravine mid-bridge
// (mindcraft-qa obstacle-recovery, 2026-11-21).
function standingColumn (blockAt, position, onGround) {
  const floored = position.floored()
  if (!onGround || supports(blockAt, floored) || blockAt(floored)?.boundingBox === 'block') return floored
  let best = null
  let bestDistance = Infinity
  for (const dx of [-HALF_WIDTH, HALF_WIDTH]) {
    for (const dz of [-HALF_WIDTH, HALF_WIDTH]) {
      const column = new Vec3(position.x + dx, position.y, position.z + dz).floored()
      if (column.equals(floored) || !supports(blockAt, column)) continue
      const distance = Math.hypot(column.x + 0.5 - position.x, column.z + 0.5 - position.z)
      if (distance < bestDistance) { best = column; bestDistance = distance }
    }
  }
  return best ?? floored
}

module.exports = { standingColumn }
