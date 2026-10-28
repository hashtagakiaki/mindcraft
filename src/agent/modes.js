import { randomUUID } from 'node:crypto';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'

const meleeMobs = new Set(['zombie', 'husk', 'zombie_villager', 'drowned', 'spider']);
// Retreat only from threats that endanger the bot now; distant creepers and
// ranged mobs that are merely visible would otherwise cancel every action.
const CREEPER_RETREAT_DISTANCE = 7;
const RANGED_RETREAT_DAMAGE_MS = 3000;
// Melee mobs are imminent at the same range self_defense engages them.
const MELEE_RETREAT_DISTANCE = 8;
// A melee enemy this close can hit the bot within a step or two.
const CORNERED_FIGHT_DISTANCE = 3;
const RANGED_RETREAT_HEALTH = 10;
const failedRetreats = new WeakMap();
const terrainRevisions = new WeakMap();

// A failed retreat is retried after the bot moves, the terrain changes, it takes
// new damage, or a different set of enemies appears. Enemy positions and
// regenerating health are excluded: they change every tick, which turned one
// failed retreat into a retry loop.
function encounterKey(bot, enemies) {
    const cell = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
    return `${cell(bot.entity.position)}:${terrainRevisions.get(bot) ?? 0}:${bot.lastDamageTime}:` +
        enemies.map(enemy => enemy.id).sort().join(';');
}

function imminentThreats(bot, enemies) {
    const recentlyDamaged = Number.isFinite(bot.lastDamageTime) && Date.now() - bot.lastDamageTime <= RANGED_RETREAT_DAMAGE_MS;
    return enemies.filter(enemy => {
        if (enemy.name === 'creeper') return bot.entity.position.distanceTo(enemy.position) <= CREEPER_RETREAT_DISTANCE;
        if (world.isRangedThreat(enemy)) return recentlyDamaged || bot.health < RANGED_RETREAT_HEALTH;
        return bot.entity.position.distanceTo(enemy.position) <= MELEE_RETREAT_DISTANCE;
    });
}

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

function modeObservation(bot) {
    const position = bot?.entity?.position;
    return {
        position: position && [position.x, position.y, position.z].every(Number.isFinite)
            ? { x: position.x, y: position.y, z: position.z } : null,
        health: Number.isFinite(bot?.health) ? bot.health : null,
        food: Number.isFinite(bot?.food) ? bot.food : null,
        isInWater: bot?.entity?.isInWater === true,
        lastDamageAgeMs: Number.isFinite(bot?.lastDamageTime) && bot.lastDamageTime > 0 ? Math.max(0, Date.now() - bot.lastDamageTime) : null,
        lastDamageTaken: Number.isFinite(bot?.lastDamageTaken) ? bot.lastDamageTaken : null,
    };
}

function entityEvidence(bot, entity) {
    if (!entity) return null;
    const position = entity.position;
    const botPosition = bot?.entity?.position;
    const validPosition = position && [position.x, position.y, position.z].every(Number.isFinite);
    const name = entity.type === 'player' ? 'player' : typeof entity.name === 'string' ? entity.name.slice(0, 80) : null;
    return { id: Number.isSafeInteger(entity.id) ? entity.id : null, name,
        type: typeof entity.type === 'string' ? entity.type.slice(0, 40) : null,
        position: validPosition ? { x: position.x, y: position.y, z: position.z } : null,
        distance: validPosition && botPosition ? botPosition.distanceTo(position) : null };
}

function modeDecision(mode, bot, reason, { target, ...evidence } = {}) {
    return { sourceMode: mode.name, reason, observed: modeObservation(bot),
        ...(target ? { target: entityEvidence(bot, target) } : {}), ...evidence };
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            if (blockAbove.name === 'water') {
                // does not call execute so does not interrupt other actions
                if (!bot.pathfinder.goal) {
                    bot.setControlState('jump', true);
                }
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                }, -1, modeDecision(this, bot, 'falling_block_overhead', { block: blockAbove.name }));
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    }, -1, modeDecision(this, bot, 'fire_or_lava_with_bucket', { block: block.name, blockAbove: blockAbove.name }));
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    }, -1, modeDecision(this, bot, 'fire_or_lava_seek_water', { block: block.name, blockAbove: blockAbove.name }));
                }
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                say(agent, 'I\'m dying!');
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                }, -1, modeDecision(this, bot, 'recent_damage_critical_health', { damageAgeMs: modeObservation(bot).lastDamageAgeMs,
                    damageTaken: bot.lastDamageTaken }));
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from dangerous encounters (creepers within 7 blocks; melee mobs within 8 blocks; visible ranged mobs only after recent damage or below 10 health); let self-defense handle unarmed ground melee enemies when healthy and able to sprint. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const bot = agent.bot;
            const enemies = imminentThreats(bot, await world.getNearbyThreats(bot, 16));
            const enemy = enemies[0];
            if (!enemy) {
                failedRetreats.delete(bot);
                return;
            }
            const maxEnemies = bot.health >= 20 ? 3 : 1;
            const groundMelee = enemies.length > 0 && enemies.length <= maxEnemies && enemies.every(opponent => {
                const block = meleeMobs.has(opponent.name) ? bot.blockAt(opponent.position) : null;
                return block && !opponent.heldItem && !['water', 'lava', 'bubble_column'].includes(block.name);
            });
            // One shared encounter rule, independent of this bot's equipment or
            // the opponents' age. Poison, ranged weapons and water remain risks.
            if (modes_map.self_defense.on && !modes_map.self_defense.paused &&
                groundMelee && !bot.entity.isInWater &&
                bot.health >= 10 && bot.food > 6) return;
            if (enemy && failedRetreats.get(bot) !== encounterKey(bot, enemies)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    try {
                        if (!await skills.avoidEnemies(bot, 24))
                            throw new Error('Retreat failed; waiting for a changed encounter or terrain before retrying.');
                    } catch (error) {
                        failedRetreats.set(bot, encounterKey(bot, imminentThreats(bot, await world.getNearbyThreats(bot, 16))));
                        throw error;
                    }
                    failedRetreats.delete(bot);
                }, -1, modeDecision(this, bot, 'dangerous_encounter', { target: enemy, enemyCount: enemies.length,
                    enemies: enemies.slice(0, 8).map(item => entityEvidence(bot, item)), groundMelee,
                    maxEnemies, selfDefenseEnabled: modes_map.self_defense.on,
                    selfDefensePaused: modes_map.self_defense.paused === true }));
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const bot = agent.bot;
            const enemies = await world.getNearbyThreats(bot, 16);
            // After a failed retreat, leave unreachable enemies alone so work is not
            // interrupted, but fight one that closes to attack range: the bot
            // cannot escape it.
            const cornered = enemies.some(enemy => bot.entity.position.distanceTo(enemy.position) <= CORNERED_FIGHT_DISTANCE);
            if (modes_map.cowardice.on && !cornered && failedRetreats.get(bot) === encounterKey(bot, imminentThreats(bot, enemies))) return;
            const enemy = enemies.find(enemy => bot.entity.position.distanceTo(enemy.position) <= 8);
            if (enemy) {
                say(agent, `Fighting ${enemy.name}!`);
                execute(this, agent, async () => {
                    await skills.defendSelf(agent.bot, 8);
                }, -1, modeDecision(this, bot, 'nearby_threat', { target: enemy, enemyCount: enemies.length }));
            }
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                }, -1, modeDecision(this, agent.bot, 'nearby_huntable_entity', { target: huntable }));
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item', 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    }, -1, modeDecision(this, agent.bot, 'nearby_item_after_notice_delay', { target: item,
                        emptyInventorySlots: empty_inv_slots, noticeDelayMs: Date.now() - this.noticed_at }));
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                }, -1, modeDecision(this, agent.bot, 'torch_placement_condition', {}));
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        moveDistance: 2,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        // Pathfinder goals compare block nodes. A sub-block range is
                        // already satisfied when stacked bots stand on a chest or
                        // slab, so move a full node clear of the other player.
                        await skills.moveAwayFromEntity(agent.bot, player, this.moveDistance);
                    }
                }, -1, modeDecision(this, agent.bot, 'nearby_player_elbow_room', { target: player,
                    threshold: this.distance }));
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

async function execute(mode, agent, func, timeout=-1, decision = {}) {
    if (agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    const activeAction = agent.actions.currentAction;
    const interruptionContext = { decisionId: randomUUID(), sourceMode: mode.name,
        reason: decision.reason ?? 'mode_trigger', replacementActionLabel: `mode:${mode.name}`,
        ...(activeAction ? { interruptedActionId: activeAction.id, interruptedActionLabel: activeAction.label } : {}),
        evidence: decision };
    try { agent.bot?._mindcraftDiagnosticRecord?.('mode_action_triggered', interruptionContext); } catch {}
    let code_return = null;
    mode.active = true;
    try {
        code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
            const context = agent.actions.getCancellationContext();
            if (context) agent.actions.setPhase(`recovering:${mode.name}`, context.actionId);
            await func();
        }, { timeout, interruptionContext });
        console.log(`Mode ${mode.name} finished executing, code_return: ${code_return.message}`);
    } finally {
        mode.active = false;
    }

    let should_reprompt = 
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        code_return?.success && // failed recovery should not trigger another plan
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage('system', `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}.
        Your behavior log: ${logs}\nRespond accordingly.`);
    }
    return code_return;
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        for (let mode of modes_list) {
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    agent.bot.on?.('blockUpdate', (_old, block) => {
        if (block?.position && agent.bot.entity.position.distanceTo(block.position) <= 28)
            terrainRevisions.set(agent.bot, (terrainRevisions.get(agent.bot) ?? 0) + 1);
    });
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
