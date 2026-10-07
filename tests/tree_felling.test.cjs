'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtemp, mkdir, readFile, writeFile, symlink, rm } = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { moduleRoot } = require('./dependency_root.cjs')
const repo = path.resolve(__dirname, '..')
const deps = moduleRoot()
const req = createRequire(path.join(deps, 'package.json'))
const Vec3 = req('vec3').Vec3
const registry = req('minecraft-data')('1.21.1')
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
async function write(root, file, content) {
  const target = path.join(root, file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}
async function setup(root) {
  await write(root, 'package.json', '{"type":"module"}')
  await symlink(deps, path.join(root, 'node_modules'))
  await write(root, 'settings.js', 'export default { navigation_stall_timeout_ms: 500, navigation_check_interval_ms: 50 };')
  for (const name of ['skills', 'block_placement', 'operation_context', 'crafting_sync', 'index']) {
    await write(root, `src/agent/library/${name}.js`, await readFile(path.join(repo, `src/agent/library/${name}.js`)))
  }
  await write(root, 'src/utils/mcdata.js', 'export const getBlockId = () => 1;')
  await write(root, 'src/agent/library/world.js', 'export function getNearestBlocksWhere(bot, predicate) { return [...bot.blocks.values()].filter(predicate).sort((a,b) => bot.entity.position.distanceTo(a.position)-bot.entity.position.distanceTo(b.position)); }')
}
function makeBot(height = 5, branched = false) {
  const bot = new EventEmitter()
  bot.registry = registry; bot.version = '1.21.1'; bot.output = ''; bot.interrupt_code = false
  bot.entity = { id: 1, position: new Vec3(1.5, 64, 0.5), onGround: true }
  bot.entities = {}; bot.blocks = new Map(); bot.mutations = []
  bot.put = (x,y,z,name) => {
    const p = new Vec3(x,y,z)
    bot.blocks.set(key(p), { name, type: registry.blocksByName[name].id, position:p, boundingBox:name.endsWith('air') ? 'empty':'block', getProperties:()=>({persistent:false}) })
  }
  bot.blockAt = p => bot.blocks.get(key(p)) || { name: Math.floor(p.y) < 64 ? 'grass_block':'air', type:Math.floor(p.y)<64 ? 9:0, position:p.floored(), boundingBox: Math.floor(p.y)<64 ? 'block':'empty' }
  for (let y=64; y<64+height; y++) bot.put(0,y,0,'oak_log')
  bot.put(0,64+height,0,'oak_leaves')
  if (branched) {
    for (let i=1;i<=4;i++) bot.put(i,64+height-4+i,0,'oak_log')
    bot.put(4,64+height+1,0,'oak_leaves')
    for(let x=-2;x<=5;x++) for(let y=64+height-4;y<=64+height+1;y++) for(let z=-2;z<=2;z++) {
      if(!bot.blocks.has(key(new Vec3(x,y,z)))) bot.put(x,y,z,'oak_leaves')
    }
  }
  const counts = { dirt:64 }
  bot.inventory = { slots:[], emptySlotCount:()=>30, items:()=>Object.entries(counts).filter(([,count])=>count>0).map(([name,count])=>({name,count,type:registry.itemsByName[name].id})) }
  bot.world = { raycast(origin,direction,distance) {
    for (let d=0;d<=distance;d+=0.05) {
      const block=bot.blockAt(origin.plus(direction.scaled(d)))
      if(block.name!=='air') return block
    }
    return null
  } }
  bot.canSeeBlock = block => {
    const eye=bot.entity.position.offset(0,1.62,0), delta=block.position.offset(.5,.5,.5).minus(eye)
    const hit=bot.world.raycast(eye,delta.scaled(1/delta.norm()),delta.norm())
    return !hit || key(hit.position)===key(block.position)
  }
  bot.canDigBlock = block => bot.entity.position.offset(0,1.62,0).distanceTo(block.position.offset(.5,.5,.5))<=4.5
  bot.lookAt=async()=>{}
  bot.tool = { equipForBlock:async()=>{} }; bot.equip = async item => { bot.heldItem=item }
  bot.setControlState = (state,value) => {
    if(state!=='jump') return
    if(value) { bot.entity.onGround=false; bot.entity.position.y+=1.1 }
    else if(!bot.entity.onGround) { bot.entity.position.y=Math.floor(bot.entity.position.y); bot.entity.onGround=true }
  }
  let nextId=10
  let deferredDrop=null
  bot.dig = async block => {
    bot.mutations.push(['dig',block.name,key(block.position)])
    bot.put(block.position.x,block.position.y,block.position.z,'air')
    if(block.name.endsWith('_leaves')) {
      if(bot.hangingDrop && key(block.position)===key(bot.hangingDrop.position.offset(0,-.1,0))) {
        const entity=bot.hangingDrop
        counts.oak_log=(counts.oak_log||0)+1; bot.emit('playerCollect',bot.entity,entity); delete bot.entities[entity.id]; bot.hangingDrop=null
      }
      return
    }
    const item={ name:block.name,count:1 }
    let entity={ id:nextId++, position:block.position.offset(.5,.5,.5), getDroppedItem:()=>item }
    if(bot.mergeDrops && !deferredDrop) {
      deferredDrop=entity; bot.entities[entity.id]=entity; bot.emit('itemDrop',entity); return
    }
    if(bot.mergeDrops && deferredDrop) {
      entity=deferredDrop; entity.getDroppedItem().count=2; bot.mergeDrops=false; deferredDrop=null
    }
    bot.entities[entity.id]=entity
    bot.emit('itemDrop',entity)
    if(bot.hangLastDrop && block.name==='oak_log' && block.position.y===64+height) {
      bot.hangLastDrop=false; bot.hangingDrop=entity; entity.position=new Vec3(-4.5,65+height,-1.5); bot.put(-5,64+height,-2,'oak_leaves'); return
    }
    if(bot.groundDrop && block.name==='oak_log' && block.position.y===63+height) {
      bot.groundDrop=false; entity.position=new Vec3(.548,64,3.875); return
    }
    counts[block.name]=(counts[block.name]||0)+entity.getDroppedItem().count
    bot.emit('playerCollect',bot.entity,entity)
    delete bot.entities[entity.id]
    if(bot.entity.position.y===block.position.y+1 && key(bot.entity.position.offset(0,-1,0))===key(block.position)) bot.entity.position.y--
    bot.afterDig?.(block)
  }
  bot.placeBlock = async (support,face) => {
    const p=support.position.plus(face)
    bot.mutations.push(['place',bot.heldItem.name,key(p)])
    bot.put(p.x,p.y,p.z,bot.heldItem.name)
    counts[bot.heldItem.name]--
    bot.afterPlace?.(p)
  }
  bot.pathfinder = { movements:{original:true},setMovements(m){this.movements=m},getPathTo:()=>({status:'success'}),async goto(goal){
    assert.equal(this.movements.canDig,false); assert.equal(this.movements.canPlaceOn,false); assert.equal(this.movements.allow1by1towers,false); assert.deepEqual(this.movements.scafoldingBlocks,[])
    if(goal.entity) {
      assert.equal(goal.constructor.name,'GoalFollow','pickup follows the item position, not a block corner')
      bot.entity.position=goal.entity.position.clone(); counts.oak_log=(counts.oak_log||0)+goal.entity.getDroppedItem().count
      bot.emit('playerCollect',bot.entity,goal.entity); delete bot.entities[goal.entity.id]
    } else bot.entity.position=new Vec3(goal.x+.5,goal.y,goal.z+.5)
    bot.entity.onGround=true
  },stop(){},setGoal(){} }
  return bot
}
async function main() {
  const root=await mkdtemp(path.join(os.tmpdir(),'mc-tree-felling-'))
  try {
    await setup(root)
    const {fellTree}=await import(pathToFileURL(path.join(root,'src/agent/library/skills.js')))
    const {getSkillDocs}=await import(pathToFileURL(path.join(root,'src/agent/library/index.js')))
    assert.ok(getSkillDocs().some(doc=>doc.startsWith('skills.fellTree\n') && doc.includes('tall branched oak')))
    for (const [height,branched] of [[5,false],[14,true]]) {
      const bot=makeBot(height,branched)
      const result=await fellTree(bot,{startPosition:{x:0,y:65,z:0}})
      assert.equal(result.status,'complete',JSON.stringify(result))
      assert.equal(result.logsBroken,height+(branched?4:0))
      assert.equal(result.logsCollected,result.logsBroken)
      assert.equal(result.scaffoldPlaced,result.scaffoldRemoved)
      assert.equal(result.scaffoldPlaced,result.scaffoldRecovered)
      assert.equal(result.grounded,true)
      assert.deepEqual(result.remainingLogs,[]); assert.deepEqual(result.leftoverScaffolds,[])
      if(branched) assert.ok(result.scaffoldPlaced>0)
      assert.equal(bot.listenerCount('itemDrop'),0); assert.equal(bot.listenerCount('playerCollect'),0)
    }
    let bot=makeBot(14,true)
    bot.hangLastDrop=true
    const canopyDrop=await fellTree(bot,{startPosition:{x:0,y:64,z:0}})
    assert.equal(canopyDrop.status,'complete',JSON.stringify(canopyDrop)); assert.equal(canopyDrop.logsCollected,18)
    assert.ok(bot.mutations.some(([op,name,position])=>op==='place' && position.startsWith('-5,')),'rebuild owned pillar for a distant canopy drop after logs are gone')
    bot=makeBot(5,false)
    bot.groundDrop=true
    const groundPickup=await fellTree(bot,{startPosition:{x:0,y:64,z:0}})
    assert.equal(groundPickup.status,'complete',JSON.stringify(groundPickup)); assert.equal(groundPickup.logsCollected,5)
    bot=makeBot(5,false)
    bot.mergeDrops=true
    const merged=await fellTree(bot,{startPosition:{x:0,y:64,z:0}})
    assert.equal(merged.status,'complete',JSON.stringify(merged)); assert.equal(merged.logsCollected,5,'merged item uses current metadata at pickup')
    bot=makeBot(14,true)
    bot.put(1,64,0,'oak_log')
    const ambiguous=await fellTree(bot,{startPosition:{x:0,y:64,z:0}})
    assert.match(ambiguous.reason,/multiple grounded trunks/); assert.equal(bot.mutations.length,0)
    bot=makeBot(14,true)
    bot.inventory.items=()=>[]
    assert.match((await fellTree(bot,{startPosition:{x:0,y:64,z:0}})).reason,/Bring at least/)
    assert.equal(bot.mutations.length,0)
    bot=makeBot(14,true)
    const blockAt=bot.blockAt
    bot.blockAt=p=>p.x===-1&&p.y===65&&p.z===0 ? null:blockAt(p)
    assert.match((await fellTree(bot,{startPosition:{x:0,y:64,z:0}})).reason,/not loaded/)
    assert.equal(bot.mutations.length,0)
    bot=makeBot(5,false)
    bot.afterDig=()=>{bot.interrupt_code=true}
    const cancelledDig=await fellTree(bot,{startPosition:{x:0,y:64,z:0}})
    assert.equal(cancelledDig.status,'cancelled'); assert.equal(cancelledDig.logsBroken,1); assert.equal(bot.mutations.length,1)
    bot=makeBot(14,true)
    bot.afterPlace=()=>{bot.interrupt_code=true}
    const cancelled=await fellTree(bot,{startPosition:{x:0,y:64,z:0}})
    assert.equal(cancelled.status,'cancelled'); assert.equal(cancelled.cleanupRequired,true)
    assert.equal(bot.mutations.at(-1)[0],'place','no cleanup dig after cancellation')
    bot=makeBot(14,true)
    let placements=0
    bot.afterPlace=()=>{if(++placements===2) throw new Error('fixture placement reply error')}
    const partial=await fellTree(bot,{startPosition:{x:0,y:64,z:0}})
    assert.equal(partial.status,'partial'); assert.equal(partial.cleanupRequired,false,JSON.stringify(partial))
    assert.equal(partial.scaffoldPlaced,partial.scaffoldRemoved); assert.equal(partial.grounded,true)
    console.log('tree felling: normal/tall branched oak, scope, confirmations, cleanup and cancellation passed')
  } finally { await rm(root,{recursive:true,force:true}) }
}
main().catch(error=>{console.error(error);process.exitCode=1})
