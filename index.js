/**
 * video-reader — let the agent watch and listen to video and audio files.
 *
 * Tools:
 *   video_read   — one call returns metadata, a contact sheet the model can see,
 *                  frame paths, subtitle text, and (when a local whisper.cpp is
 *                  installed) a speech transcript.
 *   video_frames — full-quality stills at explicit instants.
 *
 * The plugin depends only on Node built-ins plus the two media binaries.
 */
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { findBinary, describeToolchain } from './lib/ffmpeg.js'
import * as media from './lib/video.js'
import { resolveRecognizer, transcribeWav } from './lib/asr.js'
import { resolveDiarizer, diarize, assignSpeakers, mergeTurns } from './lib/diarize.js'
import { readSettings, writeSettings, DEFAULT_SETTINGS } from './lib/settings.js'
import { captureInput, planCapture, captureStill, captureSequence } from './lib/capture.js'
import { listWindows } from './lib/windows.js'
import { startRecording, stopRecording, listRecordings, stopAll } from './lib/record.js'
import { startWatcher, stopWatcher, listWatchers, stopAllWatchers } from './lib/watch.js'

export const inject = ['tools']

const MAX_FRAMES = 40
const MAX_STILL_REQUESTS = 8

/** Readable defaults; every value can be overridden from the plugin Config. */
function normalizeSettings(config = {}) {
  return {
    ffmpegPath: config.ffmpegPath || undefined,
    ffprobePath: config.ffprobePath || undefined,
    frames: clampInt(config.frames, 12, 1, MAX_FRAMES),
    columns: clampInt(config.columns, 4, 1, 8),
    frameWidth: clampInt(config.frameWidth, 960, 0, 3840),
    tileWidth: clampInt(config.tileWidth, 320, 96, 960),
    maxTextChars: clampInt(config.maxTextChars, 12000, 500, 60000),
    maxTranscriptSeconds: clampInt(config.maxTranscriptSeconds, 900, 5, 14400),
    languages: typeof config.languages === 'string' && config.languages.trim() ? config.languages.trim() : 'auto',
    fontFile: typeof config.fontFile === 'string' && config.fontFile.trim() ? config.fontFile.trim() : undefined,
    cacheDir: typeof config.cacheDir === 'string' && config.cacheDir.trim() ? config.cacheDir.trim() : '.dsh-video-cache',
    whisperPath: config.whisperPath || undefined,
    whisperModel: config.whisperModel || undefined,
    diarize: config.diarize !== false,
    speakers: clampInt(config.speakers, 0, 0, 8),
    diarizationThreshold: Number.isFinite(Number(config.diarizationThreshold))
      ? Math.min(0.95, Math.max(0.1, Number(config.diarizationThreshold)))
      : 0.5,
    diarizationPath: config.diarizationPath || undefined,
    segmentationModel: config.segmentationModel || undefined,
    embeddingModel: config.embeddingModel || undefined,
  }
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Tool values must be lossless JSON: strip `undefined` from probe-derived objects. */
function jsonSafe(value) {
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry))
  if (value && typeof value === 'object') {
    const output = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) output[key] = jsonSafe(entry)
    }
    return output
  }
  return value
}

function truncate(text, limit) {
  if (!text) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… (${text.length - limit} more characters in the file listed above)`
}

/** Session-relative working directory, falling back to the process directory. */
async function workingDirectory(ctx, exec) {
  try {
    const service = ctx.get('workingDirectory')
    const directory = await service?.ensure(exec.agent)
    if (directory) return directory
  } catch { /* service absent or agent-less call */ }
  return process.cwd()
}

/** Resolve both binaries and fail with the actionable setup message. */
async function toolchain(settings) {
  const ffmpeg = await findBinary('ffmpeg', settings.ffmpegPath)
  const ffprobe = await findBinary('ffprobe', settings.ffprobePath)
  return { ffmpeg, ffprobe }
}

function missingBinaryError(name, error) {
  if (name === 'ffprobe' || name === 'ffmpeg') {
    void error
    return new Error(
      `${name} is not available. Install ffmpeg (both ffmpeg and ffprobe) or point ffmpegPath/ffprobePath at it in the video-reader plugin Config.`,
    )
  }
  return error
}

function audioChannelLabel(streams) {
  if (!streams || streams.length === 0) return 'none'
  const first = streams[0]
  const parts = [first.codec ?? 'audio']
  if (first.channels) parts.push(`${first.channels}ch`)
  if (first.sampleRate) parts.push(`${first.sampleRate} Hz`)
  return `${parts.join(' ')}${streams.length > 1 ? ` (+${streams.length - 1} more track(s))` : ''}`
}

function videoLabel(info) {
  if (!info.video) return info.hasAudio ? 'no video stream' : 'no decodable stream'
  const parts = [`${info.video.codec} ${info.video.width}x${info.video.height}`]
  if (info.video.fps) parts.push(`${info.video.fps} fps`)
  return parts.join(' · ')
}

/** Build the model-visible text for one `video_read` result. */
function composeBrief({ info, timestamps, framePaths, sheet, subtitles, transcript, settings, notes }) {
  const lines = []
  lines.push(`# ${info.hasVideo ? 'Video' : 'Audio'}: ${info.name}`)
  lines.push(`path: ${info.file}`)
  lines.push(`duration: ${media.clock(info.durationSeconds)} (${info.durationSeconds}s) · ${media.bytes(info.sizeBytes)} · ${info.container || 'unknown container'}`)
  lines.push(`video: ${videoLabel(info)}`)
  lines.push(`audio: ${audioChannelLabel(info.audioTracks)}`)
  if (info.chapters.length > 0) {
    lines.push(`chapters: ${info.chapters.slice(0, 30).map((chapter) => `${media.clock(chapter.start)} ${chapter.title ?? ''}`.trim()).join(' | ')}`)
  }
  if (framePaths.length > 0) {
    lines.push('')
    lines.push(`## Frames (${framePaths.length} stills${sheet ? `, contact sheet ${sheet.columns}x${sheet.rows}` : ''})`)
    if (sheet) lines.push(`contact sheet: ${sheet.path}${sheet.shown ? ' (shown below)' : ' — call read_image on it'}`)
    for (let index = 0; index < framePaths.length; index += 1) {
      lines.push(`${String(index + 1).padStart(2, '0')}  ${media.clock(timestamps[index])}  ${framePaths[index]}`)
    }
  } else if (!info.hasVideo) {
    lines.push('')
    lines.push('## Frames')
    lines.push('(no video stream — this is an audio-only file)')
  }
  if (subtitles && (subtitles.text || subtitles.tracks?.length > 0)) {
    lines.push('')
    const sources = []
    if (subtitles.sidecarFiles?.length) sources.push(`sidecar: ${subtitles.sidecarFiles.map((file) => path.basename(file.path)).join(', ')}`)
    const embedded = subtitles.tracks ?? []
    if (embedded.length > 0) {
      sources.push(`embedded: ${embedded.map((track) => `#${track.index} ${track.codec}/${track.status}${track.language ? ` ${track.language}` : ''}`).join(', ')}`)
    }
    lines.push(`## Subtitles (${sources.join(' · ')})`)
    lines.push(subtitles.text ? truncate(subtitles.text, settings.maxTextChars) : '(no textual cues found)')
  }
  if (transcript) {
    lines.push('')
    if (transcript.status === 'ok') {
      const speakerNote = transcript.speakers?.length > 1
        ? `, ${transcript.speakers.length} speakers: ${transcript.speakers.join('/')}`
        : transcript.speakers?.length === 1 ? ', 1 speaker' : ''
      lines.push(`## Speech transcript (${transcript.language}, ${transcript.turns.length} turns${speakerNote})`)
      if (transcript.talk && Object.keys(transcript.talk).length > 0) {
        lines.push(`talk time: ${Object.entries(transcript.talk).map(([label, seconds]) => `${label} ${media.clock(seconds)}`).join(' · ')}`)
      }
      lines.push(transcript.text ? truncate(transcript.text, settings.maxTextChars) : '(silence — nothing recognized)')
      lines.push(`full timestamped SRT: ${transcript.outPath}`)
    } else {
      lines.push('## Speech transcript')
      lines.push(`unavailable: ${transcript.reason}`)
    }
  }
  if (notes.length > 0) {
    lines.push('')
    lines.push('## Notes')
    for (const note of notes) lines.push(`- ${note}`)
  }
  return lines.join('\n')
}

function imageArraySchema(description) {
  return {
    type: 'array',
    description,
    items: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        attachment: { type: 'object' },
      },
    },
  }
}

export function apply(ctx, rawConfig = {}) {
  const settings = normalizeSettings(rawConfig)

  async function saveImages(exec, entries) {
    const attachments = ctx.get('attachments')
    if (!attachments || entries.length === 0) return { images: [], shown: false }
    const payloads = []
    for (const entry of entries) {
      try {
        const data = new Uint8Array(await readFile(entry.path))
        payloads.push({ entry, data })
      } catch { /* a missing still just does not get shown */ }
    }
    if (payloads.length === 0) return { images: [], shown: false }
    try {
      const refs = await attachments.saveImages(payloads.map(({ entry, data }) => ({
        data,
        mediaType: entry.mediaType ?? 'image/jpeg',
        name: entry.name ?? path.basename(entry.path),
      })))
      return {
        images: refs.map((attachment, index) => ({ label: payloads[index].entry.label, attachment })),
        shown: true,
      }
    } catch (error) {
      // A refused attachment (size, pixel budget) must not fail the whole read.
      return { images: [], shown: false, reason: error?.message ?? String(error) }
    }
  }

  async function videoRead(args, exec) {
    const signal = exec.signal
    const notes = []
    const cwd = await workingDirectory(ctx, exec)

    let fileInfo
    try {
      fileInfo = await media.resolveFile(args.path, cwd)
    } catch (error) {
      throw new Error(error.message)
    }
    const { ffmpeg, ffprobe } = await toolchain(settings)

    let probed
    try {
      probed = await media.probe(ffprobe, fileInfo.path, signal)
    } catch (error) {
      if (String(error?.message ?? '').includes('was not found')) throw missingBinaryError('ffprobe', error)
      throw error
    }
    const info = media.summarizeProbe(probed, fileInfo)

    const start = media.parseTimecode(args.start)
    const end = media.parseTimecode(args.end)
    const cacheRoot = path.resolve(cwd, settings.cacheDir)
    const dir = await media.cacheDirFor(cacheRoot, fileInfo)
    void media.pruneCache(cacheRoot, 20)
    const framesDir = path.join(dir, 'frames')
    await mkdir(framesDir, { recursive: true })

    // ---- stills -----------------------------------------------------------
    const wantFrames = info.hasVideo && args.frames !== 0
    const requestedFrames = args.frames === undefined ? settings.frames : clampInt(args.frames, settings.frames, 0, MAX_FRAMES)
    let timestamps = []
    let framePaths = []
    let sheet
    if (wantFrames && requestedFrames > 0) {
      const mode = args.mode === 'scenes' ? 'scenes' : 'even'
      if (mode === 'scenes') {
        try {
          const cuts = await media.detectScenes(ffmpeg, fileInfo.path, { start, end, signal, limit: requestedFrames })
          if (cuts.length >= 2) timestamps = cuts
          else notes.push('scene detection found fewer than two cuts; fell back to even sampling')
        } catch (error) {
          notes.push(`scene detection failed (${error?.message ?? error}); fell back to even sampling`)
        }
      }
      if (timestamps.length === 0) {
        timestamps = media.evenTimestamps(info.durationSeconds, requestedFrames, { start, end })
        if (timestamps.length === 0) timestamps = [start ?? 0]
      }
      const frameWidth = args.width === undefined ? settings.frameWidth : clampInt(args.width, settings.frameWidth, 0, 3840)
      for (let index = 0; index < timestamps.length; index += 1) {
        const target = path.join(framesDir, `frame_${String(index + 1).padStart(3, '0')}.jpg`)
        try {
          await media.extractFrame(ffmpeg, fileInfo.path, timestamps[index], target, {
            width: frameWidth,
            signal,
            label: media.clock(timestamps[index]),
            fontFile: settings.fontFile,
          })
          framePaths.push(target)
        } catch (error) {
          notes.push(`frame at ${media.clock(timestamps[index])} failed: ${error?.message ?? error}`)
          timestamps[index] = undefined
        }
      }
      const kept = timestamps.filter((value) => value !== undefined)
      timestamps = kept
      if (framePaths.length > 0 && args.sheet !== false) {
        try {
          const sheetPath = path.join(dir, 'contact-sheet.jpg')
          const grid = await media.buildContactSheet(ffmpeg, framePaths, sheetPath, { columns: settings.columns, tileWidth: settings.tileWidth, signal })
          sheet = { path: sheetPath, columns: grid.columns, rows: grid.rows, shown: false }
        } catch (error) {
          notes.push(`contact sheet failed: ${error?.message ?? error}`)
        }
      }
    }

    // ---- subtitles --------------------------------------------------------
    let subtitles
    if (args.subtitles !== false) {
      const sidecar = await media.readSidecarSubtitles(fileInfo.path)
      let embedded = { text: '', tracks: [] }
      if (info.subtitleStreams.length > 0) {
        try {
          embedded = await media.extractEmbeddedSubtitles(ffmpeg, fileInfo.path, info.subtitleStreams, dir, signal)
        } catch (error) {
          notes.push(`embedded subtitle extraction failed: ${error?.message ?? error}`)
        }
      }
      const text = [sidecar.text, embedded.text].filter(Boolean).join('\n\n')
      subtitles = { text, sidecarFiles: sidecar.files, tracks: embedded.tracks }
      for (const track of embedded.tracks ?? []) {
        if (track.status === 'image-based') notes.push(`subtitle #${track.index} (${track.codec}) is bitmap-only and was skipped`)
      }
    }

    // ---- transcript -------------------------------------------------------
    let transcript
    if (args.transcript !== false && info.hasAudio) {
      const recognizer = await resolveRecognizer(settings)
      if (!recognizer.ready) {
        transcript = { status: 'unavailable', reason: recognizer.hint }
        notes.push('speech recognition is not installed; subtitles and frames still apply')
      } else if (info.durationSeconds > settings.maxTranscriptSeconds && start === undefined && end === undefined) {
        transcript = {
          status: 'unavailable',
          reason: `audio is ${media.clock(info.durationSeconds)}, longer than maxTranscriptSeconds (${settings.maxTranscriptSeconds}); pass start/end to transcribe a window`,
        }
      } else {
        try {
          const wavPath = path.join(dir, 'audio.wav')
          await media.extractAudioWav(ffmpeg, fileInfo.path, wavPath, { signal, durationSeconds: info.durationSeconds })
          const language = typeof args.language === 'string' && args.language.trim() ? args.language.trim() : settings.languages
          const heard = await transcribeWav(recognizer, wavPath, { language, signal })

          // ---- who said what ------------------------------------------------
          let speakers = []
          let talk = {}
          const wantDiarization = args.diarize !== false && settings.diarize
          if (wantDiarization && heard.cues.length > 0) {
            const diarizer = await resolveDiarizer(settings)
            if (diarizer.ready) {
              try {
                const segments = await diarize(diarizer, wavPath, {
                  numSpeakers: args.speakers ?? settings.speakers,
                  threshold: settings.diarizationThreshold,
                  signal,
                })
                const merged = assignSpeakers(heard.cues, segments)
                speakers = merged.speakers
                talk = merged.talkSeconds
                if (merged.attributed < heard.cues.length) {
                  notes.push(`${heard.cues.length - merged.attributed} of ${heard.cues.length} cues fell outside every speaker segment`)
                }
              } catch (error) {
                notes.push(`speaker diarization failed: ${error?.message ?? error}`)
              }
            } else {
              notes.push(diarizer.hint)
            }
          }

          const turns = mergeTurns(heard.cues)
          const speakerLines = turns.map((turn) => {
            const prefix = turn.speaker ? `[${turn.speaker}] ` : ''
            return `${prefix}${media.clock(turn.startSec)}–${media.clock(turn.endSec)}  ${turn.text}`
          })
          const srtText = heard.cues.map((cue, index) => {
            const stamp = (seconds) => {
              const hours = Math.floor(seconds / 3600)
              const minutes = Math.floor((seconds % 3600) / 60)
              const secs = seconds % 60
              return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs.toFixed(3).replace('.', ',')}`
            }
            return `${index + 1}\n${stamp(cue.startSec)} --> ${stamp(cue.endSec)}\n${cue.speaker ? `[${cue.speaker}] ` : ''}${cue.text}\n`
          }).join('\n')
          const { writeFile } = await import('node:fs/promises')
          const srtPath = path.join(dir, 'transcript.srt')
          await writeFile(srtPath, srtText, 'utf8')
          await writeFile(path.join(dir, 'transcript.txt'), speakerLines.join('\n'), 'utf8')

          transcript = {
            status: 'ok',
            language: language === 'auto' ? 'auto-detected' : language,
            speakers,
            talk,
            turns,
            text: speakerLines.join('\n'),
            outPath: srtPath,
            model: path.basename(recognizer.model),
          }
        } catch (error) {
          transcript = { status: 'unavailable', reason: `speech recognition failed: ${error?.message ?? error}` }
        }
      }
    }

    // ---- images -----------------------------------------------------------
    const showing = []
    if (sheet) showing.push({ path: sheet.path, label: 'contact sheet', name: `${info.name} contact sheet` })
    const saved = await saveImages(exec, showing)
    if (sheet) {
      sheet.shown = saved.shown
      if (!saved.shown && saved.reason) notes.push(`contact sheet not attached (${saved.reason}); call read_image on its path`)
      else if (!ctx.get('attachments')) notes.push('no attachment store is mounted; call read_image on the contact sheet path')
    }

    const brief = composeBrief({ info, timestamps, framePaths, sheet, subtitles, transcript, settings, notes })
    return jsonSafe({
      brief,
      images: saved.images,
      file: info.file,
      duration: info.durationSeconds,
      frames: framePaths.map((framePath, index) => ({ at: timestamps[index], timestamp: media.clock(timestamps[index]), path: framePath })),
      sheet: sheet ? { path: sheet.path, columns: sheet.columns, rows: sheet.rows } : null,
      subtitles: subtitles ? { chars: subtitles.text?.length ?? 0, sidecar: subtitles.sidecarFiles ?? [], tracks: subtitles.tracks ?? [] } : null,
      transcript: transcript ? {
        status: transcript.status,
        language: transcript.language,
        speakers: transcript.speakers,
        chars: transcript.text?.length ?? 0,
        turns: transcript.turns?.length,
        srt: transcript.outPath,
        reason: transcript.reason,
      } : null,
      notes,
    })
  }

  async function videoFrames(args, exec) {
    const signal = exec.signal
    const cwd = await workingDirectory(ctx, exec)
    const fileInfo = await media.resolveFile(args.path, cwd)
    const { ffmpeg, ffprobe } = await toolchain(settings)
    const probed = await media.probe(ffprobe, fileInfo.path, signal)
    const info = media.summarizeProbe(probed, fileInfo)
    if (!info.hasVideo) throw new Error('this file has no video stream; use video_read for audio-only metadata and transcript')

    const requested = Array.isArray(args.timestamps) ? args.timestamps.slice(0, MAX_STILL_REQUESTS) : []
    if (requested.length === 0) throw new Error('pass at least one timestamp, for example ["0:30", "1:15"]')
    const times = requested.map((value) => {
      const seconds = media.parseTimecode(value)
      if (seconds === undefined) throw new Error(`invalid timestamp: ${value}`)
      return seconds
    })

    const dir = await media.cacheDirFor(path.resolve(cwd, settings.cacheDir), fileInfo)
    const framesDir = path.join(dir, 'stills')
    await mkdir(framesDir, { recursive: true })
    const width = args.width === undefined ? 1280 : clampInt(args.width, 1280, 0, 3840)
    const entries = []
    for (let index = 0; index < times.length; index += 1) {
      const target = path.join(framesDir, `still_${String(index + 1).padStart(3, '0')}.jpg`)
      await media.extractFrame(ffmpeg, fileInfo.path, times[index], target, {
        width,
        signal,
        label: media.clock(times[index]),
        fontFile: settings.fontFile,
      })
      entries.push({ path: target, label: media.clock(times[index]), name: `${info.name} at ${media.clock(times[index])}` })
    }
    const saved = await saveImages(exec, entries)
    const lines = [`# ${info.name} stills (${entries.length})`, `duration: ${media.clock(info.durationSeconds)} · ${videoLabel(info)}`]
    for (let index = 0; index < entries.length; index += 1) {
      lines.push(`${String(index + 1).padStart(2, '0')}  ${media.clock(times[index])}  ${entries[index].path}`)
    }
    if (!saved.shown) lines.push('', 'images are not attached on this route; call read_image on each path')
    return jsonSafe({
      brief: lines.join('\n'),
      images: saved.images,
      frames: entries.map((entry, index) => ({ at: times[index], timestamp: media.clock(times[index]), path: entry.path })),
    })
  }

  /**
   * Capture the live desktop (or one window / rectangle) as a short frame
   * sequence, then hand back a contact sheet the model can see.
   */
  async function screenCapture(args, exec) {
    const signal = exec.signal
    const stored = await readSettings()
    if (stored.enabled === false) {
      throw new Error('screen capture is disabled. Enable it in Settings → 视频阅读器 (Video Reader) → 屏幕捕获.')
    }
    const cwd = await workingDirectory(ctx, exec)
    const ffmpeg = await findBinary('ffmpeg', settings.ffmpegPath)
    const seconds = args.seconds === undefined ? stored.seconds : clampInt(args.seconds, stored.seconds, 0, 30)
    let fps = args.fps === undefined ? stored.fps : clampInt(args.fps, stored.fps, 1, 30)
    const width = args.width === undefined ? stored.width : clampInt(args.width, stored.width, 320, 3840)
    // Bound the number of JPEGs one capture writes: 240 frames at the default
    // width is roughly 35 MB, and the sheet never shows more than a few dozen.
    let budgetNote
    if (seconds > 0) {
      const allowed = Math.max(1, Math.floor(240 / seconds))
      if (fps > allowed) {
        budgetNote = `fps capped to ${allowed} so one capture stays within 240 frames`
        fps = allowed
      }
    }
    const plan = await planCapture(stored, {
      region: args.region,
      fps,
      drawMouse: args.mouse === undefined ? stored.drawMouse : args.mouse,
    })

    const dir = path.join(path.resolve(cwd, settings.cacheDir), `screen-${Date.now()}`)
    await mkdir(dir, { recursive: true })

    let framePaths = []
    if (seconds <= 0) {
      const single = path.join(dir, 'screen.jpg')
      await captureStill(ffmpeg, plan, single, { width, signal })
      framePaths = [single]
    } else {
      const grabbed = await captureSequence(ffmpeg, plan, dir, { seconds, width, signal })
      framePaths = grabbed.paths
    }

    // Every captured frame is kept and listed. Reading happens in batches so a
    // long capture cannot silently degrade into a thumbnail overview.
    const manifestPath = path.join(dir, 'manifest.json')
    await writeFile(manifestPath, `${JSON.stringify({ createdAt: Date.now(), fps, seconds, region: plan.label, width, frames: framePaths }, null, 2)}\n`, 'utf8')

    const batchSize = args.batch === undefined ? stored.readBatch : clampInt(args.batch, stored.readBatch, 1, 40)
    const batch = framePaths.slice(0, batchSize)
    const saved = await saveImages(exec, batch.map((framePath, index) => ({ path: framePath, label: `frame ${index + 1}`, name: path.basename(framePath) })))
    let sheetPath
    let grid
    if (args.sheet === true && framePaths.length > 1) {
      sheetPath = path.join(dir, 'screen-sheet.jpg')
      grid = await media.buildContactSheet(ffmpeg, framePaths, sheetPath, { columns: 4, tileWidth: 400, signal })
    }

    const lines = [`# Screen capture — ${plan.label}`]
    lines.push(`captured: ${seconds > 0 ? `${framePaths.length} frames over ${seconds}s at ${fps} fps` : 'single still'}`)
    if (budgetNote) lines.push(`note: ${budgetNote}`)
    lines.push(`read rule: every frame must be read — ${saved.shown ? `${batch.length} attached now` : 'none attached (no attachment store)'}${framePaths.length > batch.length ? `, ${framePaths.length - batch.length} remain` : ', none remain'}`)
    lines.push(`manifest: ${manifestPath}`)
    for (let index = 0; index < framePaths.length; index += 1) {
      const at = seconds > 0 ? `${(index * (seconds / Math.max(1, framePaths.length))).toFixed(2)}s` : 'now'
      lines.push(`${String(index + 1).padStart(3, '0')}  ${at}  ${framePaths[index]}`)
    }
    if (framePaths.length > batch.length) {
      lines.push('', `NEXT: call screen_frames_read {"manifest":"${manifestPath}","offset":${batch.length},"count":${batchSize}} before drawing conclusions.`)
    }
    if (sheetPath) lines.push(`contact sheet (overview only, never a substitute): ${sheetPath}`)
    lines.push('', 'This is a sample of the desktop during the capture window, not a live stream.')

    return jsonSafe({
      brief: lines.join('\n'),
      images: saved.images,
      region: plan.label,
      manifest: manifestPath,
      totalFrames: framePaths.length,
      readFrames: batch.length,
      remainingFrames: Math.max(0, framePaths.length - batch.length),
      frames: framePaths.map((framePath, index) => ({ index, path: framePath })),
      sheet: sheetPath ? { path: sheetPath, columns: grid?.columns, rows: grid?.rows } : null,
    })
  }

  /** Page through the remaining frames of one capture, all of them. */
  async function screenFramesRead(args, exec) {
    const manifestPath = String(args.manifest ?? '')
    if (!manifestPath) throw new Error('pass the manifest path returned by screen_capture')
    const raw = await readFile(manifestPath, 'utf8').catch(() => undefined)
    if (!raw) throw new Error(`cannot read capture manifest: ${manifestPath}`)
    const manifest = JSON.parse(raw)
    const all = Array.isArray(manifest.frames) ? manifest.frames : []
    const offset = clampInt(args.offset, 0, 0, Math.max(0, all.length))
    const count = args.count === undefined ? 20 : clampInt(args.count, 20, 1, 40)
    const slice = all.slice(offset, offset + count)
    if (slice.length === 0) throw new Error(`offset ${offset} is past the end of this capture (${all.length} frames)`)
    const saved = await saveImages(exec, slice.map((framePath, index) => ({ path: framePath, label: `frame ${offset + index + 1}`, name: path.basename(framePath) })))
    const next = offset + slice.length
    const lines = [
      `# Frames ${offset + 1}–${next} of ${all.length}`,
      `capture: ${manifest.region} · ${manifest.fps} fps · ${manifest.seconds}s`,
    ]
    for (let index = 0; index < slice.length; index += 1) lines.push(`${String(offset + index + 1).padStart(3, '0')}  ${slice[index]}`)
    if (next < all.length) {
      lines.push('', `NEXT: screen_frames_read {"manifest":"${manifestPath}","offset":${next},"count":${count}} — ${all.length - next} frames still unread.`)
    } else {
      lines.push('', 'all frames of this capture are now read')
    }
    return jsonSafe({
      brief: lines.join('\n'),
      images: saved.images,
      manifest: manifestPath,
      totalFrames: all.length,
      readFrames: next,
      remainingFrames: Math.max(0, all.length - next),
    })
  }

  /**
   * The real-time path: sample on an interval, wake the agent only on change.
  		 * A watcher keeps its own event log, so even when the wake call is
   * unavailable the agent can drain changes with action:"status".
   */
  async function screenWatch(args, exec) {
    const stored = await readSettings()
    if (stored.enabled === false) {
      throw new Error('screen capture is disabled. Enable it in Settings → 视频阅读器 → 屏幕捕获.')
    }
    const action = String(args.action ?? 'status')

    if (action === 'status') {
      const rows = listWatchers()
      const brief = rows.length === 0
        ? 'no watcher is running'
        : rows.map((row) => {
          const latest = row.events.length > 0
            ? row.events.map((event) => `${(event.elapsedMs / 1000).toFixed(1)}s Δ${event.score} ${event.path}`).join('\n  ')
            : 'no change yet'
          return `${row.id} · ${row.label} · ${row.elapsedSeconds}s · every ${row.intervalMs}ms · Δ≥${row.threshold} · ${row.changes} changes\n  ${latest}`
        }).join('\n')
      return jsonSafe({ brief, watchers: rows })
    }

    if (action === 'stop') {
      const running = listWatchers()
      const stopped = args.id ? stopWatcher(String(args.id)) : (running[0] ? stopWatcher(running[0].id) : undefined)
      if (!stopped) throw new Error('no watcher with that id is running')
      const brief = [
        `# Watcher stopped — ${stopped.label}`,
        `${stopped.seconds}s · ${stopped.changes} changes · ${stopped.wakes} wake-ups`,
        stopped.lastError ? `last error: ${stopped.lastError}` : '',
        ...stopped.events.map((event) => `${(event.elapsedMs / 1000).toFixed(1)}s Δ${event.score} ${event.path}`),
      ].filter(Boolean).join('\n')
      return jsonSafe({ brief, ...stopped })
    }

    const cwd = await workingDirectory(ctx, exec)
    const ffmpeg = await findBinary('ffmpeg', settings.ffmpegPath)
    const intervalMs = clampInt(args.intervalMs, stored.watchIntervalMs, 500, 60000)
    const threshold = typeof args.threshold === 'number' ? args.threshold : stored.watchThreshold
    const maxMinutes = clampInt(args.maxMinutes, stored.watchMinutes, 1, 240)
    const plan = await planCapture(stored, { region: args.region, fps: 5, drawMouse: stored.drawMouse })
    const dir = path.join(path.resolve(cwd, settings.cacheDir), `watch-${Date.now()}`)
    await mkdir(dir, { recursive: true })

    // Waking the agent is best effort: the watcher's own event log is the
    // fallback, so a missing API never loses the observations.
    const agent = exec.agent
    const notify = (event) => {
      const text = `屏幕发生变化（第 ${(event.elapsedMs / 1000).toFixed(1)} 秒，差异 ${event.score}）。新画面：${event.path}\n用 read_image 看这张图，然后判断是否需要继续处理。`
      try { agent?.inject?.({ content: [{ type: 'text', text }] }) } catch { /* older agent API */ }
      try { agent?.followup?.() } catch { /* not wakeable */ }
    }

    const started = startWatcher({
      ffmpeg,
      plan,
      dir,
      intervalMs,
      threshold,
      maxMinutes,
      onChange: notify,
      width: stored.width,
    })
    const brief = [
      `# Watching — ${plan.label}`,
      `id: ${started.id}`,
      `sampling every ${intervalMs}ms · change threshold Δ${threshold} · auto-stop after ${maxMinutes} min`,
      `changed frames: ${dir}`,
      '',
      'It runs in the background. When the picture changes I wake you with the new frame;',
      'screen_watch {"action":"status"} drains pending changes, {"action":"stop"} ends it.',
    ].join('\n')
    return jsonSafe({ brief, ...started })
  }

  /**
   * Long captures are recordings, not frame piles: one hour at 30 fps is
   * 108,000 frames, which only makes sense as a video the reader can sample.
   */
  async function screenRecord(args, exec) {
    const stored = await readSettings()
    if (stored.enabled === false) {
      throw new Error('screen capture is disabled. Enable it in Settings → 视频阅读器 → 屏幕捕获.')
    }
    const action = String(args.action ?? 'status')

    if (action === 'status') {
      const rows = await listRecordings()
      const brief = rows.length === 0
        ? 'no recording is running'
        : rows.map((row) => `${row.id} · ${row.label} · ${row.elapsedSeconds}s · ${(row.bytes / 1024 / 1024).toFixed(1)}MB · ${row.fps}fps · ${row.running ? 'recording' : 'stopped'}${row.note ? ` (${row.note})` : ''} · ${row.path}`).join('\n')
      return jsonSafe({ brief, recordings: rows })
    }

    if (action === 'stop') {
      const stopped = args.id ? await stopRecording(String(args.id)) : (await stopAll())[0]
      if (!stopped) throw new Error('no recording with that id is running')
      const brief = [
        `# Recording stopped — ${stopped.label}`,
        `file: ${stopped.path}`,
        `duration: ${stopped.seconds}s · size: ${(stopped.bytes / 1024 / 1024).toFixed(1)}MB · ${stopped.fps} fps`,
        stopped.note ? `note: ${stopped.note}` : '',
        '',
        `Read it with video_read {"path": "${stopped.path}", "transcript": false}.`,
      ].filter(Boolean).join('\n')
      return jsonSafe({ brief, ...stopped })
    }

    const cwd = await workingDirectory(ctx, exec)
    const ffmpeg = await findBinary('ffmpeg', settings.ffmpegPath)
    const fps = args.fps === undefined ? stored.recordFps : clampInt(args.fps, stored.recordFps, 1, 30)
    const seconds = args.seconds === undefined ? stored.recordSeconds : clampInt(args.seconds, stored.recordSeconds, 10, 7200)
    const maxMB = args.maxMB === undefined ? stored.recordMaxMB : clampInt(args.maxMB, stored.recordMaxMB, 100, 20000)
    const plan = await planCapture(stored, {
      region: args.region,
      fps,
      drawMouse: stored.drawMouse,
    })
    const dir = path.join(path.resolve(cwd, settings.cacheDir), 'recordings')
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    const outPath = path.join(dir, `rec-${stamp}.mkv`)
    const started = startRecording({
      ffmpeg,
      input: plan.input,
      outPath,
      seconds,
      maxBytes: maxMB * 1024 * 1024,
      label: plan.label,
      fps,
      width: args.width === undefined ? stored.recordWidth : clampInt(args.width, stored.recordWidth, 0, 3840),
      crf: 30,
      preset: 'veryfast',
    })
    const brief = [
      `# Recording started — ${plan.label}`,
      `id: ${started.id}`,
      `file: ${outPath}`,
      `capture: ${fps} fps · up to ${seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`} · size cap ${maxMB} MB · 1280-wide h264 crf30`,
      `disk: about 350 MB per hour at 1280 wide (measured on this machine)`,
      '',
      `It runs in the background. Call screen_record {"action":"stop","id":"${started.id}"} to finalize,`,
      'then read the result with video_read (transcript: false) to sample whichever part matters.',
    ].join('\n')
    return jsonSafe({ brief, ...started })
  }

  const readOutputSchema = {
    type: 'object',
    description: 'Video facts plus the attachment references of the images shown to the model.',
    properties: {
      brief: { type: 'string' },
      file: { type: 'string' },
      duration: { type: 'number' },
      frames: { type: 'array', items: { type: 'object' } },
      sheet: { oneOf: [{ type: 'object' }, { type: 'null' }] },
      subtitles: { oneOf: [{ type: 'object' }, { type: 'null' }] },
      transcript: { oneOf: [{ type: 'object' }, { type: 'null' }] },
      notes: { type: 'array', items: { type: 'string' } },
      images: imageArraySchema('Images attached to this result.'),
    },
  }

  ctx.effect(() => {
    const disposers = []

    disposers.push(ctx.tools.register({
      name: 'video_read',
      description: [
        'Watch and listen to a video or audio file in one call. Returns container/stream facts,',
        'a contact sheet of sampled stills that you can see directly, the path of every still,',
        'any embedded or sidecar subtitle text, and a speech transcript with per-turn timestamps.',
        'Speech recognition is multilingual (Chinese, English, German, Korean, Japanese, French, Russian and ~90 more)',
        'and, when the local diarizer is installed, labels which speaker said each turn (S1, S2, …).',
        'Use it whenever the user asks about the content of a video, movie, screen recording, or meeting recording,',
        'and before answering anything that depends on what happens on screen or in the audio.',
        'For a closer look at a specific instant afterwards, call video_frames.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the video/audio file, or a path relative to the session working directory.' },
          frames: { type: 'integer', minimum: 0, maximum: MAX_FRAMES, description: 'How many stills to sample (default 12, 0 to skip frames).' },
          mode: {
            type: 'string',
            enum: ['even', 'scenes'],
            description: 'even = spread evenly across the whole video (default); scenes = prefer scene cuts, useful for slides or edited footage.',
          },
          start: { type: 'string', description: 'Optional window start, e.g. "90", "1:30", "00:01:30".' },
          end: { type: 'string', description: 'Optional window end, same formats as start.' },
          transcript: { type: 'boolean', description: 'Transcribe the audio track (default true). Only works when whisper.cpp and a model are configured.' },
          speakers: {
            type: 'integer',
            minimum: 0,
            maximum: 8,
            description: 'Expected number of distinct speakers; 0 (default) lets the diarizer decide. Set it when you already know the cast size.',
          },
          diarize: { type: 'boolean', description: 'Label who said what (default true when the diarizer is installed).' },
          subtitles: { type: 'boolean', description: 'Extract subtitle text, embedded tracks and sidecar files (default true).' },
          sheet: { type: 'boolean', description: 'Build and show the tiled contact sheet (default true).' },
          language: { type: 'string', description: 'Spoken language for the transcript, e.g. "zh", "en"; default auto-detect.' },
          width: { type: 'integer', description: 'Width in pixels for each extracted still (default 960, 0 keeps the source size).' },
        },
        required: ['path'],
      },
      output: {
        schema: readOutputSchema,
        render(args, value) {
          const blocks = [{ type: 'text', text: value?.brief ?? 'no content' }]
          for (const image of value?.images ?? []) {
            if (image?.attachment) blocks.push({ type: 'image', attachment: image.attachment })
          }
          return blocks
        },
      },
      timeoutMs: 900_000,
      presentCall(args) {
        return { card: 'generic', title: `Read video ${path.basename(String(args?.path ?? ''))}`, kind: 'read', rawInput: args }
      },
      execute: videoRead,
    }))

    disposers.push(ctx.tools.register({
      name: 'video_frames',
      description: 'Extract full-width stills of a video at exact timestamps and return them as images you can see. Use after video_read when a detail needs a closer look.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Video file path (absolute or relative to the session working directory).' },
          timestamps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Instants to capture, e.g. ["12", "1:30", "00:02:05"]. At most 8 per call.',
          },
          width: { type: 'integer', description: 'Still width in pixels (default 1280, 0 keeps the source size).' },
        },
        required: ['path', 'timestamps'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            brief: { type: 'string' },
            frames: { type: 'array', items: { type: 'object' } },
            images: imageArraySchema('Images attached to this result.'),
          },
        },
        render(args, value) {
          const blocks = [{ type: 'text', text: value?.brief ?? 'no content' }]
          for (const image of value?.images ?? []) {
            if (image?.attachment) blocks.push({ type: 'image', attachment: image.attachment })
          }
          return blocks
        },
      },
      timeoutMs: 300_000,
      presentCall(args) {
        return { card: 'generic', title: `Grab stills from ${path.basename(String(args?.path ?? ''))}`, kind: 'read', rawInput: args }
      },
      execute: videoFrames,
    }))

    disposers.push(ctx.tools.register({
      name: 'screen_capture',
      description: [
        'Look at what is on the desktop right now, or over the next few seconds.',
        'Captures the screen (full desktop, one window by title, or an x,y,w,h rectangle) and returns',
        'a contact sheet you can see, plus the path of every captured frame.',
        'Use it whenever the answer depends on what the user currently sees: a playing video, a game,',
        'a chart, an app dialog, an error message, or anything they call "this screen".',
        'Capture is sampled: the model sees the frames that existed during the capture window, not a live stream,',
        'so a longer window plus a higher fps is what "watching" a moving picture means here.',
        'For a file on disk use video_read instead.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'number', minimum: 0, maximum: 30, description: 'Capture window in seconds (0 = one still). Default from the settings page.' },
          fps: { type: 'integer', minimum: 1, maximum: 30, description: 'Frames per second during the window (default 2). 30 is the practical ceiling on this machine; captures are capped at 240 frames total.' },
          region: {
            type: 'string',
            description: 'Override the capture area: "full", "window:<窗口标题>", or "x,y,w,h". Default from the settings page.',
          },
          batch: { type: 'integer', minimum: 1, maximum: 40, description: 'How many frames to attach in this call (default 20). The rest are read with screen_frames_read; every captured frame must be read.' },
          width: { type: 'integer', minimum: 320, maximum: 3840, description: 'Width of each captured frame in pixels.' },
          mouse: { type: 'boolean', description: 'Draw the mouse pointer into the capture.' },
          sheet: { type: 'boolean', description: 'Also build a tiled overview (default false; an overview never replaces reading the frames).' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            brief: { type: 'string' },
            region: { type: 'string' },
            frames: { type: 'array', items: { type: 'object' } },
            sheet: { oneOf: [{ type: 'object' }, { type: 'null' }] },
            images: imageArraySchema('Images attached to this result.'),
          },
        },
        render(args, value) {
          const blocks = [{ type: 'text', text: value?.brief ?? 'no content' }]
          for (const image of value?.images ?? []) {
            if (image?.attachment) blocks.push({ type: 'image', attachment: image.attachment })
          }
          return blocks
        },
      },
      timeoutMs: 180_000,
      presentCall(args) {
        const region = args?.region ? ` (${args.region})` : ''
        return { card: 'generic', title: `Look at the screen${region}`, kind: 'read', rawInput: args }
      },
      execute: screenCapture,
    }))

    disposers.push(ctx.tools.register({
      name: 'screen_frames_read',
      description: 'Read the next batch of frames from a capture started by screen_capture. screen_capture attaches the first batch and tells you how many remain; call this until remainingFrames is 0 so every captured frame is actually read.',
      parameters: {
        type: 'object',
        properties: {
          manifest: { type: 'string', description: 'The manifest path returned by screen_capture.' },
          offset: { type: 'integer', minimum: 0, description: 'Index of the first frame to read (0-based).' },
          count: { type: 'integer', minimum: 1, maximum: 40, description: 'How many frames to attach (default 20).' },
        },
        required: ['manifest'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            brief: { type: 'string' },
            totalFrames: { type: 'integer' },
            readFrames: { type: 'integer' },
            remainingFrames: { type: 'integer' },
            images: imageArraySchema('The frames of this batch.'),
          },
        },
        render(args, value) {
          const blocks = [{ type: 'text', text: value?.brief ?? 'no content' }]
          for (const image of value?.images ?? []) {
            if (image?.attachment) blocks.push({ type: 'image', attachment: image.attachment })
          }
          return blocks
        },
      },
      timeoutMs: 120_000,
      presentCall(args) {
        return { card: 'generic', title: `Read screen frames from ${path.basename(String(args?.manifest ?? ''))}`, kind: 'read', rawInput: args }
      },
      execute: screenFramesRead,
    }))

    disposers.push(ctx.tools.register({
      name: 'screen_watch',
      description: [
        'Watch the screen continuously: a second, real-time path beside one-shot capture.',
        'It samples on an interval, measures how much the picture changed, and only when it changed',
        'does it save a full-size frame and wake you with that frame. Use it for "keep an eye on this",',
        'a playing video, a build log, or any状态 that changes over time. Actions: start, stop, status.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start watching, stop a watcher, or list what is running.' },
          id: { type: 'string', description: 'Watcher id returned by start (stop only).' },
          intervalMs: { type: 'integer', minimum: 500, maximum: 60000, description: 'Sampling interval (default 2000 ms).' },
          threshold: { type: 'number', minimum: 0.002, maximum: 0.5, description: 'Normalized change needed to count as a change (default 0.02).' },
          maxMinutes: { type: 'integer', minimum: 1, maximum: 240, description: 'Auto-stop after this many minutes (default 30).' },
          region: { type: 'string', description: 'Same override as screen_capture.' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            brief: { type: 'string' },
            id: { type: 'string' },
            watchers: { type: 'array', items: { type: 'object' } },
          },
        },
        render(args, value) {
          return [{ type: 'text', text: value?.brief ?? 'no content' }]
        },
      },
      timeoutMs: 120_000,
      presentCall(args) {
        return { card: 'generic', title: `Screen watch: ${String(args?.action ?? 'status')}`, kind: 'execute', rawInput: args }
      },
      execute: screenWatch,
    }))

    disposers.push(ctx.tools.register({
      name: 'screen_record',
      description: [
        'Record the screen or one application window at a steady frame rate, in the background.',
        'Use this instead of screen_capture when the user wants a long stretch: an hour at 30 fps is a',
        'recording, not a pile of stills. Actions: "start" (returns an id and the .mkv path), "status",',
        'and "stop" (finalizes the file). Afterwards read the file with video_read to sample the part that matters.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start a recording, stop one, or list what is running.' },
          id: { type: 'string', description: 'Recording id returned by start (stop only).' },
          seconds: { type: 'integer', minimum: 10, maximum: 7200, description: 'Maximum duration (default 3600 = 1 hour).' },
          fps: { type: 'integer', minimum: 1, maximum: 30, description: 'Recording frame rate (default 30).' },
          region: { type: 'string', description: 'Override the area: "full", "window:<标题>", or "x,y,w,h". Default from the settings page.' },
          maxMB: { type: 'integer', minimum: 100, maximum: 20000, description: 'Stop writing at this file size (default 2000 MB).' },
          width: { type: 'integer', minimum: 320, maximum: 3840, description: 'Downscale before encoding to save disk (default: native).' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            brief: { type: 'string' },
            id: { type: 'string' },
            path: { type: 'string' },
            recordings: { type: 'array', items: { type: 'object' } },
          },
        },
        render(args, value) {
          return [{ type: 'text', text: value?.brief ?? 'no content' }]
        },
      },
      timeoutMs: 120_000,
      presentCall(args) {
        const action = String(args?.action ?? 'status')
        return { card: 'generic', title: `Screen recording: ${action}`, kind: 'execute', rawInput: args }
      },
      execute: screenRecord,
    }))

    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* already disposed */ }
      }
      // A recording must not outlive the plugin.
      void stopAll()
      void stopAllWatchers()
    }
  })

  // ---- settings page API -------------------------------------------------
  // The Client settings page is same-origin, so a small prefix route is enough:
  // no RPC layer, and the tool reads the same JSON file on its next call.
  ctx.inject(['webServer'], (webCtx) => {
    const sendJson = (res, status, body) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    }
    const readBody = async (req, limit = 65536) => {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > limit) throw new Error('request body too large')
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      return text ? JSON.parse(text) : {}
    }

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.replace(/^\/video-reader/, '') || '/'
      try {
        if (route === '/settings' && (req.method === 'GET' || req.method === 'HEAD')) {
          sendJson(res, 200, await readSettings())
          return
        }
        if (route === '/settings' && req.method === 'POST') {
          const patch = await readBody(req)
          sendJson(res, 200, await writeSettings(patch))
          return
        }
        if (route === '/defaults') {
          sendJson(res, 200, DEFAULT_SETTINGS)
          return
        }
        if (route === '/status') {
          const clientModules = ctx.get('clientModules')
          let moduleIds = []
          try {
            const graph = clientModules?.graph?.()
            moduleIds = graph?.modules ? Object.keys(graph.modules) : Object.keys(graph ?? {})
          } catch { /* diagnostics only */ }
          sendJson(res, 200, {
            clientGraphIds: moduleIds.slice(0, 60),
            clientModulePresent: moduleIds.includes('@local/dsh-video-reader'),
            clientPath: clientModules?.clientPath?.('@local/dsh-video-reader') ?? null,
            captureAllowed: (await readSettings()).enabled !== false,
          })
          return
        }
        if (route === '/windows') {
          sendJson(res, 200, { windows: await listWindows(0) })
          return
        }
        if (route === '/watch/status') {
          sendJson(res, 200, { watchers: listWatchers() })
          return
        }
        if (route === '/watch/start' && req.method === 'POST') {
          const body = await readBody(req)
          const stored = await readSettings()
          const ffmpeg = await findBinary('ffmpeg', settings.ffmpegPath)
          const intervalMs = clampInt(body?.intervalMs, stored.watchIntervalMs, 500, 60000)
          const threshold = typeof body?.threshold === 'number' ? body.threshold : stored.watchThreshold
          const maxMinutes = clampInt(body?.maxMinutes, stored.watchMinutes, 1, 240)
          const plan = await planCapture(stored, { region: body?.region ?? stored.region, fps: 5, drawMouse: stored.drawMouse })
          const dir = path.join(path.resolve(process.cwd(), settings.cacheDir), `watch-${Date.now()}`)
          await mkdir(dir, { recursive: true })
          const started = startWatcher({
            ffmpeg,
            plan,
            dir,
            intervalMs,
            threshold,
            maxMinutes,
            width: stored.width,
            onChange: () => {},
          })
          sendJson(res, 200, started)
          return
        }
        if (route === '/watch/stop' && req.method === 'POST') {
          const body = await readBody(req)
          const running = listWatchers()
          const stopped = body?.id ? stopWatcher(String(body.id)) : (running[0] ? stopWatcher(running[0].id) : undefined)
          sendJson(res, 200, stopped ?? {})
          return
        }
        if (route === '/record/status') {
          sendJson(res, 200, { recordings: await listRecordings() })
          return
        }
        if (route === '/record/start' && req.method === 'POST') {
          const body = await readBody(req)
          const stored = await readSettings()
          const ffmpeg = await findBinary('ffmpeg', settings.ffmpegPath)
          const fps = clampInt(body?.fps, stored.recordFps, 1, 30)
          const seconds = clampInt(body?.seconds, stored.recordSeconds, 10, 7200)
          const maxMB = clampInt(body?.maxMB, stored.recordMaxMB, 100, 20000)
          const plan = await planCapture(stored, { region: body?.region ?? stored.region, fps, drawMouse: stored.drawMouse })
          const dir = path.join(path.resolve(process.cwd(), settings.cacheDir), 'recordings')
          await mkdir(dir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
          const started = startRecording({
            ffmpeg,
            input: plan.input,
            outPath: path.join(dir, `rec-${stamp}.mkv`),
            seconds,
            maxBytes: maxMB * 1024 * 1024,
            label: plan.label,
            fps,
            width: stored.recordWidth,
            crf: 30,
            preset: 'veryfast',
          })
          sendJson(res, 200, started)
          return
        }
        if (route === '/record/stop' && req.method === 'POST') {
          const body = await readBody(req)
          const stopped = body?.id ? await stopRecording(String(body.id)) : (await stopAll())[0]
          sendJson(res, 200, stopped ?? {})
          return
        }
        if (route === '/preview') {
          const stored = await readSettings()
          const ffmpeg = await findBinary('ffmpeg', settings.ffmpegPath)
          const plan = await planCapture(stored, {})
          const dir = path.join(path.resolve(settings.cacheDir ? path.resolve(process.cwd(), settings.cacheDir) : process.cwd()), `preview-${Date.now()}`)
          await mkdir(dir, { recursive: true })
          const target = path.join(dir, 'preview.jpg')
          await captureStill(ffmpeg, plan, target, { width: 960 })
          const data = await readFile(target)
          res.statusCode = 200
          res.setHeader('content-type', 'image/jpeg')
          res.setHeader('cache-control', 'no-store')
          res.end(data)
          return
        }
        sendJson(res, 404, { error: `unknown route ${route}` })
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? String(error) })
      }
    }

    webCtx.webServer.register({ kind: 'prefix', path: '/video-reader', handler })
  })

  // Surface a broken toolchain once at activation instead of on the first read.
  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      const report = await describeToolchain(settings)
      if (cancelled) return
      if (!report.ffmpeg.ok || !report.ffprobe.ok) {
        const message = 'video-reader: ffmpeg toolchain unavailable — set ffmpegPath/ffprobePath in the plugin Config. '
          + `ffmpeg: ${report.ffmpeg.ok ? report.ffmpeg.version : report.ffmpeg.reason} · `
          + `ffprobe: ${report.ffprobe.ok ? report.ffprobe.version : report.ffprobe.reason}`
        const warn = ctx.logger?.warn
        if (warn) warn.call(ctx.logger, message)
        else console.warn(message)
      }
    })()
    return () => { cancelled = true }
  })
}
