/**
 * Speech recognition through a local `whisper.cpp` build.
 *
 * One multilingual model (large-v3-turbo by default) covers Chinese, English,
 * German, Korean, Japanese, French, Russian and ~90 more languages, so the
 * plugin ships a single recognizer instead of one model per language.
 *
 * whisper.cpp opens files with the narrow (ANSI) Windows API, so a model or
 * audio path containing CJK characters makes it abort while loading the model.
 * Non-ASCII paths are therefore staged through an ASCII-only working directory.
 */
import { access, constants, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { run, packageDir } from './ffmpeg.js'

/** Most accurate first; any ggml model dropped into `models/` is also accepted. */
const MODEL_CANDIDATES = [
  'ggml-large-v3-turbo-q5_0.bin',
  'ggml-large-v3-turbo-q8_0.bin',
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3-q5_0.bin',
  'ggml-medium-q5_0.bin',
  'ggml-small.bin',
  'ggml-base.bin',
  'ggml-tiny.bin',
]

const ASCII_ONLY = /^[\x20-\x7E]+$/

async function isFile(candidate) {
  try {
    await access(candidate, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function firstFile(candidates) {
  for (const candidate of candidates) {
    if (candidate && await isFile(candidate)) return candidate
  }
  return undefined
}

/** Directory where an optional local install keeps binaries and models. */
export function localRoot() {
  return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'dsh-video-reader') : path.join(packageDir, '.local')
}

/** An ASCII-only scratch root that whisper.cpp and sherpa-onnx can always open. */
export function asciiWorkspace() {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'dsh-video-reader') : undefined,
    'C:\\ProgramData\\dsh-video-reader',
    path.join(os.tmpdir(), 'dsh-video-reader'),
  ]
  for (const candidate of candidates) {
    if (candidate && ASCII_ONLY.test(candidate)) return candidate
  }
  return undefined
}

/** Copy `source` to `destination` unless an equally sized copy is already there. */
export async function stageFile(source, destination) {
  const [from, to] = await Promise.all([
    stat(source).catch(() => undefined),
    stat(destination).catch(() => undefined),
  ])
  if (from && to && from.size === to.size) return destination
  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(source, destination)
  return destination
}

/**
 * Resolve the recognizer binary and its multilingual model.
 * @param {{whisperPath?: string, whisperModel?: string}} config plugin Config.
 * @returns {Promise<{binary?: string, model?: string, ready: boolean, hint?: string}>} availability facts.
 */
export async function resolveRecognizer(config = {}) {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const root = localRoot()
  const binary = await firstFile([
    config.whisperPath,
    path.join(packageDir, 'tools', `${process.platform}-${process.arch}`, `whisper-cli${exe}`),
    path.join(packageDir, 'tools', `${process.platform}-${process.arch}`, `main${exe}`),
    path.join(packageDir, 'tools', `whisper-cli${exe}`),
    path.join(root, 'bin', `whisper-cli${exe}`),
    path.join(root, 'bin', `main${exe}`),
  ])
  let model = await firstFile([
    config.whisperModel,
    ...MODEL_CANDIDATES.map((name) => path.join(packageDir, 'models', name)),
    ...MODEL_CANDIDATES.map((name) => path.join(root, 'models', name)),
  ])
  if (!model) {
    for (const dir of [path.join(packageDir, 'models'), path.join(root, 'models')]) {
      try {
        const entries = (await readdir(dir)).filter((name) => /^ggml-.*\.bin$/i.test(name))
        if (entries.length > 0) {
          model = path.join(dir, entries[0])
          break
        }
      } catch { /* directory absent */ }
    }
  }
  if (binary && model) return { binary, model, ready: true }
  return {
    binary,
    model,
    ready: false,
    hint: 'Speech recognition needs whisper.cpp (whisper-cli) plus a ggml model; set whisperPath and whisperModel in the plugin Config to enable transcripts.',
  }
}

/** `00:00:03,600` → 3.6 seconds. */
function srtTimeToSeconds(value) {
  const match = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(value)
  if (!match) return undefined
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000
}

/** Convert whisper's SRT into cues carrying both the display stamp and seconds. */
function srtToTranscript(srt) {
  const cues = []
  for (const block of srt.replace(/\r/g, '').split('\n\n')) {
    const lines = block.split('\n').filter(Boolean)
    if (lines.length < 2) continue
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex === -1) continue
    const [fromRaw, toRaw] = lines[timeIndex].split('-->').map((part) => part.trim())
    const text = lines.slice(timeIndex + 1).join(' ').trim()
    if (!text) continue
    cues.push({
      start: fromRaw,
      end: toRaw,
      startSec: srtTimeToSeconds(fromRaw) ?? 0,
      endSec: srtTimeToSeconds(toRaw) ?? 0,
      text,
    })
  }
  return cues
}

/**
 * Transcribe one 16 kHz mono wav file.
 * @param {{binary: string, model: string}} recognizer resolved tools.
 * @param {string} wavPath absolute wav path.
 * @param {{language?: string, threads?: number, signal?: AbortSignal, timeoutMs?: number, saveSrt?: string}} [options] run options.
 * @returns {Promise<{text: string, cues: object[], outPath: string}>} the transcript.
 */
export async function transcribeWav(recognizer, wavPath, options = {}) {
  const { language = 'auto', signal, timeoutMs = 3_600_000, saveSrt } = options
  const threads = options.threads ?? Math.max(2, Math.min(12, os.cpus().length - 1))

  let model = recognizer.model
  let audio = wavPath
  // Every run needs its own output base: a shared name would let a crashed run
  // hand an older transcript back as if it were fresh.
  const tag = createHash('sha1')
    .update(`${wavPath}|${(await stat(wavPath).catch(() => ({ size: 0 }))).size}`)
    .digest('hex')
    .slice(0, 10)
  let outBase = path.join(path.dirname(wavPath), `transcript-${tag}`)
  let stagedAudio
  const workspace = asciiWorkspace()
  if (workspace && (!ASCII_ONLY.test(model) || !ASCII_ONLY.test(wavPath))) {
    if (!ASCII_ONLY.test(model)) {
      model = await stageFile(model, path.join(workspace, 'models', path.basename(model)))
    }
    if (!ASCII_ONLY.test(wavPath)) {
      const staged = path.join(workspace, 'work', `${tag}-audio.wav`)
      audio = await stageFile(wavPath, staged)
      stagedAudio = audio
    }
    outBase = path.join(workspace, 'work', `transcript-${tag}`)
  }

  try {
    const srtPath = `${outBase}.srt`
    await rm(srtPath, { force: true }).catch(() => {})
    const result = await run(recognizer.binary, [
      '-m', model,
      '-f', audio,
      '-l', language,
      '-t', String(threads),
      '-osrt',
      '-of', outBase,
    ], { signal, timeoutMs })
    const srt = await readFile(srtPath, 'utf8').catch(() => undefined)
    if (!srt) {
      const detail = result.stderr.trim().split(/\r?\n/).filter((line) => !/^\s*$/.test(line)).slice(-2).join(' ')
      throw new Error(`speech recognition produced no output${detail ? `: ${detail}` : ''}`)
    }
    let outPath = srtPath
    if (saveSrt) {
      await writeFile(saveSrt, srt, 'utf8').catch(() => undefined)
      outPath = saveSrt
    }
    const cues = srtToTranscript(srt)
    return {
      text: cues.map((cue) => cue.text).join(' ').replace(/\s+/g, ' ').trim(),
      cues,
      outPath,
    }
  } finally {
    if (stagedAudio) await rm(stagedAudio, { force: true }).catch(() => {})
  }
}
