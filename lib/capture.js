/**
 * Desktop capture through `ffmpeg`'s Windows grabbers.
 *
 * `gdigrab` is used because it needs no extra driver, accepts a window title or
 * an explicit rectangle, and produces ordinary JPEG stills. Capture is a
 * sampling device: the model never sees a live stream, it sees the frames that
 * existed during one capture window (this is why "real-time" always means
 * "sample for N seconds at F fps").
 *
 * Window capture is resolved to a rectangle first: GDI cannot read the D3D
 * surfaces of hardware-composited windows (Chrome/Edge, games, Electron), so
 * `-i title=...` returns black frames for exactly the windows users care about.
 * Cropping the composed desktop by the window's bounds works instead.
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { run } from './ffmpeg.js'
import { resolveWindow, listWindows } from './windows.js'

function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Build the ffmpeg input arguments for the requested region. */
export function captureInput(settings, overrides = {}) {
  const fps = clamp(overrides.fps ?? settings.fps, 1, 30)
  const drawMouse = (overrides.drawMouse ?? settings.drawMouse) ? '1' : '0'
  let region = overrides.region ?? settings.region
  let title = overrides.windowTitle ?? settings.windowTitle
  let rect = overrides.rect ?? settings.rect

  // A raw "x,y,w,h" string works as a region override from the tool call.
  if (typeof region === 'string' && /^\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+$/.test(region.trim())) {
    const [x, y, width, height] = region.split(',').map((part) => Number(part.trim()))
    rect = { x, y, width, height }
    region = 'rect'
  }
  if (typeof region === 'string' && region.startsWith('window:')) {
    title = region.slice('window:'.length)
    region = 'window'
  }

  const base = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', drawMouse]
  if (region === 'window') {
    if (!title) throw new Error('window capture needs a window title (region: "window:<标题>")')
    return { input: [...base, '-i', `title=${title}`], fps, region, label: `window "${title}"`, windowTitle: title }
  }
  if (region === 'rect') {
    const width = Math.max(16, Math.round(Number(rect.width) || 1280))
    const height = Math.max(16, Math.round(Number(rect.height) || 720))
    const x = Math.max(0, Math.round(Number(rect.x) || 0))
    const y = Math.max(0, Math.round(Number(rect.y) || 0))
    return {
      input: [...base, '-offset_x', String(x), '-offset_y', String(y), '-video_size', `${width}x${height}`, '-i', 'desktop'],
      fps,
      region: 'rect',
      label: `rect ${x},${y} ${width}x${height}`,
    }
  }
  return { input: [...base, '-i', 'desktop'], fps, region: 'full', label: 'full desktop' }
}

/**
 * Resolve a window choice to a capture plan. Window capture always ends up as a
 * desktop rectangle: GDI cannot read the D3D surface of a composed window.
 * @param {object} settings stored settings.
 * @param {object} [overrides] per-call overrides.
 * @returns {Promise<object>} the capture plan.
 */
export async function planCapture(settings, overrides = {}) {
  const plan = captureInput(settings, overrides)
  if (plan.region !== 'window') return plan
  // "window:<title>" in the call itself must win over the stored choice.
  let title = overrides.windowTitle ?? settings.windowTitle
  let process = overrides.windowProcess ?? settings.windowProcess
  if (typeof overrides.region === 'string' && overrides.region.startsWith('window:')) {
    title = overrides.region.slice('window:'.length)
    process = ''
  }
  const match = await resolveWindow({ title, process })
  if (!match) {
    const available = await listWindows().then((rows) => rows.slice(0, 6).map((row) => `${row.process}: ${row.title}`)).catch(() => [])
    throw new Error(
      `the chosen window is not on screen (title "${title || '-'}", process "${process || '-'}"). `
      + `Open it again or pick another one in Settings → 视频阅读器. ${available.length ? `On screen now: ${available.join(' | ')}` : ''}`,
    )
  }
  const cropped = captureInput(settings, { ...overrides, region: 'rect', rect: match.rect })
  return { ...cropped, label: `window "${match.window.title}" ${match.rect.width}x${match.rect.height}` }
}

/**
 * Capture one still.
 * @param {string} ffmpeg ffmpeg executable.
 * @param {{input: string[], label: string}} plan from {@link captureInput}.
 * @param {string} outPath destination `.jpg`.
 * @param {{width?: number, signal?: AbortSignal}} [options] render options.
 * @returns {Promise<{path: string, bytes: number}>} the written still.
 */
export async function captureStill(ffmpeg, plan, outPath, options = {}) {
  const { width = 0, signal } = options
  const args = [...plan.input, '-frames:v', '1']
  if (width > 0) args.push('-vf', `scale=${width}:-2`)
  args.push('-q:v', '4', outPath)
  const result = await run(ffmpeg, args, { signal, timeoutMs: 60_000 })
  const info = await stat(outPath).catch(() => undefined)
  if (result.code !== 0 || !info || info.size === 0) {
    throw new Error(`screen capture failed: ${result.stderr.trim().split(/\r?\n/).slice(-2).join(' ') || 'no output'}`)
  }
  return { path: outPath, bytes: info.size }
}

/**
 * Capture a short sequence of stills.
 * @param {string} ffmpeg ffmpeg executable.
 * @param {{input: string[], label: string, fps: number}} plan from {@link captureInput}.
 * @param {string} outDir directory for the numbered stills.
 * @param {{seconds?: number, width?: number, signal?: AbortSignal}} [options] capture options.
 * @returns {Promise<{paths: string[], seconds: number, fps: number}>} captured stills in order.
 */
export async function captureSequence(ffmpeg, plan, outDir, options = {}) {
  const { seconds = 3, width = 0, signal } = options
  await mkdir(outDir, { recursive: true })
  const pattern = path.join(outDir, 'screen_%03d.jpg')
  const args = [...plan.input, '-t', String(Math.max(0.2, seconds))]
  if (width > 0) args.push('-vf', `scale=${width}:-2`)
  args.push('-q:v', '4', pattern)
  const result = await run(ffmpeg, args, { signal, timeoutMs: Math.max(60_000, seconds * 6_000) })
  const entries = await readdir(outDir).catch(() => [])
  const paths = entries
    .filter((name) => /^screen_\d+\.jpg$/.test(name))
    .sort()
    .map((name) => path.join(outDir, name))
  if (paths.length === 0) {
    throw new Error(`screen capture produced no frames: ${result.stderr.trim().split(/\r?\n/).slice(-2).join(' ') || 'no output'}`)
  }
  return { paths, seconds, fps: plan.fps }
}
