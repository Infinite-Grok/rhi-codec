// RHI Codec Renderer — Polychromatic Per-Element Character-Grid Image and Video Codec
// Copyright (C) 2026 Jonathan T Laine
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, version 3.
//
// Commercial licensing available. Contact: infinitegrok@gmail.com
// Patent pending: US Application 64/014,800
//
// Zero dependencies. Canvas 2D. Drop-in single file.
//
// Pipeline: decode → [temporal interpolation] → auto-levels → bilinear upscale → unsharp mask
// Tested 2026-03-21: levels + bilinear + sharpen r=2 won A/B/C against Scale2x,
// guided filter, skin warmth, BG suppression, and motion-adaptive approaches.

(function(root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else { const exp = factory(); root.RHiveRenderer = exp.RHiveRenderer; root.ProgressiveCache = exp.ProgressiveCache; root.RHIVE_TIERS = exp.TIERS; root.RHIVE_TIER_WIDTHS = exp.TIER_WIDTHS; }
}(typeof self !== 'undefined' ? self : this, function() {
'use strict';

// --- Constants ---
const BRAILLE_BASE = 0x2800;
const DOT_MAP = [
  [0x01, 0x08],  // row 0
  [0x02, 0x10],  // row 1
  [0x04, 0x20],  // row 2
  [0x40, 0x80],  // row 3
];
const BG_COLOR = [10, 10, 15, 255];  // #0a0a0f

// --- Helpers ---
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function hexToRgb(hex) {
  if (!hex || hex.length < 7) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas allocation failed');
  return { canvas: c, ctx };
}

// --- FrameBuffer ---
class FrameBuffer {
  constructor() {
    this.cols = 0;
    this.rows = 0;
    this.pxWidth = 0;
    this.pxHeight = 0;
    this.currGrid = null;
    this.prevGrid = null;
    this.frameCount = 0;
    this.lastWasFullFrame = true;
    this.currCanvas = null;
    this.prevCanvas = null;
    this._allocated = false;
  }

  allocate(cols, rows) {
    if (this._allocated && this.cols === cols && this.rows === rows) return false;
    this.cols = cols;
    this.rows = rows;
    this.pxWidth = cols * 2;
    this.pxHeight = rows * 4;
    this.currGrid = this._emptyGrid();
    this.prevGrid = null;
    this.currCanvas = makeCanvas(this.pxWidth, this.pxHeight);
    this.prevCanvas = makeCanvas(this.pxWidth, this.pxHeight);
    this.frameCount = 0;
    this._allocated = true;
    return true;
  }

  _emptyGrid() {
    return Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => ['\u2800', [null,null,null,null,null,null,null,null]])
    );
  }

  applyFrame(frame) {
    const cols = frame.cols || (frame.grid ? frame.grid[0].length : this.cols);
    const rows = frame.rows || (frame.grid ? frame.grid.length : this.rows);

    if (!this._allocated && frame.type !== 'full') return false;

    const dimChanged = this.allocate(cols, rows);

    // Rotate buffers
    if (this.prevGrid) {
      this.prevCanvas.ctx.drawImage(this.currCanvas.canvas, 0, 0);
    }
    this.prevGrid = this.currGrid ? this.currGrid.map(r => r.map(c => [c[0], [...c[1]]])) : null;

    if (frame.type === 'full' && frame.grid) {
      this.lastWasFullFrame = true;
      for (let r = 0; r < Math.min(frame.grid.length, this.rows); r++) {
        for (let c = 0; c < Math.min(frame.grid[r].length, this.cols); c++) {
          this.currGrid[r][c] = [frame.grid[r][c][0], frame.grid[r][c][1]];
        }
      }
    } else if (frame.type === 'delta' && frame.changes) {
      this.lastWasFullFrame = false;
      if (!this.prevGrid) return false;
      for (const [r, c, char, colors] of frame.changes) {
        if (r < this.rows && c < this.cols) {
          this.currGrid[r][c] = [char, colors];
        }
      }
    }

    this.frameCount++;
    this._paintGrid(this.currGrid, this.currCanvas);
    return dimChanged;
  }

  _paintGrid(grid, target) {
    const { ctx } = target;
    const imgData = ctx.createImageData(this.pxWidth, this.pxHeight);
    const data = imgData.data;

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const [char, dotColors] = grid[r][c];
        const code = char.charCodeAt(0) - BRAILLE_BASE;

        for (let dr = 0; dr < 4; dr++) {
          for (let dc = 0; dc < 2; dc++) {
            const px = c * 2 + dc;
            const py = r * 4 + dr;
            const idx = (py * this.pxWidth + px) * 4;
            const dotIdx = dr * 2 + dc;
            const active = (code & DOT_MAP[dr][dc]) !== 0;

            if (active && dotColors[dotIdx]) {
              const rgb = hexToRgb(dotColors[dotIdx]);
              if (rgb) {
                data[idx] = rgb[0]; data[idx+1] = rgb[1]; data[idx+2] = rgb[2]; data[idx+3] = 255;
                continue;
              }
            }
            data[idx] = BG_COLOR[0]; data[idx+1] = BG_COLOR[1]; data[idx+2] = BG_COLOR[2]; data[idx+3] = BG_COLOR[3];
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  decode() {
    return this.currCanvas.canvas;
  }
}

// --- InterpolationLoop (temporal blending for smooth display) ---
class InterpolationLoop {
  constructor(pxWidth, pxHeight) {
    this._out = makeCanvas(pxWidth, pxHeight);
    this._readPrev = makeCanvas(pxWidth, pxHeight);
    this._readCurr = makeCanvas(pxWidth, pxHeight);
    this.pxWidth = pxWidth;
    this.pxHeight = pxHeight;
  }

  resize(pxWidth, pxHeight) {
    this._out = makeCanvas(pxWidth, pxHeight);
    this._readPrev = makeCanvas(pxWidth, pxHeight);
    this._readCurr = makeCanvas(pxWidth, pxHeight);
    this.pxWidth = pxWidth;
    this.pxHeight = pxHeight;
  }

  process(prevCanvas, currCanvas, t) {
    const w = this.pxWidth, h = this.pxHeight;

    this._readPrev.ctx.drawImage(prevCanvas, 0, 0);
    const prevData = this._readPrev.ctx.getImageData(0, 0, w, h).data;

    this._readCurr.ctx.drawImage(currCanvas, 0, 0);
    const currData = this._readCurr.ctx.getImageData(0, 0, w, h).data;

    const { ctx, canvas } = this._out;
    const out = ctx.createImageData(w, h);
    const od = out.data;
    const invT = 1 - t;

    for (let i = 0; i < od.length; i += 4) {
      od[i]   = prevData[i]   * invT + currData[i]   * t;
      od[i+1] = prevData[i+1] * invT + currData[i+1] * t;
      od[i+2] = prevData[i+2] * invT + currData[i+2] * t;
      od[i+3] = 255;
    }

    ctx.putImageData(out, 0, 0);
    return canvas;
  }
}

// --- AutoLevels (P2-P98 histogram stretch) ---
class AutoLevels {
  constructor(pxWidth, pxHeight) {
    this._out = makeCanvas(pxWidth, pxHeight);
    this.pxWidth = pxWidth;
    this.pxHeight = pxHeight;
  }

  resize(pxWidth, pxHeight) {
    this._out = makeCanvas(pxWidth, pxHeight);
    this.pxWidth = pxWidth;
    this.pxHeight = pxHeight;
  }

  process(sourceCanvas) {
    const { ctx, canvas } = this._out;
    const w = this.pxWidth, h = this.pxHeight;

    ctx.drawImage(sourceCanvas, 0, 0);
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const len = d.length;
    const totalPixels = w * h;

    const histogram = new Uint32Array(256);
    for (let i = 0; i < len; i += 4) {
      histogram[Math.round(0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2])]++;
    }

    let cumulative = 0, pLo = 0, pHi = 255;
    for (let i = 0; i < 256; i++) {
      cumulative += histogram[i];
      if (cumulative >= totalPixels * 0.02 && pLo === 0) pLo = i;
      if (cumulative >= totalPixels * 0.98) { pHi = i; break; }
    }

    const range = pHi - pLo;
    if (range > 10) {
      const scale = 255 / range;
      for (let i = 0; i < len; i += 4) {
        d[i]   = clamp(Math.round((d[i]   - pLo) * scale), 0, 255);
        d[i+1] = clamp(Math.round((d[i+1] - pLo) * scale), 0, 255);
        d[i+2] = clamp(Math.round((d[i+2] - pLo) * scale), 0, 255);
      }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }
}

// --- UnsharpMask (sharpen after bilinear upscale) ---
class UnsharpMask {
  constructor(dispW, dispH) {
    this._out = makeCanvas(dispW, dispH);
    this.dispW = dispW;
    this.dispH = dispH;
    this.amount = 0.6;   // sharpening strength
    this.radius = 2;     // blur kernel radius
  }

  resize(dispW, dispH) {
    this._out = makeCanvas(dispW, dispH);
    this.dispW = dispW;
    this.dispH = dispH;
  }

  process(sourceCanvas) {
    const { ctx, canvas } = this._out;
    const w = this.dispW, h = this.dispH;

    ctx.drawImage(sourceCanvas, 0, 0);
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const orig = new Uint8ClampedArray(d);
    const r = this.radius;
    const amount = this.amount;

    // Box blur via integral image (O(n), independent of radius)
    // Build integral image per channel
    for (let ch = 0; ch < 3; ch++) {
      const sat = new Float64Array(w * h);
      for (let y = 0; y < h; y++) {
        let rowSum = 0;
        for (let x = 0; x < w; x++) {
          rowSum += orig[(y * w + x) * 4 + ch];
          sat[y * w + x] = rowSum + (y > 0 ? sat[(y - 1) * w + x] : 0);
        }
      }

      // Unsharp: output = original + amount * (original - blurred)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const y0 = Math.max(0, y - r) - 1;
          const y1 = Math.min(h - 1, y + r);
          const x0 = Math.max(0, x - r) - 1;
          const x1 = Math.min(w - 1, x + r);

          let sum = sat[y1 * w + x1];
          if (x0 >= 0) sum -= sat[y1 * w + x0];
          if (y0 >= 0) sum -= sat[y0 * w + x1];
          if (x0 >= 0 && y0 >= 0) sum += sat[y0 * w + x0];

          const count = (y1 - Math.max(0, y - r) + 1) * (x1 - Math.max(0, x - r) + 1);
          const blurred = sum / count;

          const idx = (y * w + x) * 4 + ch;
          d[idx] = clamp(Math.round(orig[idx] + amount * (orig[idx] - blurred)), 0, 255);
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }
}

// --- BundlePlayer ---
class BundlePlayer {
  constructor(renderer) {
    this.renderer = renderer;
    this.bundle = null;
    this.playing = false;
    this.currentIndex = 0;
    this.startTime = 0;
    this.pauseOffset = 0;
    this._timer = null;
  }

  load(bundle) {
    if (bundle.version && bundle.version !== 2) {
      throw new Error('Unsupported bundle version: ' + bundle.version);
    }
    this.bundle = {
      fps: bundle.fps || 2,
      frames: bundle.frames || [],
      keyframes: bundle.keyframes || [],
      duration_ms: bundle.duration_ms || (bundle.frames.length > 0
        ? bundle.frames[bundle.frames.length - 1].time_ms || (bundle.frames.length * 1000 / (bundle.fps || 2))
        : 0),
      cols: bundle.cols,
      rows: bundle.rows,
    };
    this.currentIndex = 0;
    this.pauseOffset = 0;
    this.playing = false;

    this.renderer.opts.sourceFps = this.bundle.fps;
    this.renderer.frameDuration = 1000 / this.bundle.fps;

    if (this.bundle.cols && this.bundle.rows) {
      this.renderer.frameBuffer.allocate(this.bundle.cols, this.bundle.rows);
      this.renderer._allocateStages();
      this.renderer.emit('ready', {
        cols: this.bundle.cols, rows: this.bundle.rows,
        pxWidth: this.bundle.cols * 2, pxHeight: this.bundle.rows * 4,
      });
    }

    if (this.bundle.frames.length > 0) {
      this.renderer.pushFrame(this.bundle.frames[0]);
      this.currentIndex = 1;
    }
  }

  play() {
    if (!this.bundle || this.playing) return;
    this.playing = true;
    this.startTime = performance.now() - this.pauseOffset;
    this._scheduleNext();
  }

  pause() {
    this.playing = false;
    this.pauseOffset = performance.now() - this.startTime;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  seek(targetMs) {
    if (!this.bundle) return;

    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();

    const frames = this.bundle.frames;
    const kfIndices = this.bundle.keyframes.length > 0
      ? this.bundle.keyframes
      : frames.map((_, i) => i).filter(i => frames[i].type === 'full');

    let lo = 0, hi = kfIndices.length - 1, kfIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const fi = kfIndices[mid];
      const ft = frames[fi].time_ms || (fi * 1000 / this.bundle.fps);
      if (ft <= targetMs) { kfIdx = fi; lo = mid + 1; }
      else { hi = mid - 1; }
    }

    this.renderer.frameBuffer.prevGrid = null;
    this.renderer.frameBuffer.currGrid = this.renderer.frameBuffer._emptyGrid();

    for (let i = kfIdx; i < frames.length; i++) {
      const ft = frames[i].time_ms || (i * 1000 / this.bundle.fps);
      this.renderer.frameBuffer.applyFrame(frames[i]);
      if (ft >= targetMs) { this.currentIndex = i + 1; break; }
    }

    this.renderer.frameArrival = performance.now();
    this.pauseOffset = targetMs;

    if (wasPlaying) this.play();
  }

  _scheduleNext() {
    if (!this.playing || this.currentIndex >= this.bundle.frames.length) {
      if (this.currentIndex >= this.bundle.frames.length) {
        this.playing = false;
        this.renderer.emit('end', {});
      }
      return;
    }

    const frame = this.bundle.frames[this.currentIndex];
    const frameTime = frame.time_ms || (this.currentIndex * 1000 / this.bundle.fps);
    const elapsed = performance.now() - this.startTime;
    const delay = Math.max(0, frameTime - elapsed);

    this._timer = setTimeout(() => {
      if (!this.playing) return;
      this.renderer.pushFrame(frame);
      this.currentIndex++;
      this._scheduleNext();
    }, delay);
  }

  destroy() {
    this.playing = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
}

// --- Tier Definitions ---
const TIERS = ['micro', 'lora', 'lora+', 'wifi'];
const TIER_WIDTHS = { micro: 20, lora: 25, 'lora+': 30, wifi: 35 };

// --- CongestionTracker ---
class CongestionTracker {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    this.selectedTier = 'lora';
    this.actualTier = 'lora';
    this.maxTier = 'wifi';

    this._lateCount = 0;
    this._onTimeCount = 0;
    this._lastFrameArrival = 0;
    this._fallbackCount = 0;
    this._recoveryCount = 0;
    this._recoveryBlockedUntil = 0;

    this.lateThreshold = 1.5;
    this.fallbackAfter = 3;
    this.recoveryAfter = 30;
    this.recoveryCooldown = 60000;
  }

  track(now, expectedInterval) {
    if (!this.enabled) return;
    if (!this._lastFrameArrival) { this._lastFrameArrival = now; return; }

    const interval = now - this._lastFrameArrival;
    this._lastFrameArrival = now;

    if (interval > expectedInterval * this.lateThreshold) {
      this._lateCount++;
      this._onTimeCount = 0;
      if (this._lateCount >= this.fallbackAfter) {
        this._dropTier(now);
        this._lateCount = 0;
      }
    } else {
      this._onTimeCount++;
      this._lateCount = 0;
      if (this._onTimeCount >= this.recoveryAfter
          && this.actualTier !== this.selectedTier
          && now > this._recoveryBlockedUntil) {
        this._recoverTier(now);
        this._onTimeCount = 0;
      }
    }
  }

  select(tier) {
    if (!TIERS.includes(tier)) return;
    const maxIdx = TIERS.indexOf(this.maxTier);
    const tierIdx = TIERS.indexOf(tier);
    this.selectedTier = TIERS[Math.min(tierIdx, maxIdx)];
    this.actualTier = this.selectedTier;
    this._lateCount = 0;
    this._onTimeCount = 0;
    this._recoveryBlockedUntil = 0;
    this.renderer.emit('tier_request', { tier: this.selectedTier, reason: 'manual' });
    this.renderer.emit('tier_change', { from: this.actualTier, to: this.selectedTier, reason: 'manual' });
  }

  setMaxTier(tier) {
    if (!TIERS.includes(tier)) return;
    this.maxTier = tier;
    const maxIdx = TIERS.indexOf(tier);
    if (TIERS.indexOf(this.selectedTier) > maxIdx) {
      this.selectedTier = tier;
      this.actualTier = tier;
    }
    if (TIERS.indexOf(this.actualTier) > maxIdx) {
      this.actualTier = tier;
    }
  }

  getState() {
    return {
      selected: this.selectedTier,
      actual: this.actualTier,
      maxTier: this.maxTier,
      congested: this.actualTier !== this.selectedTier,
      lateCount: this._lateCount,
      onTimeCount: this._onTimeCount,
      fallbacks: this._fallbackCount,
      recoveries: this._recoveryCount,
    };
  }

  _dropTier(now) {
    const idx = TIERS.indexOf(this.actualTier);
    if (idx <= 0) return;
    const from = this.actualTier;
    this.actualTier = TIERS[idx - 1];
    this._fallbackCount++;
    this.renderer.emit('tier_request', { tier: this.actualTier, reason: 'fallback' });
    this.renderer.emit('tier_change', { from, to: this.actualTier, reason: 'fallback' });
  }

  _recoverTier(now) {
    const idx = TIERS.indexOf(this.actualTier);
    const selectedIdx = TIERS.indexOf(this.selectedTier);
    if (idx >= selectedIdx) return;
    const from = this.actualTier;
    this.actualTier = TIERS[idx + 1];
    this._recoveryCount++;
    this.renderer.emit('tier_request', { tier: this.actualTier, reason: 'recovery' });
    this.renderer.emit('tier_change', { from, to: this.actualTier, reason: 'recovery' });
  }

  recoveryFailed() {
    this._recoveryBlockedUntil = performance.now() + this.recoveryCooldown;
    this._dropTier(performance.now());
  }
}

// --- RHiveRenderer ---
class RHiveRenderer {
  constructor(selector, opts = {}) {
    this.displayCanvas = typeof selector === 'string'
      ? document.querySelector(selector) : selector;
    if (!this.displayCanvas) throw new Error('Canvas not found: ' + selector);
    this.displayCtx = this.displayCanvas.getContext('2d');

    this.opts = {
      displayFps: opts.displayFps || 15,
      upscale: opts.upscale || 4,
      sourceFps: opts.sourceFps || null,
      sharpenAmount: opts.sharpenAmount || 0.6,
      sharpenRadius: opts.sharpenRadius || 2,
    };
    this.stages = Object.assign({
      temporal: true,
      levels: true,
      sharpen: true,
    }, opts.stages);

    this.frameBuffer = new FrameBuffer();
    this.interp = null;
    this.levels = null;
    this.sharpener = null;
    this.bundlePlayer = null;

    // Render loop state
    this.running = false;
    this.lastRender = 0;
    this.frameInterval = 1000 / this.opts.displayFps;
    this.frameArrival = 0;
    this.frameDuration = this.opts.sourceFps ? 1000 / this.opts.sourceFps : 500;
    this._fpsEstSamples = 0;
    this._lastPushTime = 0;

    // Upscale canvas
    this._upscaleCanvas = null;

    // Congestion
    this.congestion = new CongestionTracker(this);
    if (opts.tier) this.congestion.selectedTier = opts.tier;
    if (opts.tier) this.congestion.actualTier = opts.tier;
    if (opts.autoFallback === false) this.congestion.enabled = false;

    // Events
    this._listeners = {};

    this._tick = this._tick.bind(this);
  }

  // --- Event system ---
  on(event, fn) { (this._listeners[event] = this._listeners[event] || []).push(fn); }
  emit(event, data) { (this._listeners[event] || []).forEach(fn => fn(data)); }

  // --- Public API ---
  pushFrame(frame) {
    if (!frame || (!frame.grid && !frame.changes)) return;
    if (frame.type === 'delta' && !this.frameBuffer._allocated) return;

    const now = performance.now();

    // FPS estimation
    if (!this.opts.sourceFps) {
      if (this._lastPushTime > 0) {
        const interval = clamp(now - this._lastPushTime, 100, 2000);
        this._fpsEstSamples++;
        if (this._fpsEstSamples >= 3) {
          this.frameDuration = this.frameDuration * 0.7 + interval * 0.3;
        }
      }
      this._lastPushTime = now;
    }

    this.congestion.track(now, this.frameDuration);

    const dimChanged = this.frameBuffer.applyFrame(frame);
    this.frameArrival = now;

    if (dimChanged) {
      this._allocateStages();
      this.emit('ready', {
        cols: this.frameBuffer.cols, rows: this.frameBuffer.rows,
        pxWidth: this.frameBuffer.pxWidth, pxHeight: this.frameBuffer.pxHeight,
      });
    }

    if (!this.running) {
      this.running = true;
      requestAnimationFrame(this._tick);
    }
  }

  setStage(name, enabled) {
    if (name in this.stages) this.stages[name] = !!enabled;
  }

  preset(name) {
    const presets = {
      default: { temporal: true, levels: true, sharpen: true },
      raw:     { temporal: false, levels: false, sharpen: false },
    };
    if (presets[name]) Object.assign(this.stages, presets[name]);
  }

  // --- Tier API ---
  setTier(tier) { this.congestion.select(tier); }
  getTier() { return this.congestion.getState(); }
  setMaxTier(tier) { this.congestion.setMaxTier(tier); }
  setAutoFallback(enabled) { this.congestion.enabled = !!enabled; }
  tierRecoveryFailed() { this.congestion.recoveryFailed(); }

  // --- Bundle / Playback ---
  loadBundle(bundle) {
    if (!this.bundlePlayer) this.bundlePlayer = new BundlePlayer(this);
    this.bundlePlayer.load(bundle);
  }
  play() { if (this.bundlePlayer) this.bundlePlayer.play(); }
  pause() { if (this.bundlePlayer) this.bundlePlayer.pause(); }
  seek(ms) {
    if (!this.bundlePlayer || !this.bundlePlayer.bundle) return;
    this.bundlePlayer.seek(ms);
  }
  destroy() {
    this.running = false;
    if (this.bundlePlayer) this.bundlePlayer.destroy();
    this._listeners = {};
  }

  // --- Internal ---
  _allocateStages() {
    const pw = this.frameBuffer.pxWidth;
    const ph = this.frameBuffer.pxHeight;
    const dw = this.opts.upscale * pw;
    const dh = this.opts.upscale * ph;

    this.displayCanvas.width = dw;
    this.displayCanvas.height = dh;
    this._upscaleCanvas = makeCanvas(dw, dh);
    this.interp = new InterpolationLoop(pw, ph);
    this.levels = new AutoLevels(pw, ph);
    this.sharpener = new UnsharpMask(dw, dh);
    this.sharpener.amount = this.opts.sharpenAmount;
    this.sharpener.radius = this.opts.sharpenRadius;
  }

  _bilinearUpscale(sourceCanvas) {
    const { canvas, ctx } = this._upscaleCanvas;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  _tick(now) {
    if (!this.running) return;
    requestAnimationFrame(this._tick);

    if (now - this.lastRender < this.frameInterval) return;

    const raw_t = clamp((now - this.frameArrival) / this.frameDuration, 0, 1);
    const t = 1 - (1 - raw_t) ** 2;  // ease-out

    // Pipeline: decode → temporal → levels → bilinear → sharpen
    let surface = this.frameBuffer.decode();

    if (this.stages.temporal && this.interp && this.frameBuffer.prevGrid) {
      surface = this.interp.process(this.frameBuffer.prevCanvas.canvas, surface, t);
    }

    if (this.stages.levels && this.levels) {
      surface = this.levels.process(surface);
    }

    // Bilinear upscale (always — this is how we get to display resolution)
    surface = this._bilinearUpscale(surface);

    if (this.stages.sharpen && this.sharpener) {
      surface = this.sharpener.process(surface);
    }

    // Blit
    this.displayCtx.drawImage(surface, 0, 0);
    this.lastRender = now;

    const type = this.stages.temporal ? 'interpolated' : (this.frameBuffer.lastWasFullFrame ? 'full' : 'delta');
    this.emit('frame', { index: this.frameBuffer.frameCount, timeMs: now - this.frameArrival, type });
  }
}

// --- ProgressiveCache ---
class ProgressiveCache {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.baseUrl = opts.baseUrl || '/api/reels';
    this._cached = {};
    this._caching = {};
    this._currentReelId = null;
  }

  async load(reelId, preferredTier = 'lora') {
    this._currentReelId = reelId;
    this._cached = {};
    this._caching = {};

    const tiersResp = await fetch(`${this.baseUrl}/${reelId}/tiers`);
    const tiersData = await tiersResp.json();
    const available = tiersData.tiers || [];
    const availableNames = available.map(t => t.tier);

    const prefIdx = TIERS.indexOf(preferredTier);
    let playTier = null;
    for (let i = prefIdx; i >= 0; i--) {
      if (availableNames.includes(TIERS[i])) { playTier = TIERS[i]; break; }
    }
    if (!playTier && availableNames.length > 0) playTier = availableNames[0];
    if (!playTier) return { playingTier: null, cachingTiers: [] };

    const bundle = await this._fetchBundle(reelId, playTier);
    if (bundle) {
      this._cached[playTier] = bundle;
      this.renderer.loadBundle(bundle);
      this.renderer.congestion.select(playTier);
      if (bundle.tier) this.renderer.congestion.setMaxTier(
        availableNames[availableNames.length - 1] || playTier
      );
    }

    const cachingTiers = [];
    for (let i = TIERS.indexOf(playTier) + 1; i < TIERS.length; i++) {
      const t = TIERS[i];
      if (availableNames.includes(t)) {
        cachingTiers.push(t);
        this._cacheInBackground(reelId, t);
      }
    }

    return { playingTier: playTier, cachingTiers };
  }

  switchTo(tier) {
    const bundle = this._cached[tier];
    if (!bundle) return false;
    this.renderer.loadBundle(bundle);
    this.renderer.congestion.select(tier);
    this.renderer.emit('tier_change', { from: this.renderer.congestion.actualTier, to: tier, reason: 'cache_switch' });
    return true;
  }

  getCachedTiers() { return Object.keys(this._cached); }
  isCached(tier) { return !!this._cached[tier]; }
  isCaching(tier) { return !!this._caching[tier]; }

  async _fetchBundle(reelId, tier) {
    try {
      const resp = await fetch(`${this.baseUrl}/${reelId}/bundle?tier=${encodeURIComponent(tier)}`);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      console.warn(`ProgressiveCache: failed to fetch ${tier} bundle:`, e);
      return null;
    }
  }

  async _cacheInBackground(reelId, tier) {
    if (this._caching[tier] || this._cached[tier]) return;
    if (reelId !== this._currentReelId) return;

    this._caching[tier] = true;
    const bundle = await this._fetchBundle(reelId, tier);
    delete this._caching[tier];

    if (bundle && reelId === this._currentReelId) {
      this._cached[tier] = bundle;
      this.renderer.emit('tier_cached', { tier, reelId, sizeKB: Math.round(JSON.stringify(bundle).length / 1024) });
    }
  }
}

// --- Exports ---
return { RHiveRenderer, ProgressiveCache, TIERS, TIER_WIDTHS };

}));
