/**
 * Measure recording bitrate at different settings, so the defaults are chosen
 * from data instead of guesses.
 * usage: node test/record-bitrate.mjs
 */
import { mkdir, stat, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startRecording, stopRecording } from '../lib/record.js'
import { captureInput } from '../lib/capture.js'
import { findBinary } from '../lib/ffmpeg.js'

const run = promisify(execFile)
const ffmpeg = await findBinary('ffmpeg')
const ffprobe = await findBinary('ffprobe')
const outDir = 'D:/工作/_tools/rec-rate'
await mkdir(outDir, { recursive: true })

const cases = [
  { name: 'native 30fps crf26', width: 0, crf: 26, preset: 'ultrafast', fps: 30 },
  { name: 'native 30fps crf30 veryfast', width: 0, crf: 30, preset: 'veryfast', fps: 30 },
  { name: '1280 30fps crf30 veryfast', width: 1280, crf: 30, preset: 'veryfast', fps: 30 },
]

for (const testCase of cases) {
  const plan = captureInput({ region: 'full', fps: testCase.fps }, { region: 'full', fps: testCase.fps })
  const outPath = `${outDir}/rate-${Date.now()}.mkv`
  const started = startRecording({
    ffmpeg,
    input: plan.input,
    outPath,
    seconds: 10,
    maxBytes: 0,
    label: testCase.name,
    fps: testCase.fps,
    width: testCase.width,
    crf: testCase.crf,
    preset: testCase.preset,
  })
  await new Promise((resolve) => setTimeout(resolve, 10_600))
  const stopped = await stopRecording(started.id)
  const info = await stat(outPath).catch(() => undefined)
  const mb = (info?.size ?? 0) / 1024 / 1024
  const probe = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath]).catch(() => ({ stdout: '0' }))
  const duration = Number(probe.stdout.trim()) || 10
  console.log(`${testCase.name}: ${mb.toFixed(1)} MB / ${duration.toFixed(1)}s → ${(mb * 3600 / duration).toFixed(0)} MB/hour · code=${stopped.code}`)
  await rm(outPath, { force: true }).catch(() => {})
}
