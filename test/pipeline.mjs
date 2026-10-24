/**
 * Offline check of the media pipeline: probe → frames → contact sheet → subtitles.
 * Run with the bundled Node: node test/pipeline.mjs <video>
 */
import path from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import { findBinary, describeToolchain } from '../lib/ffmpeg.js'
import * as media from '../lib/video.js'

const target = process.argv[2] ?? path.join(import.meta.dirname, '..', '..', '_tools', 'test', 'clip.mp4')
const outDir = path.join(import.meta.dirname, '..', '..', '_tools', 'test', 'out')
await mkdir(outDir, { recursive: true })

const report = await describeToolchain({})
console.log('toolchain:', JSON.stringify(report))

const ffmpeg = await findBinary('ffmpeg')
const ffprobe = await findBinary('ffprobe')

let clock = Date.now()
const fileInfo = await media.resolveFile(target, process.cwd())
const probed = await media.probe(ffprobe, fileInfo.path)
const info = media.summarizeProbe(probed, fileInfo)
console.log(`probe ${Date.now() - clock}ms:`, JSON.stringify({
  duration: info.durationSeconds,
  video: info.video,
  audio: info.audioTracks,
  subtitles: info.subtitleStreams,
}))

clock = Date.now()
const times = media.evenTimestamps(info.durationSeconds, 8)
const frames = []
for (let index = 0; index < times.length; index += 1) {
  const target = path.join(outDir, `frame_${String(index + 1).padStart(3, '0')}.jpg`)
  await media.extractFrame(ffmpeg, fileInfo.path, times[index], target, { width: 960, label: media.clock(times[index]) })
  frames.push(target)
}
console.log(`frames ${Date.now() - clock}ms:`, times.map((t) => media.clock(t)).join(' '))

clock = Date.now()
const sheetPath = path.join(outDir, 'contact-sheet.jpg')
const grid = await media.buildContactSheet(ffmpeg, frames, sheetPath, { columns: 4, tileWidth: 320 })
console.log(`sheet ${Date.now() - clock}ms:`, JSON.stringify(grid), (await stat(sheetPath)).size, 'bytes →', sheetPath)

clock = Date.now()
const embedded = await media.extractEmbeddedSubtitles(ffmpeg, fileInfo.path, info.subtitleStreams, outDir)
console.log(`subtitles ${Date.now() - clock}ms:`, JSON.stringify(embedded.tracks), '\ntext:', embedded.text.slice(0, 120))

clock = Date.now()
const sidecar = await media.readSidecarSubtitles(fileInfo.path)
console.log(`sidecar ${Date.now() - clock}ms:`, JSON.stringify(sidecar.files))

clock = Date.now()
const wav = path.join(outDir, 'audio.wav')
await media.extractAudioWav(ffmpeg, fileInfo.path, wav)
console.log(`wav ${Date.now() - clock}ms:`, (await stat(wav)).size, 'bytes')
