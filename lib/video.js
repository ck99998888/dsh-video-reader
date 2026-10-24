/**
 * Media inspection built on `ffprobe` and `ffmpeg`.
 *
 * Everything here is a pure function of its inputs plus the resolved binary
 * paths, so the tool layer stays thin and the media behavior stays testable.
 */
import { mkdir, readdir, readFile, stat, writeFile, copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { run } from './ffmpeg.js'

const AUDIO_ONLY_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'])
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa', '.lrc']
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'microdvd', 'subviewer', 'sami', 'lrc',
])

/** `1:02:03.5`, `02:03`, `90.5`, `1m30s` → seconds. */
export function parseTimecode(input) {
  if (input === null || input === undefined || input === '') return undefined
  if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, input)
  const text = String(input).trim()
  const unitMatch = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(text)
  if (unitMatch && (unitMatch[1] || unitMatch[2] || unitMatch[3])) {
    return Number(unitMatch[1] ?? 0) * 3600 + Number(unitMatch[2] ?? 0) * 60 + Number(unitMatch[3] ?? 0)
  }
  const parts = text.split(':')
  if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part.trim()))) {
    throw new Error(`invalid timecode "${text}": use seconds, "MM:SS", or "HH:MM:SS"`)
  }
  return parts.reduce((total, part) => total * 60 + Number(part), 0)
}

/** Seconds → `H:MM:SS.mmm` for `ffmpeg -ss`. */
export function ffmpegTime(seconds) {
  const clamped = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const secs = clamped % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`
}

/** Seconds → compact human label (`1:23`, `1:02:03`). */
export function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`
}

/** Bytes → `12.4 MB`. */
export function bytes(value) {
  const n = Number(value) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function resolveFile(candidate, cwd) {
  const absolute = path.resolve(cwd ?? process.cwd(), String(candidate))
  const info = await stat(absolute).catch(() => undefined)
  if (!info) throw new Error(`video file not found: ${absolute}`)
  if (!info.isFile()) throw new Error(`not a regular file: ${absolute}`)
  return { path: absolute, size: info.size, mtimeMs: info.mtimeMs }
}

/**
 * Read container and stream metadata.
 * @param {string} ffprobe command.
 * @param {string} file absolute path.
 * @param {AbortSignal} [signal] cancellation.
 * @returns {Promise<any>} parsed `ffprobe -print_format json` output.
 */
export async function probe(ffprobe, file, signal) {
  const result = await run(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    file,
  ], { signal, timeoutMs: 60_000 })
  if (result.code !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(' ')
    throw new Error(`cannot read "${path.basename(file)}" as media: not a supported video or audio file (${detail})`)
  }
  try {
    return JSON.parse(result.stdout.toString('utf8'))
  } catch {
    throw new Error('ffprobe returned unreadable metadata')
  }
}

/** Normalize `ffprobe` output into the facts the model needs. */
export function summarizeProbe(probed, fileInfo) {
  const streams = Array.isArray(probed?.streams) ? probed.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
  const audio = streams.filter((stream) => stream.codec_type === 'audio')
  const subtitles = streams.filter((stream) => stream.codec_type === 'subtitle')
  const duration = Number(probed?.format?.duration)
    || Number(video?.duration)
    || Number(audio[0]?.duration)
    || 0
  const fpsRaw = video?.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video?.r_frame_rate
  let fps
  if (typeof fpsRaw === 'string' && fpsRaw.includes('/')) {
    const [num, den] = fpsRaw.split('/').map(Number)
    if (num > 0 && den > 0) fps = num / den
  }
  return {
    file: fileInfo.path,
    name: path.basename(fileInfo.path),
    extension: path.extname(fileInfo.path).toLowerCase(),
    sizeBytes: fileInfo.size,
    durationSeconds: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : 0,
    container: probed?.format?.format_name ?? '',
    bitRate: Number(probed?.format?.bit_rate) || undefined,
    hasVideo: Boolean(video),
    hasAudio: audio.length > 0,
    video: video
      ? {
        codec: video.codec_name,
        width: video.width,
        height: video.height,
        fps: fps ? Math.round(fps * 100) / 100 : undefined,
        frames: Number(video.nb_frames) || undefined,
        pixelFormat: video.pix_fmt,
      }
      : undefined,
    audioTracks: audio.map((stream) => ({
      codec: stream.codec_name,
      channels: stream.channels,
      sampleRate: Number(stream.sample_rate) || undefined,
      language: stream.tags?.language,
    })),
    subtitleStreams: subtitles.map((stream, index) => ({
      index,
      codec: stream.codec_name,
      language: stream.tags?.language,
      title: stream.tags?.title,
      textual: TEXT_SUBTITLE_CODECS.has(String(stream.codec_name)),
    })),
    chapters: (probed?.chapters ?? []).map((chapter) => ({
      start: Number(chapter.start_time),
      title: chapter.tags?.title,
    })),
    isAudioOnly: !video && audio.length > 0 && AUDIO_ONLY_EXTENSIONS.has(path.extname(fileInfo.path).toLowerCase()),
  }
}

/**
 * Pick `count` sample instants inside a window.
 * @param {number} durationSeconds media length.
 * @param {number} count wanted frames.
 * @param {{start?: number, end?: number}} window optional window in seconds.
 * @returns {number[]} ascending offsets.
 */
export function evenTimestamps(durationSeconds, count, window = {}) {
  const start = Math.max(0, window.start ?? 0)
  const end = Math.min(durationSeconds, window.end ?? durationSeconds)
  const span = end - start
  if (!(span > 0) || count <= 0) return []
  const step = span / count
  const times = []
  for (let index = 0; index < count; index += 1) {
    // Sample the middle of each slice: skips leader black and trailing cards.
    times.push(Math.round((start + step * (index + 0.5)) * 1000) / 1000)
  }
  return times
}

/**
 * Detect scene changes by decoding a small greyscale copy of the video.
 * @param {string} ffmpeg command.
 * @param {string} file absolute path.
 * @param {{threshold?: number, start?: number, end?: number, signal?: AbortSignal, limit?: number}} options detection window.
 * @returns {Promise<number[]>} ascending cut instants, capped at `limit`.
 */
export async function detectScenes(ffmpeg, file, options = {}) {
  const { threshold = 0.30, start, end, signal, limit = 40 } = options
  const args = ['-hide_banner', '-nostdin', '-i', file]
  if (start !== undefined && start > 0) args.push('-ss', ffmpegTime(start))
  if (end !== undefined) args.push('-to', ffmpegTime(end))
  args.push(
    '-an', '-sn',
    '-filter:v', `scale=320:-2,select='gt(scene,${threshold})',metadata=print:file=-`,
    '-f', 'null', '-',
  )
  const result = await run(ffmpeg, args, { signal, timeoutMs: 600_000 })
  const stdout = result.stdout.toString('utf8')
  const times = []
  const lines = stdout.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = /pts_time:(-?\d+(?:\.\d+)?)/.exec(lines[index])
    if (!match) continue
    const next = lines[index + 1] ?? ''
    if (!next.includes('scene_score')) continue
    const value = Number(match[1])
    if (Number.isFinite(value) && value >= 0) times.push(Math.round(value * 1000) / 1000)
  }
  const unique = [...new Set(times)].sort((a, b) => a - b)
  if (unique.length <= limit) return unique
  // Keep an evenly spaced subset that still spans the whole video.
  const stride = unique.length / limit
  return Array.from({ length: limit }, (_, index) => unique[Math.floor(index * stride)])
}

/**
 * Write one full-quality still at an instant.
 * @param {string} ffmpeg command.
 * @param {string} file absolute path.
 * @param {number} atSeconds seek target.
 * @param {string} outPath destination `.jpg`.
 * @param {{width?: number, signal?: AbortSignal, label?: string, fontFile?: string}} [options] render options.
 * @returns {Promise<void>} completion after the still exists.
 */
export async function extractFrame(ffmpeg, file, atSeconds, outPath, options = {}) {
  const { width = 0, signal, label, fontFile } = options
  const baseArgs = ['-hide_banner', '-nostdin', '-y', '-ss', ffmpegTime(atSeconds), '-i', file, '-frames:v', '1', '-an', '-sn']
  const scale = width > 0 ? `scale=${width}:-2` : ''
  const filters = []
  if (scale) filters.push(scale)

  const attempt = async (filterList) => {
    const args = [...baseArgs]
    if (filterList.length > 0) args.push('-vf', filterList.join(','))
    args.push('-q:v', '3', outPath)
    const result = await run(ffmpeg, args, { signal, timeoutMs: 120_000 })
    const info = await stat(outPath).catch(() => undefined)
    return result.code === 0 && info && info.size > 0 ? info : undefined
  }

  // A burned timecode makes "what happens at 0:12" answerable from one sheet.
  if (label) {
    const font = (fontFile ?? 'C:/Windows/Fonts/arial.ttf').replace(/\\/g, '/')
    const escapedFont = font.replace(/:/g, '\\:')
    const escapedLabel = String(label).replace(/\\/g, '').replace(/:/g, '\\:').replace(/'/g, '')
    const stamp = `drawtext=fontfile='${escapedFont}':text='${escapedLabel}':fontcolor=white:fontsize=h/18:x=w*0.03:y=h*0.04:box=1:boxcolor=black@0.55:boxborderw=h/90`
    if (await attempt([...filters, stamp])) return
    // Fonts or libfreetype can be missing; stills matter more than the stamp.
  }
  if (await attempt(filters)) return
  throw new Error(`could not extract a frame at ${clock(atSeconds)}`)
}

/**
 * Tile the extracted stills into one contact sheet.
 * @param {string} ffmpeg command.
 * @param {string[]} framePaths numbered stills in display order.
 * @param {string} outPath destination `.jpg`.
 * @param {{columns?: number, tileWidth?: number, signal?: AbortSignal}} options grid shape.
 * @returns {Promise<{columns: number, rows: number}>} the grid that was written.
 */
export async function buildContactSheet(ffmpeg, framePaths, outPath, options = {}) {
  const { columns = 4, tileWidth = 320, signal } = options
  const count = framePaths.length
  if (count === 0) throw new Error('no frames to tile')
  let cols = Math.min(Math.max(1, columns), count)
  // Prefer a grid that divides the frame count so no tile is a duplicate.
  if (cols > 1) {
    for (let candidate = cols; candidate >= 2; candidate -= 1) {
      if (count % candidate === 0) {
        cols = candidate
        break
      }
    }
  }
  const rows = Math.ceil(count / cols)
  const tileHeight = Math.round((tileWidth * 9) / 16 / 2) * 2

  // `tile` needs a complete grid; repeat the final still to fill the remainder.
  const dir = path.dirname(framePaths[0])
  const pattern = path.join(dir, 'tile_%03d.jpg')
  const padded = cols * rows
  for (let index = 0; index < padded; index += 1) {
    const source = framePaths[Math.min(index, count - 1)]
    await copyFile(source, pattern.replace('%03d', String(index + 1).padStart(3, '0')))
  }
  const filter = [
    `scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease`,
    `pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:color=0x141414`,
    `tile=${cols}x${rows}:padding=6:margin=10:color=0x141414`,
  ].join(',')
  const result = await run(ffmpeg, [
    '-hide_banner', '-nostdin', '-y',
    '-framerate', '1', '-start_number', '1', '-i', pattern,
    '-vf', filter, '-frames:v', '1', '-q:v', '3', outPath,
  ], { signal, timeoutMs: 120_000 })
  const info = await stat(outPath).catch(() => undefined)
  if (result.code !== 0 || !info || info.size === 0) {
    throw new Error(`could not build the contact sheet: ${result.stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`)
  }
  return { columns: cols, rows }
}

/** Decode a subtitle file, tolerating UTF-8 BOMs and GBK/big5 sources. */
function decodeText(buffer) {
  const bytes = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? buffer.subarray(3)
    : buffer
  const utf8 = bytes.toString('utf8')
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf-8' }
  for (const encoding of ['gb18030', 'big5']) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: false }).decode(bytes)
      if (!decoded.includes('\uFFFD')) return { text: decoded, encoding }
    } catch { /* decoder unavailable, try the next one */ }
  }
  return { text: utf8, encoding: 'utf-8 (lossy)' }
}

/** Strip cues, timestamps, and ASS override tags into readable prose. */
export function subtitleToPlainText(raw) {
  const stripped = String(raw)
    .replace(/^\uFEFF/, '')
    .replace(/\[Script Info\][\s\S]*?(?=\[Events\]|$)/i, '')
    .replace(/\{[^}]*\}/g, '')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return false
      if (/^WEBVTT/i.test(trimmed)) return false
      if (/^\d+$/.test(trimmed)) return false
      if (/^\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}\s*-->/.test(trimmed)) return false
      if (/^(Dialogue|Format|Style|Comment):/i.test(trimmed)) return false
      return true
    })
    .join('\n')
  return stripped.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Extract every textual subtitle stream embedded in the container.
 * @param {string} ffmpeg command.
 * @param {string} file absolute path.
 * @param {{index: number, codec: string, language?: string, title?: string, textual: boolean}[]} streams parsed stream facts.
 * @param {string} outDir cache directory.
 * @param {AbortSignal} [signal] cancellation.
 * @returns {Promise<{text: string, language?: string, tracks: object[]}>} merged subtitle text plus per-track facts.
 */
export async function extractEmbeddedSubtitles(ffmpeg, file, streams, outDir, signal) {
  const tracks = []
  const chunks = []
  for (const stream of streams) {
    if (!stream.textual) {
      tracks.push({ ...stream, status: 'image-based', reason: 'bitmap subtitles cannot be turned into text' })
      continue
    }
    const outPath = path.join(outDir, `subtitle_${stream.index}.srt`)
    const result = await run(ffmpeg, [
      '-hide_banner', '-nostdin', '-y', '-i', file, '-map', `0:s:${stream.index}`, '-f', 'srt', outPath,
    ], { signal, timeoutMs: 120_000 })
    if (result.code !== 0) {
      tracks.push({ ...stream, status: 'failed', reason: result.stderr.trim().split(/\r?\n/).slice(-1)[0] })
      continue
    }
    const decoded = decodeText(await readFile(outPath))
    const plain = subtitleToPlainText(decoded.text)
    tracks.push({ ...stream, status: 'ok', path: outPath, cues: (decoded.text.match(/-->/g) ?? []).length })
    if (plain) chunks.push({ language: stream.language, title: stream.title, text: plain })
  }
  return { text: chunks.map((chunk) => chunk.text).join('\n\n'), tracks }
}

/**
 * Find subtitle files sitting next to the video.
 * @param {string} file absolute video path.
 * @returns {Promise<{text: string, files: {path: string, encoding: string, cues: number}[]}>} merged sidecar text.
 */
export async function readSidecarSubtitles(file) {
  const dir = path.dirname(file)
  const base = path.basename(file, path.extname(file))
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { text: '', files: [] }
  }
  const matches = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const lower = name.toLowerCase()
      if (!SUBTITLE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return false
      return lower.startsWith(base.toLowerCase() + '.')
    })
    .slice(0, 6)
  const files = []
  const chunks = []
  for (const name of matches) {
    const full = path.join(dir, name)
    const decoded = decodeText(await readFile(full))
    const plain = subtitleToPlainText(decoded.text)
    files.push({ path: full, encoding: decoded.encoding, cues: (decoded.text.match(/-->/g) ?? []).length })
    if (plain) chunks.push(plain)
  }
  return { text: chunks.join('\n\n'), files }
}

/**
 * Decode the audio track to 16 kHz mono PCM for speech recognition.
 * @param {string} ffmpeg command.
 * @param {string} file absolute path.
 * @param {string} outPath destination `.wav`.
 * @param {{signal?: AbortSignal, durationSeconds?: number}} [options] limits.
 * @returns {Promise<string>} the written wav path.
 */
export async function extractAudioWav(ffmpeg, file, outPath, options = {}) {
  const { signal, durationSeconds } = options
  const timeoutMs = Math.min(3_600_000, Math.max(120_000, (durationSeconds ?? 60) * 3_000))
  const result = await run(ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-i', file,
    '-vn', '-sn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath,
  ], { signal, timeoutMs })
  const info = await stat(outPath).catch(() => undefined)
  if (result.code !== 0 || !info || info.size <= 44) throw new Error('the file has no decodable audio track')
  return outPath
}

/** Stable cache directory for one media file. */
export async function cacheDirFor(root, fileInfo) {
  const { createHash } = await import('node:crypto')
  const key = createHash('sha1')
    .update(`${fileInfo.path}|${fileInfo.size}|${Math.round(fileInfo.mtimeMs)}`)
    .digest('hex')
    .slice(0, 12)
  const base = path.basename(fileInfo.path).replace(/[^\w.-]+/g, '_').slice(0, 48)
  const dir = path.join(root, `${base}-${key}`)
  await mkdir(dir, { recursive: true })
  return dir
}

export { resolveFile }

/**
 * Keep the cache from growing without bound: retain the most recently used
 * directories and delete the rest.
 * @param {string} root cache root directory.
 * @param {number} [keep] how many media directories to retain.
 * @returns {Promise<void>} completion after best-effort cleanup.
 */
export async function pruneCache(root, keep = 20) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const directories = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(root, entry.name)
      const info = await stat(full).catch(() => undefined)
      if (info) directories.push({ full, mtimeMs: info.mtimeMs })
    }
    if (directories.length <= keep) return
    directories.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const stale of directories.slice(keep)) {
      await rm(stale.full, { recursive: true, force: true }).catch(() => {})
    }
  } catch { /* pruning is best effort */ }
}
