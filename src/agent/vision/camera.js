import { Viewer } from 'prismarine-viewer/viewer/lib/viewer.js';
import { WorldView } from 'prismarine-viewer/viewer/lib/worldView.js';

import THREE from 'three';
import { createCanvas } from 'node-canvas-webgl/lib/index.js';
import fs from 'fs/promises';
import { Vec3 } from 'vec3';
import { EventEmitter } from 'events';

import worker_threads from 'worker_threads';
global.Worker = worker_threads.Worker;

export const CAMERA_MAX_JPEG_BYTES = 2 * 1024 * 1024;
export const CAMERA_CLOSE_DRAIN_MS = 500;
const CAPTURE_WIDTH = 800;
const CAPTURE_HEIGHT = 512;

export class Camera extends EventEmitter {
    constructor (bot, fp, dependencies = {}) {
        super();
        this.bot = bot;
        this.fp = fp;
        this.viewDistance = 12;
        this.width = CAPTURE_WIDTH;
        this.height = CAPTURE_HEIGHT;
        this._dependencies = dependencies;
        this.canvas = dependencies.canvas || (dependencies.createCanvas || createCanvas)(this.width, this.height);
        this.renderer = dependencies.renderer || (dependencies.createRenderer || (canvas => new THREE.WebGLRenderer({ canvas })))(this.canvas);
        this.viewer = dependencies.viewer || (dependencies.createViewer || (renderer => new Viewer(renderer)))(this.renderer);
        this.closed = false;
        this._capturePromise = null;
        this._activeCapture = null;
        this._disposed = false;
        this._initSettled = false;
        this.ready = this._init().then(() => {
            if (this.closed) throw cameraError('Camera closed during initialization');
            this.emit('ready');
            return this;
        }).finally(() => { this._initSettled = true; if (this.closed) this._dispose(); });
        // Preserve an awaitable rejected ready promise without an unhandled rejection
        // when vision is never requested after initialization fails.
        this.ready.catch(() => {});
    }
  
    async _init () {
        const botPos = this.bot.entity.position;
        const center = new Vec3(botPos.x, botPos.y+this.bot.entity.height, botPos.z);
        this.viewer.setVersion(this.bot.version);
        // Load world
        const worldView = (this._dependencies.createWorldView || ((world, distance, point) => new WorldView(world, distance, point)))(this.bot.world, this.viewDistance, center);
        this.viewer.listen(worldView);
        worldView.listenToBot(this.bot);
        await worldView.init(center);
        this.worldView = worldView;
        if (this.closed) this._dispose();
    }
  
    capture({ signal = null } = {}) {
        if (this.closed) return Promise.reject(cameraError('Camera is closed'));
        if (this._capturePromise) return Promise.reject(cameraError('Camera capture already in progress'));
        const capture = this._capture({ signal });
        this._capturePromise = capture;
        capture.finally(() => { if (this._capturePromise === capture) this._capturePromise = null; }).catch(() => {});
        return capture;
    }

    async _capture({ signal }) {
        await this.ready;
        this._assertActive(signal);
        const controller = new AbortController();
        const onAbort = () => {
            controller.abort(signal.reason);
            this._activeCapture?.stream?.destroy?.(signal.reason instanceof Error ? signal.reason : cameraError('Camera capture cancelled'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        this._activeCapture = { controller, stream: null };
        try {
        const center = new Vec3(this.bot.entity.position.x, this.bot.entity.position.y+this.bot.entity.height, this.bot.entity.position.z);
        this.viewer.camera.position.set(center.x, center.y, center.z);
        await this.worldView.updatePosition(center);
        this.viewer.setFirstPersonCamera(this.bot.entity.position, this.bot.entity.yaw, this.bot.entity.pitch);
        this.viewer.update();
        this.renderer.render(this.viewer.scene, this.viewer.camera);

        const imageStream = this.canvas.createJPEGStream({
            bufsize: 4096,
            quality: 100,
            progressive: false
        });
        this._activeCapture.stream = imageStream;
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot_${timestamp}`;

        const chunks = [];
        let byteLength = 0;
        for await (const chunk of imageStream) {
            this._assertActive(signal);
            byteLength += chunk.length;
            if (byteLength > CAMERA_MAX_JPEG_BYTES) {
                imageStream.destroy?.(cameraError('Camera image exceeds byte limit'));
                throw cameraError(`Camera image exceeds ${CAMERA_MAX_JPEG_BYTES} bytes`);
            }
            chunks.push(chunk);
        }
        this._assertActive(signal);
        const buf = Buffer.concat(chunks, byteLength);
        await (this._dependencies.ensureDirectory || (() => this._ensureScreenshotDirectory()))();
        this._assertActive(signal);
        await (this._dependencies.writeFile || fs.writeFile)(`${this.fp}/${filename}.jpg`, buf);
        this._assertActive(signal);
        console.log('saved', filename);
        return filename;
        } finally {
            signal?.removeEventListener('abort', onAbort);
            this._activeCapture = null;
            if (this.closed) this._dispose();
        }
    }

    _assertActive(signal) {
        if (this.closed) throw cameraError('Camera is closed');
        if (this._activeCapture?.controller.signal.aborted) {
            const reason = this._activeCapture.controller.signal.reason;
            throw reason instanceof Error ? reason : cameraError('Camera capture cancelled');
        }
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : cameraError('Camera capture cancelled');
    }

    async close({ drainTimeoutMs = CAMERA_CLOSE_DRAIN_MS } = {}) {
        if (!this.closed) {
            this.closed = true;
            this._activeCapture?.controller.abort(cameraError('Camera closed'));
            this._activeCapture?.stream?.destroy?.(cameraError('Camera closed'));
        }
        if (!this._capturePromise && this._initSettled) this._dispose();
        const pending = Promise.allSettled([this.ready, ...(this._capturePromise ? [this._capturePromise] : [])]);
        let timer;
        const outcome = await Promise.race([
            pending.then(() => 'settled'),
            new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), drainTimeoutMs); }),
        ]);
        clearTimeout(timer);
        return { closed: true, drained: outcome === 'settled' && this._disposed };
    }

    _dispose() {
        if (this._disposed) return;
        this._disposed = true;
        try { this.worldView?.removeListenersFromBot?.(this.bot); } catch (error) { console.warn('Could not remove camera world listeners:', error); }
        try { this.renderer?.dispose?.(); } catch (error) { console.warn('Could not dispose camera renderer:', error); }
    }

    async _ensureScreenshotDirectory() {
        let stats;
        try {
            stats = await fs.stat(this.fp);
        } catch (e) {
            if (!stats?.isDirectory()) {
                await fs.mkdir(this.fp);
            }
        }
    }
}

function cameraError(message) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}
  
