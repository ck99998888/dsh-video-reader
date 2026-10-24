/**
 * Offline check for the window picker and the recording lifecycle.
 * usage: node test/record-check.mjs
 */
import { mkdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listWindows, resolveWindow } from '../lib/windows.js'
import { startRecording, stopRecording, listRecordings } from '../lib/record.js'
import { captureInput } from '../lib/capture.js'
import { findBinary } from '../lib/ffmpeg.js'

const run = promisify(execFile)
const ffmpeg = await findBinary('ffmpeg')
const ffprobe = await findBinary('ffprobe')

const windows = await listWindows(0)
console.log(`windows: ${windows.length}`)
for (const entry of windows.slice(0, 6)) {
  console.log(`  ${entry.process || '?'} · ${entry.title.slice(0, 50)} · ${entry.width}x${entry.height}`)
}

const match = await resolveWindow({ title: 'DeepSeek Harness' })
console.log('resolve "DeepSeek Harness":', match ? `${match.window.title.slice(0, 30)} ${match.rect.width}x${match.rect.height}` : 'not found')
const byProcess = await resolveWindow({ process: 'msedge' })
console.log('resolve process msedge:', byProcess ? `${byProcess.window.title.slice(0, 30)}` : 'not found')

const outDir = 'D:/工作/_tools/rec-check'
await mkdir(outDir, { recursive: true })
const plan = captureInput({ region: 'full', fps: 10 }, { region: 'full', fps: 10 })
const outPath = `${outDir}/rec-${Date.now()}.mkv`
const started = startRecording({ ffmpeg, input: plan.input, outPath, seconds: 6, maxBytes: 200 * 1024 * 1024, label: 'test desktop', fps: 10 })
console.log('started:', started.id)

await new Promise((resolve) => setTimeout(resolve, 3000))
const mid = await listRecordings()
console.log('mid-status:', mid.map((row) => `${row.elapsedSeconds}s ${(row.bytes / 1024).toFixed(0)}KB running=${row.running}`).join(' | '))

const stopped = await stopRecording(started.id)
console.log('stopped:', JSON.stringify({ seconds: stopped.seconds, bytes: stopped.bytes, code: stopped.code, note: stopped.note }))

const info = await stat(outPath)
console.log(`file: ${(info.size / 1024).toFixed(0)} KB`)
const probe = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=width,height,avg_frame_rate,codec_name', '-of', 'default=nw=1', outPath])
console.log(probe.stdout.trim().split('\n').join(' | '))
