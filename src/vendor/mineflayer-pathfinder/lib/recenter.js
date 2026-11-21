const { Vec3 } = require('vec3')

// Where fullStop may recentre the bot: the centre of its floored column, unless the bot is on
// the ground and that column has no supporting block. A sneaking bot mid-bridge stands with its
// floored column over air; recentring moved it there and dropped it into a ravine
// (mindcraft-qa obstacle-recovery, 2026-11-21: three falls from y=69).
function recenterTarget (blockAt, position, onGround) {
  const x = Math.floor(position.x) + 0.5
  const z = Math.floor(position.z) + 0.5
  if (onGround && blockAt(new Vec3(x, position.y - 1, z).floored())?.boundingBox !== 'block') return null
  return { x, z }
}

module.exports = { recenterTarget }
