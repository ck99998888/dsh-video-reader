/**
 * User-editable screen-capture preferences.
 *
 * The settings page in the Web UI writes this file through the plugin's own
 * HTTP route; the capture tool reads it on every call, so a change takes effect
 * without restarting anything.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { localRoot } from './asr.js'

export const DEFAULT_SETTINGS = {
  enabled: true,
  region: 'full',
  windowTitle: '',
  windowProcess: '',
  rect: { x: 0, y: 0, width: 1280, height: 720 },
  fps: 2,
  seconds: 3,
  width: 1280,
  drawMouse: false,
  maxFrames: 12,
  recordFps: 30,
  recordSeconds: 3600,
  recordMaxMB: 2000,
  recordWidth: 1280,
  readBatch: 20,
  watchIntervalMs: 2000,
  watchThreshold: 0.02,
  watchMinutes: 30,
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Normalize anything that came from the page or the file into valid settings. */
export function sanitizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(input ?? {}) }
  const rect = { ...DEFAULT_SETTINGS.rect, ...(input?.rect ?? {}) }
  const region = ['full', 'window', 'rect'].includes(merged.region) ? merged.region : 'full'
  return {
    enabled: merged.enabled !== false,
    region,
    windowTitle: typeof merged.windowTitle === 'string' ? merged.windowTitle.slice(0, 200) : '',
    windowProcess: typeof merged.windowProcess === 'string' ? merged.windowProcess.slice(0, 80) : '',
    rect: {
      x: clampNumber(rect.x, 0, 0, 20000),
      y: clampNumber(rect.y, 0, 0, 20000),
      width: clampNumber(rect.width, 1280, 16, 20000),
      height: clampNumber(rect.height, 720, 16, 20000),
    },
    fps: clampNumber(merged.fps, 2, 1, 30),
    seconds: clampNumber(merged.seconds, 3, 0, 30),
    width: clampNumber(merged.width, 1280, 320, 3840),
    drawMouse: merged.drawMouse === true,
    maxFrames: clampNumber(merged.maxFrames, 12, 1, 30),
    recordFps: clampNumber(merged.recordFps, 30, 1, 30),
    recordSeconds: clampNumber(merged.recordSeconds, 3600, 10, 7200),
    recordMaxMB: clampNumber(merged.recordMaxMB, 2000, 100, 20000),
    recordWidth: clampNumber(merged.recordWidth, 1280, 0, 3840),
    readBatch: clampNumber(merged.readBatch, 20, 1, 40),
    watchIntervalMs: clampNumber(merged.watchIntervalMs, 2000, 500, 60000),
    watchThreshold: Number.isFinite(Number(merged.watchThreshold))
      ? Math.min(0.5, Math.max(0.002, Number(merged.watchThreshold)))
      : 0.02,
    watchMinutes: clampNumber(merged.watchMinutes, 30, 1, 240),
  }
}

/** Absolute path of the settings file. */
export function settingsPath() {
  return path.join(localRoot(), 'screen-settings.json')
}

/** Read saved settings, falling back to defaults. */
export async function readSettings() {
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    return sanitizeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Persist a partial patch on top of the current settings.
 * @param {object} patch fields to change.
 * @returns {Promise<object>} the settings that were written.
 */
export async function writeSettings(patch) {
  const current = await readSettings()
  const next = sanitizeSettings({ ...current, ...(patch ?? {}), rect: { ...current.rect, ...(patch?.rect ?? {}) } })
  await mkdir(path.dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
