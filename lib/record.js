/**
 * Background screen recording.
 *
 * One hour at 30 fps is 108,000 frames: far too many to keep as stills, and far
 * more than any model can look at. The honest shape for a long capture is a
 * video file at the requested frame rate, which the existing `video_read`
 * pipeline can sample afterwards. Recording therefore runs as a background
 * ffmpeg process owned by this plugin, with a duration cap and a byte cap so it
 * cannot fill the disk unattended.
 */
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'

const sessions = new Map()
let counter = 0

/**
 * Start one recording.
 * @param {{ffmpeg: string, input: string[], outPath: string, seconds?: number, maxBytes?: number, label?: string, fps?: number}} options capture plan.
 * @returns {{id: string, outPath: string, startedAt: number, label: string, fps: number}} the session summary.
 */
export function startRecording(options) {
  const {
    ffmpeg, input, outPath, seconds = 0, maxBytes = 0, label = 'screen', fps = 30,
    width = 0, crf = 30, preset = 'veryfast',
  } = options
  const args = [...input, '-an', '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-g', '60']
  if (width > 0) args.push('-vf', `scale=${Math.round(width)}:-2`)
  if (seconds > 0) args.push('-t', String(Math.round(seconds)))
  if (maxBytes > 0) args.push('-fs', String(Math.round(maxBytes)))
  args.push('-f', 'matroska', outPath)

  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  const id = `rec-${Date.now().toString(36)}-${++counter}`
  const session = {
    id,
    child,
    outPath,
    label,
    fps,
    startedAt: Date.now(),
    limitSeconds: seconds,
    limitBytes: maxBytes,
    stderr: '',
    exit: null,
  }
  child.on('error', (error) => { session.exit = { code: -1, at: Date.now(), error: String(error?.message ?? error) } })
  child.on('exit', (code, signal) => { session.exit = { code, signal, at: Date.now() } })
  child.stderr.on('data', (chunk) => { session.stderr = (session.stderr + chunk.toString('utf8')).slice(-4000) })
  sessions.set(id, session)

  return { id, outPath, startedAt: session.startedAt, label, fps }
}

/** Ask ffmpeg to finalize the file, then kill it if it does not stop in time. */
async function shutdown(session, timeoutMs = 5000) {
  if (session.exit) return
  try {
    session.child.stdin.write('q')
    session.child.stdin.end()
  } catch { /* already closed */ }
  const deadline = Date.now() + timeoutMs
  while (!session.exit && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  if (!session.exit) {
    try { session.child.kill() } catch { /* already gone */ }
    const hardDeadline = Date.now() + 3000
    while (!session.exit && Date.now() < hardDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
}

/**
 * Stop one recording and report what it produced.
 * @param {string} id session id.
 * @returns {Promise<object|undefined>} the final summary.
 */
export async function stopRecording(id) {
  const session = sessions.get(id)
  if (!session) return undefined
  await shutdown(session)
  sessions.delete(id)
  const info = await stat(session.outPath).catch(() => undefined)
  const endedAt = session.exit?.at ?? Date.now()
  return {
    id,
    path: session.outPath,
    label: session.label,
    fps: session.fps,
    seconds: Math.max(0, Math.round((endedAt - session.startedAt) / 1000)),
    bytes: info?.size ?? 0,
    code: session.exit?.code ?? null,
    note: session.exit?.code && session.exit.code !== 0 ? session.stderr.trim().split(/\r?\n/).slice(-2).join(' ') : undefined,
  }
}

/**
 * Snapshot every recording, including its current file size.
 * @returns {Promise<object[]>} active recordings.
 */
export async function listRecordings() {
  const rows = []
  for (const session of sessions.values()) {
    const info = await stat(session.outPath).catch(() => undefined)
    rows.push({
      id: session.id,
      path: session.outPath,
      label: session.label,
      fps: session.fps,
      elapsedSeconds: Math.round((Date.now() - session.startedAt) / 1000),
      bytes: info?.size ?? 0,
      running: !session.exit,
      note: session.exit && session.exit.code !== 0 ? session.stderr.trim().split(/\r?\n/).slice(-1)[0] : undefined,
      limitSeconds: session.limitSeconds,
      limitBytes: session.limitBytes,
    })
  }
  return rows
}

/** Stop every recording (used when the plugin unloads). */
export async function stopAll() {
  const ids = [...sessions.keys()]
  const results = []
  for (const id of ids) results.push(await stopRecording(id))
  return results
}
