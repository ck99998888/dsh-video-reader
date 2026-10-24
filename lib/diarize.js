/**
 * Speaker diarization through a local `sherpa-onnx` build.
 *
 * The offline diarization binary segments the audio (pyannote segmentation
 * model), embeds each segment (speaker embedding model), clusters the
 * embeddings, and prints `start -- end speaker_NN` lines. The plugin then
 * attributes every recognized cue to the speaker covering most of its span.
 *
 * Everything is local and CPU-only; no audio leaves the machine.
 */
import { access, constants, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { packageDir, run } from './ffmpeg.js'
import { asciiWorkspace, localRoot, stageFile } from './asr.js'

const exeSuffix = process.platform === 'win32' ? '.exe' : ''

const SEGMENTATION_CANDIDATES = [
  'sherpa-onnx-pyannote-segmentation-3-0.onnx',
  'segmentation-3.0.onnx',
  'segmentation.onnx',
]

/** Cross-language speaker embeddings, smallest useful first. */
const EMBEDDING_CANDIDATES = [
  '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  'wespeaker_en_voxceleb_CAM++_LM.onnx',
  'wespeaker_zh_cnceleb_resnet34.onnx',
  'nemo_en_titanet_small.onnx',
]

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

async function firstModelIn(dirs, names) {
  const explicit = await firstFile(dirs.flatMap((dir) => names.map((name) => path.join(dir, name))))
  if (explicit) return explicit
  for (const dir of dirs) {
    try {
      const entries = (await readdir(dir)).filter((name) => /\.onnx$/i.test(name))
      const match = entries.find((name) => /segmentation|speaker|embed/i.test(name))
      if (match) return path.join(dir, match)
    } catch { /* directory absent */ }
  }
  return undefined
}

/**
 * Resolve the diarization binary and its two models.
 * @param {{diarizationPath?: string, segmentationModel?: string, embeddingModel?: string}} config plugin Config.
 * @returns {Promise<{ready: boolean, binary?: string, segmentation?: string, embedding?: string, hint?: string}>} availability.
 */
export async function resolveDiarizer(config = {}) {
  const root = localRoot()
  const binaryDirs = [
    path.join(packageDir, 'tools', `${process.platform}-${process.arch}`),
    path.join(packageDir, 'tools'),
  ]
  const binary = await firstFile([
    config.diarizationPath,
    ...binaryDirs.map((dir) => path.join(dir, `sherpa-onnx-offline-speaker-diarization${exeSuffix}`)),
    ...binaryDirs.map((dir) => path.join(dir, `sherpa-onnx-offline-diarization${exeSuffix}`)),
    path.join(root, 'bin', `sherpa-onnx-offline-speaker-diarization${exeSuffix}`),
  ])
  const modelDirs = [path.join(packageDir, 'models'), path.join(root, 'models')]
  const segmentation = config.segmentationModel
    ? await firstFile([config.segmentationModel])
    : await firstModelIn(modelDirs, SEGMENTATION_CANDIDATES)
  const embedding = config.embeddingModel
    ? await firstFile([config.embeddingModel])
    : await firstModelIn(modelDirs, EMBEDDING_CANDIDATES)
  if (binary && segmentation && embedding) return { ready: true, binary, segmentation, embedding }
  const missing = [
    binary ? undefined : 'sherpa-onnx offline diarization binary',
    segmentation ? undefined : 'pyannote segmentation model',
    embedding ? undefined : 'speaker embedding model',
  ].filter(Boolean)
  return {
    ready: false,
    binary,
    segmentation,
    embedding,
    hint: `speaker diarization is unavailable (missing ${missing.join(', ')}); transcripts are still produced`,
  }
}

/**
 * Run diarization on a 16 kHz mono wav.
 * @param {{binary: string, segmentation: string, embedding: string}} diarizer resolved tools.
 * @param {string} wavPath absolute wav path.
 * @param {{numSpeakers?: number, threshold?: number, signal?: AbortSignal, timeoutMs?: number}} [options] clustering options.
 * @returns {Promise<{start: number, end: number, speaker: string}[]>} clustered speaker segments.
 */
export async function diarize(diarizer, wavPath, options = {}) {
  const { numSpeakers, threshold, signal, timeoutMs = 1_800_000 } = options
  let audio = wavPath
  let staged
  const workspace = asciiWorkspace()
  let segmentationModel = diarizer.segmentation
  let embeddingModel = diarizer.embedding
  if (workspace) {
    // sherpa-onnx also opens files with the narrow Windows API: stage non-ASCII paths.
    if (!/^[\x20-\x7E]+$/.test(segmentationModel)) {
      segmentationModel = await stageFile(segmentationModel, path.join(workspace, 'models', path.basename(segmentationModel)))
    }
    if (!/^[\x20-\x7E]+$/.test(embeddingModel)) {
      embeddingModel = await stageFile(embeddingModel, path.join(workspace, 'models', path.basename(embeddingModel)))
    }
    if (!/^[\x20-\x7E]+$/.test(wavPath)) {
      const tag = createHash('sha1').update(wavPath).digest('hex').slice(0, 10)
      audio = await stageFile(wavPath, path.join(workspace, 'work', `${tag}-diarize.wav`))
      staged = audio
    }
  }

  const args = [
    `--segmentation.pyannote-model=${segmentationModel}`,
    `--embedding.model=${embeddingModel}`,
  ]
  if (Number.isFinite(numSpeakers) && numSpeakers > 0) {
    args.push(`--clustering.num-clusters=${Math.round(numSpeakers)}`)
  } else if (Number.isFinite(threshold) && threshold > 0) {
    args.push(`--clustering.cluster-threshold=${threshold}`)
  }
  args.push(audio)

  try {
    const result = await run(diarizer.binary, args, { signal, timeoutMs })
    const output = `${result.stdout.toString('utf8')}\n${result.stderr}`
    const segments = []
    const pattern = /^\s*(-?\d+(?:\.\d+)?)\s*--\s*(-?\d+(?:\.\d+)?)\s+(\S+)\s*$/gm
    let match
    while ((match = pattern.exec(output)) !== null) {
      const start = Number(match[1])
      const end = Number(match[2])
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
      segments.push({ start, end, speaker: match[3] })
    }
    if (segments.length === 0) {
      const detail = output.split('\n').filter((line) => /error|failed|invalid/i.test(line)).slice(0, 2).join(' ')
      throw new Error(`diarization produced no segments${detail ? `: ${detail.trim()}` : ''}`)
    }
    return segments.sort((a, b) => a.start - b.start)
  } finally {
    if (staged) await import('node:fs/promises').then(({ rm }) => rm(staged, { force: true })).catch(() => {})
  }
}

/**
 * Attribute each cue to the speaker covering most of its span.
 * @param {{startSec: number, endSec: number}[]} cues recognized cues in order.
 * @param {{start: number, end: number, speaker: string}[]} segments diarization segments.
 * @returns {{speakers: string[], talkSeconds: Record<string, number>, attributed: number}} merge facts.
 */
export function assignSpeakers(cues, segments) {
  const labels = new Map()
  const talkSeconds = {}
  for (const segment of segments) {
    if (!labels.has(segment.speaker)) labels.set(segment.speaker, `S${labels.size + 1}`)
    const label = labels.get(segment.speaker)
    talkSeconds[label] = (talkSeconds[label] ?? 0) + (segment.end - segment.start)
  }
  let attributed = 0
  for (const cue of cues) {
    const span = Math.max(0.001, cue.endSec - cue.startSec)
    let best
    let bestOverlap = 0
    for (const segment of segments) {
      const overlap = Math.min(cue.endSec, segment.end) - Math.max(cue.startSec, segment.start)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = segment
      }
    }
    // Ignore slivers: attribution needs a real share of the cue.
    if (best && bestOverlap >= Math.min(0.5, Math.max(0.15, 0.3 * span))) {
      cue.speaker = labels.get(best.speaker)
      attributed += 1
    } else if (best && bestOverlap > 0) {
      cue.speaker = labels.get(best.speaker)
      attributed += 1
    }
  }
  return {
    speakers: [...labels.values()],
    talkSeconds,
    attributed,
  }
}

/**
 * Merge consecutive cues from the same speaker into conversation turns for the
 * model-facing transcript, keeping the timed cues for the SRT file.
 * @param {{startSec: number, endSec: number, text: string, speaker?: string}[]} cues attributed cues.
 * @returns {{speaker?: string, startSec: number, endSec: number, text: string}[]} turns.
 */
export function mergeTurns(cues) {
  const turns = []
  for (const cue of cues) {
    const last = turns[turns.length - 1]
    // Never merge unattributed cues: without a speaker, each cue stays its own line.
    if (last && cue.speaker !== undefined && last.speaker === cue.speaker && cue.startSec - last.endSec <= 1.5) {
      last.text = `${last.text} ${cue.text}`.trim()
      last.endSec = cue.endSec
      continue
    }
    turns.push({ speaker: cue.speaker, startSec: cue.startSec, endSec: cue.endSec, text: cue.text })
  }
  return turns
}
