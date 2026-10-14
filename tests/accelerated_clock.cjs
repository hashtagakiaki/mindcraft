'use strict'

// Keep timeout-path coverage while avoiding wall-clock waits in offline fixtures.
async function withAcceleratedClock(callback, factor = 100) {
  const originalNow = Date.now
  const originalSetTimeout = global.setTimeout
  const realStart = originalNow()
  Date.now = () => realStart + (originalNow() - realStart) * factor
  global.setTimeout = (callback, milliseconds, ...args) => originalSetTimeout(
    callback,
    Math.max(1, Math.ceil(Number(milliseconds) / factor)),
    ...args
  )
  try {
    return await callback()
  } finally {
    Date.now = originalNow
    global.setTimeout = originalSetTimeout
  }
}

module.exports = { withAcceleratedClock }
