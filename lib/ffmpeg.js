/**
 * Locating and running the media binaries the video reader depends on.
 *
 * Resolution order for `ffmpeg`/`ffprobe`:
 *   1. the explicit Config value (`ffmpegPath` / `ffprobePath`),
 *   2. a platform directory shipped next to this plugin (`tools/win32-x64/`, `tools/win32/`, `tools/`),
 *   3. the user-local install directory (`%LOCALAPPDATA%\dsh-video-reader\bin`),
 *   4. the bare command name, which lets the OS resolve it from `PATH`.
 *
 * Every run is a plain `spawn` with an argument array (no shell), so paths with
 * spaces, quotes, or CJK characters need no escaping.
 */
import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Absolute directory of this plugin package. */
export const packageDir = path.resolve(here, '..')

const exeSuffix = process.platform === 'win32' ? '.exe' : ''

const localInstallBin = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'dsh-video-reader', 'bin')
  : ''

const bundledDirs = [
  path.join(packageDir, 'tools', `${process.platform}-${process.arch}`),
  path.join(packageDir, 'tools', process.platform),
  path.join(packageDir, 'tools'),
]

async function isExecutable(candidate) {
  try {
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve one media binary.
 * @param {'ffmpeg'|'ffprobe'} name binary base name.
 * @param {string|undefined} explicit configured absolute path.
 * @returns {Promise<string>} an absolute path when one was found, otherwise the bare command name.
 */
export async function findBinary(name, explicit) {
  if (explicit) return explicit
  const candidates = []
  for (const dir of bundledDirs) candidates.push(path.join(dir, name + exeSuffix))
  if (localInstallBin) candidates.push(path.join(localInstallBin, name + exeSuffix))
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }
  return name
}

/** Remove characters that break `ffmpeg` filter expressions. */
export function escapeFilterPath(value) {
  return String(value).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * Run one process and collect its output.
 * @param {string} command executable path or bare name.
 * @param {string[]} args argument vector.
 * @param {{signal?: AbortSignal, timeoutMs?: number, maxBytes?: number}} [options] limits.
 * @returns {Promise<{code: number, stdout: Buffer, stderr: string}>} the settled process result.
 */
export function run(command, args, options = {}) {
  const { signal, timeoutMs = 300_000, maxBytes = 64 * 1024 * 1024 } = options
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let settled = false
    let timer

    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(new Error(`${path.basename(command)} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }

    const onAbort = () => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes <= maxBytes) out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length
      // Keep a rolling tail: ffmpeg reports the actionable error last.
      err.push(chunk)
      while (errBytes > 256 * 1024) {
        const dropped = err.shift()
        errBytes -= dropped.length
      }
    })
    child.on('error', (error) => {
      if (error && error.code === 'ENOENT') {
        finish(new Error(`${command} was not found. Install ffmpeg or set its path in the plugin Config.`))
        return
      }
      finish(error)
    })
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      finish(null, { code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/** Describe the resolved toolchain so the model can report a missing dependency precisely. */
export async function describeToolchain(config = {}) {
  const ffmpeg = await findBinary('ffmpeg', config.ffmpegPath)
  const ffprobe = await findBinary('ffprobe', config.ffprobePath)
  const probe = async (command) => {
    try {
      const result = await run(command, ['-version'], { timeoutMs: 15_000 })
      if (result.code !== 0) return { command, ok: false, reason: result.stderr.trim().split(/\r?\n/)[0] || `exit ${result.code}` }
      const first = result.stdout.toString('utf8').split(/\r?\n/)[0].trim()
      return { command, ok: true, version: first }
    } catch (error) {
      return { command, ok: false, reason: error?.message ?? String(error) }
    }
  }
  return { ffmpeg: await probe(ffmpeg), ffprobe: await probe(ffprobe) }
}
