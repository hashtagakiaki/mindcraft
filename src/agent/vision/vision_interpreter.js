import { Vec3 } from 'vec3';
import { Camera } from "./camera.js";
import fs from 'fs';

export class VisionInterpreter {
    constructor(agent, allow_vision) {
        this.agent = agent;
        this.allow_vision = allow_vision;
        this.fp = './bots/'+agent.name+'/screenshots/';
        if (allow_vision) {
            this.camera = new Camera(agent.bot, this.fp);
        }
    }

    async lookAtPlayer(player_name, direction = "at") {
        if (!this._visionAvailable()) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        if (typeof player_name !== "string" || !player_name.trim() || !["at", "with"].includes(direction)) {
            throw new TypeError('Use vision.lookAtPlayer(playerName, "at" | "with"); do not pass bot.');
        }
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let filename;
        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            result = `Looking in the same direction as ${player_name}\n`;
            filename = await this.camera.capture(this._captureOptions());
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;
            filename = await this.camera.capture(this._captureOptions());

        }

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    async lookAtPosition(x, y, z) {
        if (!this._visionAvailable()) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        if (![x, y, z].every(value => typeof value === "number" && Number.isFinite(value))) {
            throw new TypeError("Use vision.lookAtPosition(x, y, z) with finite numbers; do not pass bot.");
        }
        await bot.lookAt(new Vec3(x, y + 2, z));
        result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        let filename = await this.camera.capture(this._captureOptions());

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    async lookAtBlock(x, y, z) {
        if (![x, y, z].every(value => typeof value === "number" && Number.isFinite(value))) {
            throw new TypeError("Use vision.lookAtBlock(x, y, z) with finite numbers; do not pass bot.");
        }
        const observedAt = new Date().toISOString();
        if (!this._visionAvailable()) {
            return { status: 'vision_disabled', target: null, aim: null, observedAt, analysis: null,
                reason: "Vision is disabled. Use other methods to describe the environment." };
        }
        const bot = this.agent.bot;
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block) {
            return { status: 'unknown', target: null, aim: null, observedAt, analysis: null,
                reason: 'Target block is not loaded.' };
        }
        const position = { x: block.position.x, y: block.position.y, z: block.position.z };
        const target = { position, name: block.name, stateId: block.stateId,
            properties: { ...block.getProperties() }, observedAt };
        const aim = { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 };
        const options = this._captureOptions();
        options.signal?.throwIfAborted();
        await bot.lookAt(new Vec3(aim.x, aim.y, aim.z));
        options.signal?.throwIfAborted();
        const filename = await this.camera.capture(options);
        options.signal?.throwIfAborted();
        const analysis = await this.analyzeImage(filename);
        options.signal?.throwIfAborted();
        return { status: analysis === null ? 'unknown' : 'observed', target, aim,
            observedAt: new Date().toISOString(), analysis };
    }

    getCenterBlockInfo() {
        const bot = this.agent.bot;
        const maxDistance = 128; // Maximum distance to check for blocks
        const targetBlock = bot.blockAtCursor(maxDistance);
        
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }

    async analyzeImage(filename) {
        const context = this.agent.actions?.getCancellationContext?.() || null;
        const native = this.agent.codexRuntime?.active ? this.agent.codexRuntime : null;
        try {
            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            if (native) {
                context?.signal?.throwIfAborted();
                const attachment = native.attachImage(imageBuffer, { observedAt: new Date().toISOString(),
                    centerBlock: this.getCenterBlockInfo() });
                return `Screenshot attached to this operation's tool result; interpret the image directly. ${JSON.stringify(attachment)}`;
            }
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            const result = await this.agent.prompter.promptVision(messages, imageBuffer,
                { context, signal: context?.signal });
            if (context?.signal?.aborted || result === null) return null;
            return result + `\n${blockInfo}`;

        } catch (error) {
            if (native || context?.signal?.aborted || error?.name === 'AbortError') throw error;
            console.warn('Error reading image:', error);
            return `Error reading image: ${error.message}`;
        }
    }

    _visionAvailable() {
        return this.allow_vision && (!!this.agent.codexRuntime?.active || !!this.agent.prompter.vision_model?.sendVisionRequest);
    }

    _captureOptions() {
        const context = this.agent.actions?.getCancellationContext?.() || null;
        return { signal: context?.signal || null };
    }

    close(options) {
        return this.camera?.close(options) || Promise.resolve({ closed: true, drained: true });
    }
}
