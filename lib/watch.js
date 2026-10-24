/**
 * Real-time screen watching: a second, continuous path beside one-shot capture.
 *
 * The loop samples a small grayscale frame on an interval, measures how much it
 * changed, and only when something actually changed does it spend a full-size
 * frame and wake the agent. That is what "think about the video in real time"
 * means here: the model is not fed 30 frames per second, it is woken when the
 * picture stops being the same.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { run } from './ffmpeg.js'

const SIGNATURE_WIDTH = 64
const SIGNATURE_HEIGHT = 40

const watchers = new Map()

/** One tiny grayscale frame, used only for change measurement. */
async function signature(ffmpeg, plan) {
  const args = [...plan.input, '-frames:v', '1', '-vf', `scale=${SIGNATURE_WIDTH}:${SIGNATURE_HEIGHT},format=gray`, '-f', 'rawvideo', '-']
  const result = await run(ffmpeg, args, { timeoutMs: 20_000 })
  return result.code === 0 ? result.stdout : undefined
}

/** Mean absolute difference of two signatures, normalized to 0..1. */
export function difference(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 1
  let total = 0
  for (let index = 0; index < a.length; index += 1) total += Math.abs(a[index] - b[index])
  return total / (a.length * 255)
}

/**
 * Start a watcher.
 * @param {object} options watcher options.
 * @param {string} options.ffmpeg ffmpeg executable.
 * @param {object} options.plan capture plan (input args + label).
 * @param {string} options.dir cache directory for changed frames.
 * @param {number} [options.intervalMs] sampling interval.
 * @param {number} [options.threshold] normalized change needed to wake the agent.
 * @param {number} [options.maxMinutes] auto-stop.
 * @param {(event: object) => void} [options.onChange] wake callback.
 * @param {number} [options.width] still width.
 * @returns {object} the watcher summary.
 */
export function startWatcher(options) {
  const {
    ffmpeg, plan, dir, intervalMs = 2000, threshold = 0.02,
    maxMinutes = 30, onChange, width = 1280,
  } = options
  const id = `watch-${Date.now().toString(36)}`
  const watcher = {
    id,
    plan,
    dir,
    intervalMs,
    threshold,
    startedAt: Date.now(),
    maxMs: maxMinutes * 60_000,
    events: [],
    previous: undefined,
    busy: false,
    stopped: false,
    lastError: '',
    stills: 0,
    wakes: 0,
  }

  const tick = async () => {
    if (watcher.busy || watcher.stopped) return
    watcher.busy = true
    try {
      if (Date.now() - watcher.startedAt > watcher.maxMs) {
        stopWatcher(id)
        return
      }
      const current = await signature(ffmpeg, plan)
      const score = difference(watcher.previous, current)
      watcher.previous = current
      if (score < threshold) return

      const at = Date.now()
      const stillPath = path.join(dir, `change-${at}.jpg`)
      const result = await run(ffmpeg, [...plan.input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', stillPath], { timeoutMs: 20_000 })
      if (result.code !== 0) throw new Error(result.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? 'still failed')
      watcher.stills += 1
      const event = { at, elapsedMs: at - watcher.startedAt, score: Math.round(score * 1000) / 1000, path: stillPath }
      watcher.events.push(event)
      if (watcher.events.length > 200) watcher.events.shift()
      if (onChange) {
        try { onChange(event); watcher.wakes += 1 } catch (error) { watcher.lastError = String(error?.message ?? error) }
      }
    } catch (error) {
      watcher.lastError = String(error?.message ?? error)
    } finally {
      watcher.busy = false
    }
  }

  watcher.timer = setInterval(() => { void tick() }, intervalMs)
  if (typeof watcher.timer.unref === 'function') watcher.timer.unref()
  const started = { id, label: plan.label, intervalMs, threshold, startedAt: watcher.startedAt }
  watchers.set(id, watcher)
  return started
}

/**
 * Stop one watcher.
 * @param {string} id watcher id.
 * @returns {object|undefined} final summary.
 */
export function stopWatcher(id) {
  const watcher = watchers.get(id)
  if (!watcher) return undefined
  watcher.stopped = true
  clearInterval(watcher.timer)
  watchers.delete(id)
  return {
    id,
    label: watcher.plan.label,
    seconds: Math.round((Date.now() - watcher.startedAt) / 1000),
    changes: watcher.events.length,
    stills: watcher.stills,
    wakes: watcher.wakes,
    lastError: watcher.lastError || undefined,
    events: watcher.events.slice(-20),
  }
}

/** Snapshot running watchers plus their latest change events. */
export function listWatchers() {
  return [...watchers.values()].map((watcher) => ({
    id: watcher.id,
    label: watcher.plan.label,
    elapsedSeconds: Math.round((Date.now() - watcher.startedAt) / 1000),
    intervalMs: watcher.intervalMs,
    threshold: watcher.threshold,
    changes: watcher.events.length,
    lastError: watcher.lastError || undefined,
    events: watcher.events.slice(-8),
  }))
}

/** Drain change events recorded since the last call. */
export function takeEvents() {
  const events = []
  for (const watcher of watchers.values()) {
    for (const event of watcher.events.splice(0, watcher.events.length)) {
      events.push({ watcher: watcher.id, ...event })
    }
  }
  return events
}

/** Stop every watcher (plugin unload). */
export function stopAllWatchers() {
  return [...watchers.keys()].map((id) => stopWatcher(id)).filter(Boolean)
}

export { mkdir, writeFile }
