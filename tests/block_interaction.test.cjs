'use strict'

// Real installed block shapes, world raycast and native digging; fixture-only
// packets and authoritative air events, no Minecraft server or world writes.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtemp, mkdir, readFile, writeFile, symlink, rm } = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { moduleRoot } = require('./dependency_root.cjs')
const repo = path.resolve(__dirname, '..')
const deps = moduleRoot()
const req = createRequire(path.join(deps, 'package.json'))
const Vec3 = req('vec3').Vec3
const registry = req('prismarine-registry')('1.21.1')
const Block = req('prismarine-block')(registry)
const WorldSync = req('prismarine-world/src/worldsync')
const injectDigging = req('mineflayer/lib/plugins/digging')
const target = new Vec3(0, 65, 0)
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function setup(root) {
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
  await symlink(deps, path.join(root, 'node_modules'))
  await writeFile(path.join(root, 'settings.js'), 'export default { navigation_stall_timeout_ms: 300, navigation_check_interval_ms: 25 };')
  await mkdir(path.join(root, 'src/agent/library'), { recursive: true })
  await writeFile(path.join(root, 'src/agent/settings.js'), 'export default {};')
  for(const name of ['block_interaction', 'mining_sync', 'skills', 'block_placement', 'crafting_sync', 'operation_context', 'world']) {
    await writeFile(path.join(root, `src/agent/library/${name}.js`), await readFile(path.join(repo, `src/agent/library/${name}.js`)))
  }
  await mkdir(path.join(root, 'src/utils'), { recursive: true })
  await writeFile(path.join(root, 'src/utils/mcdata.js'), 'export const getBlockId=()=>1; export const getItemId=()=>1;')
}

function scene({ feet = new Vec3(-2.9, 64, -2.1), name = 'spruce_log', obstruction = true } = {}) {
  const bot = new EventEmitter()
  bot.registry = registry; bot.version = '1.21.1'; bot.output = ''; bot.interrupt_code = false
  bot.entity = { id: 1, position: feet.clone(), eyeHeight: 1.62, onGround: true, effects: {}, isInWater: false, yaw: 0, pitch: 0 }
  bot.game = { gameMode: 'survival', dimension: 'overworld', minY: 60 }
  bot.modes = { isOn:()=>false, pause(){}, unpause(){} }
  bot.inventory = { slots: [], items: () => [] }; bot.heldItem = null
  bot.getEquipmentDestSlot = () => 5; bot.getControlState = () => false
  bot.blocks = new Map(); bot.missing = new Set(); bot.aims = []; bot.packets = []; bot.moves = []
  bot.put = (p, blockName, stateId = registry.blocksByName[blockName].defaultState) => {
    const block = Block.fromStateId(stateId, 0); block.position = p.floored()
    bot.blocks.set(key(p), block); return block
  }
  bot.put(target, name)
  if(obstruction) bot.put(new Vec3(-2, 65, -1), 'stone')
  bot.blockAt = p => {
    const pos = p.floored()
    if(bot.missing.has(key(pos)) || bot.unknownPlane === pos.x) return null
    if(bot.blocks.has(key(pos))) return bot.blocks.get(key(pos))
    const block = Block.fromStateId(registry.blocksByName[pos.y < 64 ? 'grass_block' : 'air'].defaultState, 0)
    block.position = pos; return block
  }
  bot.world = { getBlock: p=>bot.blockAt(p), raycast: WorldSync.prototype.raycast }
  bot.canSeeBlock = block => {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
    const delta = block.position.offset(.5, .5, .5).minus(eye)
    return bot.world.raycast(eye, delta.scaled(1/delta.norm()), delta.norm()+.01)?.position.equals(block.position) || false
  }
  bot.lookAt = async point => {
    bot.aims.push(point.clone())
    const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0)).normalize()
    bot.entity.yaw = Math.atan2(-delta.x, -delta.z); bot.entity.pitch = Math.asin(delta.y)
    await bot.onLook?.(point)
  }
  bot.tool = { equipForBlock: async () => {} }; bot.equip = async()=>{}
  bot.swingArm = () => {}; bot._updateBlockState = ()=>{}
  bot._client = new EventEmitter()
  bot._client.write = (name, packet) => {
    bot.packets.push({ name, ...packet })
    if(name==='block_dig' && packet.status===0) {
      setTimeout(() => {
        const old = bot.blockAt(packet.location)
        const air = bot.put(packet.location, 'air')
        bot.emit('blockUpdate', old, air)
        bot.emit(`blockUpdate:${packet.location}`, old, air)
      }, 5)
    }
  }
  bot.pathfinder = { movements: { original:true }, setMovements(m){ this.movements=m },
    bestHarvestTool:()=>null, getPathTo:()=>({status:'success'}),
    async goto(goal) {
      bot.moves.push(goal)
      assert.equal(this.movements.canDig,false); assert.equal(this.movements.canPlaceOn,false)
      assert.equal(this.movements.allow1by1towers,false)
      if(bot.onGoto) await bot.onGoto(goal)
      else bot.entity.position=new Vec3(.5,64,-2.5)
    }, stop(){} }
  injectDigging(bot)
  bot.digTime = ()=>1000
  return bot
}

function centerRay(bot, block = bot.blockAt(target)) {
  const eye=bot.entity.position.offset(0,bot.entity.eyeHeight,0)
  const delta=block.position.offset(.5,.5,.5).minus(eye)
  return bot.world.raycast(eye,delta.scaled(1/delta.norm()),delta.norm()+.01)
}
function visibleFaceCenters(bot) {
  const eye=bot.entity.position.offset(0,bot.entity.eyeHeight,0), hits=[]
  for(const axis of ['x','y','z']) {
    if(eye[axis]>=target[axis] && eye[axis]<=target[axis]+1) continue
    const aim=target.offset(.5,.5,.5); aim[axis]=target[axis]+(eye[axis]<target[axis] ? 0 : 1)
    const hit=bot.world.raycast(eye,aim.minus(eye).normalize(),4.5)
    if(hit?.position.equals(target)) hits.push(hit)
  }
  return hits
}
const starts = bot=>bot.packets.filter(p=>p.name==='block_dig' && p.status===0)

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(),'mc-block-interaction-'))
  try {
    await setup(root)
    const load=name=>import(pathToFileURL(path.join(root,`src/agent/library/${name}.js`)))
    const helper=await load('block_interaction'), mining=await load('mining_sync'), skills=await load('skills'), world=await load('world')
    const install=bot=>mining.installMiningSync(bot,{lookTimeoutMs:80,confirmationGraceMs:100})

    for(const [kind,feet] of [['face-center',new Vec3(-2.9,64,-2.9)],['face-edge',new Vec3(-2.9,64,-2.1)]]) {
      const bot=scene({feet}); install(bot)
      assert.equal(centerRay(bot).name,'stone','the geometric center ray is actually obstructed')
      assert.equal(bot.canSeeBlock(bot.blockAt(target)),false)
      assert.equal(visibleFaceCenters(bot).length>0,kind==='face-center','distinguish visible face center from edge-only visibility')
      const hit=helper.resolveBlockInteraction(bot,bot.blockAt(target))
      assert.equal(hit.status,'ready',JSON.stringify(hit)); assert.ok(hit.distance<=4.5)
      const goal=helper.makeBlockInteractionGoal(bot,target)
      if(kind==='face-center') assert.equal(goal.isEnd(bot.entity.position.floored()),true)
      const before=bot.moves.length
      const ready=await skills.approachBlock(bot,target.x,target.y,target.z)
      assert.equal(ready.status,'ready'); assert.equal(ready.target.visible,false)
      assert.equal(ready.target.interaction.status,'ready'); assert.equal(bot.moves.length,before)
      assert.equal(world.inspectBlockAt(bot,...[target.x,target.y,target.z]).interaction.status,'ready')
      assert.equal(await skills.breakBlockAt(bot,target.x,target.y,target.z),true)
      assert.equal(starts(bot).length,1); assert.equal(starts(bot)[0].face,hit.face)
      assert.ok(bot.aims.at(-1).distanceTo(hit.aim)<1e-6,'native dig uses the admitted surface point')
      assert.equal(bot.blockAt(target).name,'air','authoritative fixture air confirmation')
      assert.equal(bot.blockAt(new Vec3(-2,65,-1)).name,'stone','the obstruction remains untouched')
    }

    // Replay the seven terrain failures relative to this fixture's target.
    // Native's old center-distance check rejects these reachable surfaces.
    const terrainFeet = [
      [-3.5531157024254, 3.55311570242446],
      [-3.431877594824066, 3.58253709182867],
      [-3.431877594824066, 3.58253709182867],
      [-3.5062528111458, -2.6334590842377],
      [3.43538048867953, -3.65512355809363],
      [3.66249222741452, -3.4746690894932],
      [-3.51078896258648, -2.5665570380773]
    ]
    for (const [x,z] of terrainFeet) {
      const bot=scene({feet:new Vec3(x,target.y,z),name:'dirt',obstruction:false})
      assert.equal(bot.canDigBlock(bot.blockAt(target)),false,'old native center check rejects the target')
      install(bot)
      const hit=helper.resolveBlockInteraction(bot,bot.blockAt(target))
      assert.equal(hit.status,'ready'); assert.ok(hit.distance<=helper.BLOCK_INTERACTION_REACH)
      const observed=world.inspectBlockAt(bot,target.x,target.y,target.z)
      const before=bot.moves.length
      assert.equal((await skills.approachBlock(bot,target.x,target.y,target.z)).status,'ready')
      assert.equal(await skills.breakBlockAt(bot,target.x,target.y,target.z),true)
      assert.equal(observed.canDig,true,'public dig admission matches the surface resolver')
      assert.equal(bot.moves.length,before,'a reachable surface needs no extra approach')
      assert.equal(starts(bot).length,1); assert.equal(starts(bot)[0].face,hit.face)
      assert.equal(bot.blockAt(target).name,'air')
    }

    {
      const bot=scene({feet:new Vec3(-4.55,64,.5),obstruction:false})
      assert.equal(bot.canDigBlock(bot.blockAt(target)),true,'old center allowance extends past the SDK surface reach')
      install(bot)
      assert.equal(bot.canDigBlock(bot.blockAt(target)),false,'surface reach remains bounded at 4.5')
      await assert.rejects(bot.dig(bot.blockAt(target),true),/not visible/)
      assert.equal(starts(bot).length,0)
    }

    // Real slab and fence selection shapes, including a partial-height blocker.
    for(const name of ['stone_slab','oak_fence']) {
      const bot=scene({name,obstruction:false,feet:new Vec3(-2.5,64,.5)}); install(bot)
      const hit=helper.resolveBlockInteraction(bot,bot.blockAt(target))
      assert.equal(hit.status,'ready',name)
      assert.ok(bot.blockAt(target).shapes.some(shape=>hit.aim.x>=shape[0] && hit.aim.x<=shape[3] &&
        hit.aim.y-target.y>=shape[1] && hit.aim.y-target.y<=shape[4] && hit.aim.z>=shape[2] && hit.aim.z<=shape[5]))
      await bot.dig(bot.blockAt(target),true)
      assert.equal(starts(bot).length,1); assert.equal(starts(bot)[0].face,hit.face)
      assert.ok(bot.aims.at(-1).distanceTo(hit.aim)<1e-6)
    }
    {
      const bot=scene({feet:new Vec3(-2.9,64,-2.1)}); bot.put(new Vec3(-2,65,-1),'stone_slab')
      const direction=target.offset(.5,.5,.5).minus(bot.entity.position.offset(0,bot.entity.eyeHeight,0))
      assert.equal(helper.resolveBlockInteraction(bot,bot.blockAt(target),{direction}).status,'ready','the center ray passes above a partial-height blocker')
      bot.put(new Vec3(-2,65,-1),'stone')
      assert.equal(helper.resolveBlockInteraction(bot,bot.blockAt(target),{direction}).status,'blocked','the same ray is blocked by a full cube')
    }

    // Shapeless diggable plants retain native eligibility. The upper half
    // of tall grass can contain the eye without becoming an opaque collider.
    for(const name of ['short_grass','tall_grass']) {
      const inside=name==='tall_grass'
      const bot=scene({name,obstruction:false,feet:inside?new Vec3(.5,64,.5):new Vec3(-2.5,64,.5)}); install(bot)
      if(inside) {
        const upper=Block.fromProperties(registry.blocksByName.tall_grass.id,{half:'upper'},0)
        bot.put(target,name,upper.stateId)
        assert.equal(bot.blockAt(target).getProperties().half,'upper')
      }
      assert.equal(bot.blockAt(target).shapes.length,0)
      const hit=helper.resolveBlockInteraction(bot,bot.blockAt(target))
      assert.equal(hit.status,'ready',`${name}: ${JSON.stringify(hit)}`)
      await bot.dig(bot.blockAt(target),true)
      assert.equal(starts(bot).length,1,`${name}: native digging starts`)
      assert.equal(bot.blockAt(target).name,'air')
    }

    for(const mode of ['enclosed','unknown-target','unknown-ray','range','interrupt','changed-type','changed-state','blocked-after-look','cancel-look']) {
      const bot=scene({obstruction:false}); install(bot)
      const original=bot.blockAt(target)
      if(mode==='enclosed') for(let x=-1;x<=1;x++) for(let y=64;y<=67;y++) for(let z=-1;z<=1;z++) {
        if(Math.abs(x)===1 || Math.abs(z)===1 || y===64 || y===67) bot.put(new Vec3(x,y,z),'stone')
      }
      if(mode==='unknown-target') bot.missing.add(key(target))
      if(mode==='unknown-ray') bot.unknownPlane=-1
      if(mode==='range') bot.entity.position=new Vec3(-10,64,0)
      if(mode==='interrupt') bot.interrupt_code=true
      if(mode==='changed-type') bot.onLook=()=>bot.put(target,'stone')
      if(mode==='changed-state') bot.onLook=()=>bot.put(target,'spruce_log',original.stateId===registry.blocksByName.spruce_log.minStateId ? original.stateId+1 : registry.blocksByName.spruce_log.minStateId)
      if(mode==='blocked-after-look') bot.onLook=()=>{
        const eye=bot.entity.position.offset(0,bot.entity.eyeHeight,0)
        bot.put(eye.floored(),'stone')
      }
      if(mode==='cancel-look') bot.onLook=()=>bot.stopDigging()
      await assert.rejects(bot.dig(original,true),/visible|range|changed|aborted|loaded/i,mode)
      assert.equal(starts(bot).length,0,`${mode}: no start packet`)
      assert.equal(mining.getMiningState(bot),null,`${mode}: owned state is cleared`)
      if(mode==='unknown-ray') assert.equal(helper.resolveBlockInteraction(bot,bot.blockAt(target)).status,'unknown')
    }

    // Ignore preserves the current ray contract, rather than choosing a visible
    // alternate point and silently bypassing the caller's actual crosshair.
    {
      const bot=scene({obstruction:false}); install(bot)
      await assert.rejects(bot.dig(bot.blockAt(target),'ignore'),/visible/)
      assert.equal(starts(bot).length,0)
      const hit=helper.resolveBlockInteraction(bot,bot.blockAt(target))
      await bot.lookAt(hit.aim)
      await bot.dig(bot.blockAt(target),'ignore')
      assert.equal(starts(bot).length,1); assert.equal(starts(bot)[0].face,hit.face)
    }

    // A plugin-reported completed route is rechecked using the actual eye and
    // latest block. This fixture intentionally does not model successful travel.
    for(const outcome of ['ready','unchanged','unloaded','changed']) {
      const bot=scene({feet:new Vec3(-8.5,64,.5),obstruction:false})
      bot.onGoto=()=>{
        if(outcome==='unchanged') return
        bot.entity.position=new Vec3(.5,64,-2.5)
        if(outcome==='unloaded') bot.missing.add(key(target))
        if(outcome==='changed') bot.put(target,'air')
      }
      const result=await skills.approachBlock(bot,target.x,target.y,target.z)
      assert.equal(result.status,outcome==='ready'?'ready':outcome==='unloaded'?'unknown':'blocked',outcome)
      assert.equal(bot.pathfinder.movements.original,true)
      assert.equal(bot.moves.length,1)
      if(outcome==='ready') assert.equal(bot.moves[0].isEnd(bot.entity.position.floored()),true)
      assert.equal(starts(bot).length,0)
    }
    await sleep(0)
    console.log('block interaction: seven terrain distance failures, geometric center/face/edge, real shapes/native digging, fresh guards, unknown/range/stop and actual-goal checks passed')
  } finally { await rm(root,{recursive:true,force:true}) }
}
main().catch(error=>{console.error(error);process.exitCode=1})
