/**
 * Attribute measured token growth to the steps that caused it.
 * usage: node test/usage.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
let offsets = []
let index = buf.indexOf(magic, 0)
while (index !== -1) {
  offsets.push(index)
  index = buf.indexOf(magic, index + 4)
}
let text = ''
for (let k = 0; k < offsets.length; k += 1) {
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  try {
    text += zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8')
  } catch { /* skip truncated frame */ }
}
const events = text.split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line) } catch { return undefined }
}).filter(Boolean)

let previousInput = 0
let pending = []
const rows = []
for (const event of events) {
  if (event.type === 'tool/call') {
    const name = event.data?.name ?? event.data?.call?.name ?? '?'
    pending.push({ name, kind: 'call' })
  }
  if (event.type === 'tool/result') {
    const data = event.data ?? {}
    const content = data.content ?? data.message?.content ?? []
    const blocks = Array.isArray(content) ? content : []
    const textLength = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('').length
    const images = blocks.filter((block) => block.type === 'image').length
    // The tool name lives on the matching call; remember the last call still open.
    const name = data.name ?? data.call?.name ?? pending.filter((entry) => entry.kind === 'call').at(-1)?.name ?? '?'
    pending.push({ kind: 'result', name, textLength, images })
  }
  if (event.type === 'assistant/message') {
    const usage = event.data?.usage ?? {}
    const input = usage.inputTokens ?? 0
    rows.push({
      seq: event.seq,
      turn: event.data?.turn,
      step: event.data?.step,
      input,
      output: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      total: input + (usage.cacheReadTokens ?? 0),
      assistantChars: textLengthOf(event.data?.message?.content),
      produced: pending,
    })
    previousInput = input
    pending = []
  }
}

console.log('seq   turn.step   promptTotal  growth   produced by this step')

function textLengthOf(blocks) {
  return (blocks ?? []).filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('').length
}

let previousTotal = 0
for (const row of rows) {
  const produced = row.produced
    .filter((entry) => entry.kind === 'result')
    .map((entry) => {
      const bits = [`${entry.name}`, `${entry.textLength}c`]
      if (entry.images > 0) bits.push(`${entry.images}img`)
      return bits.join('/')
    })
    .join(' + ')
  console.log(
    `${String(row.seq).padStart(4)}  ${String(row.turn) + '.' + String(row.step).padEnd(3)}  ${String(row.total).padStart(11)}  ${String(row.total - previousTotal).padStart(6)}   ${produced}`,
  )
  previousTotal = row.total
}
