/**
 * External dependency manager.
 *
 * The plugin itself is only JavaScript; the media work is done by three
 * third-party toolchains plus their models. Those binaries are far beyond
 * GitHub's per-file limit, so they are not committed. This module downloads
 * them on demand into the user-local install directory searched by
 * `lib/ffmpeg.js`, `lib/asr.js` and `lib/diarize.js`:
 *
 *   %LOCALAPPDATA%\dsh-video-reader\bin     ffmpeg, whisper.cpp, sherpa-onnx
 *   %LOCALAPPDATA%\dsh-video-reader\models  whisper + diarization models
 *
 * Everything is pinned by version and checked by sha256: a download that does
 * not match the recorded hash is deleted instead of installed. Archive
 * extraction uses the bundled Windows `tar` (bsdtar handles .zip and .tar.bz2).
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { localRoot, resolveRecognizer } from './asr.js'
import { describeToolchain } from './ffmpeg.js'
import { resolveDiarizer } from './diarize.js'

/** Where the extra build artifacts end up. */
export const INSTALL_BIN = 'bin'
export const INSTALL_MODELS = 'models'

const MIRROR_PREFIX = 'https://gh-proxy.com/'

const MB = 1024 * 1024

/**
 * Pinned components. `files[].sha256` is the hash of the exact file that must
 * end up on disk; `downloads[].sha256` (when present) is the hash of the
 * archive itself, checked before extraction.
 */
export const COMPONENTS = {
  ffmpeg: {
    label: { en: 'ffmpeg + ffprobe', zh: 'ffmpeg + ffprobe' },
    version: '9.0.2 essentials',
    note: { en: 'media probing, stills, audio and screen capture', zh: '媒体解析、抽帧、音频抽取与屏幕捕获' },
    downloads: [
      {
        name: 'ffmpeg-9.0.2-essentials_build.zip',
        url: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip',
        mirrors: [],
        archive: true,
        size: 0,
        files: [
          { name: 'ffmpeg.exe', to: 'bin/ffmpeg.exe', size: 105423872, sha256: '3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec' },
          { name: 'ffprobe.exe', to: 'bin/ffprobe.exe', size: 105221120, sha256: 'f0d36ecbbdd3bcfac3efa078c96c7271c2e68b3810595552ac3b7f17e9a65c52' },
        ],
      },
    ],
  },
  whisper: {
    label: { en: 'whisper.cpp', zh: 'whisper.cpp 语音识别' },
    version: 'b5454',
    note: { en: 'speech recognition (99 languages)', zh: '语音识别（99 种语言）' },
    downloads: [
      {
        name: 'whisper-bin-x64.zip',
        url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
        mirrors: [MIRROR_PREFIX + 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'],
        archive: true,
        size: 8928640,
        sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
        files: [
          { name: 'whisper-cli.exe', to: 'bin/whisper-cli.exe', size: 479744, sha256: '331dba46d6427105d2b802cdbc7eae916ea1c5abf9b0d3b5cfe460d8db8e4366' },
          { name: 'whisper.dll', to: 'bin/whisper.dll', size: 1370112, sha256: '034396d75bb5720c1851674ff64a96192b58f6927b68d334ebd254ce6cad9674' },
          { name: 'ggml.dll', to: 'bin/ggml.dll', size: 62464, sha256: '31fe18616d872af9b6134b47a6dff8072ae4ecbe5df0273f4f8dc36766c9db8e' },
          { name: 'ggml-base.dll', to: 'bin/ggml-base.dll', size: 693248, sha256: 'bede0d6b2d387236ecd2b5dd676d51c8984b5b6e0ae461a12174e9c01345c5f0' },
          { name: 'SDL2.dll', to: 'bin/SDL2.dll', size: 2500096, sha256: 'de23db1694a3c7a4a735e7ecd3d214b2023cc2267922c6c35d30c7fc7370d677' },
          { name: 'ggml-cpu-alderlake.dll', to: 'bin/ggml-cpu-alderlake.dll', size: 1009664, sha256: 'd8f5c56ea490394eeae8b271650f2647aecd039a542d6df9e0140726e62a4603' },
          { name: 'ggml-cpu-cannonlake.dll', to: 'bin/ggml-cpu-cannonlake.dll', size: 1049600, sha256: '74127b40abd4f595d9db6af0fa313a02e18ff42fc228bfa05281e7c788dd4507' },
          { name: 'ggml-cpu-cascadelake.dll', to: 'bin/ggml-cpu-cascadelake.dll', size: 1061376, sha256: '4b11c427b844eeac87529af9a8d94b35aad2024666beb2a35e59fe3077e4b81e' },
          { name: 'ggml-cpu-haswell.dll', to: 'bin/ggml-cpu-haswell.dll', size: 1010688, sha256: '1306b1014c8118d27234d8ddc0e66ced1f8c8476bf85071595fd182ea9b7263b' },
          { name: 'ggml-cpu-icelake.dll', to: 'bin/ggml-cpu-icelake.dll', size: 1061376, sha256: '2b4dc4c66e7d8fe2807283816e9cf3b7f7d0556f59df34069871e37eab8aed40' },
          { name: 'ggml-cpu-sandybridge.dll', to: 'bin/ggml-cpu-sandybridge.dll', size: 1026560, sha256: '04edbdebc01a1d421062a960881a4f34d520d99693999518243f332406444c6e' },
          { name: 'ggml-cpu-skylakex.dll', to: 'bin/ggml-cpu-skylakex.dll', size: 1049600, sha256: '1774714cf93621406ff35344b54715619a83242ae3e331e44d98a3b35ce801be' },
          { name: 'ggml-cpu-sse42.dll', to: 'bin/ggml-cpu-sse42.dll', size: 862720, sha256: 'f060318772c4c2dbac312bbfff6ea700b85dbc502bb38585a7186d06d549301a' },
          { name: 'ggml-cpu-x64.dll', to: 'bin/ggml-cpu-x64.dll', size: 866816, sha256: '4b4b05caba40d4309b5d710ef74c59ba190516b8489f27bdb1ba11ae33c6e9d3' },
        ],
      },
    ],
  },
  sherpa: {
    label: { en: 'sherpa-onnx diarization', zh: 'sherpa-onnx 说话人分离' },
    version: 'v2.0.0',
    note: { en: 'offline speaker diarization runtime', zh: '离线说话人分离运行时' },
    downloads: [
      {
        name: 'sherpa-onnx-v2.0.0-win-x64-shared-MD-MinSizeRel-no-tts.tar.bz2',
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.0/sherpa-onnx-v2.0.0-win-x64-shared-MD-MinSizeRel-no-tts.tar.bz2',
        mirrors: [MIRROR_PREFIX + 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.0/sherpa-onnx-v2.0.0-win-x64-shared-MD-MinSizeRel-no-tts.tar.bz2'],
        archive: true,
        size: 18010583,
        sha256: 'f825f6d073d8ac7bce7f32a9c1c05760c922edf4729b593559f2a33ee6b39b67',
        files: [
          { name: 'sherpa-onnx-offline-speaker-diarization.exe', to: 'bin/sherpa-onnx-offline-speaker-diarization.exe', size: 644608, sha256: '5a0088efd617cf5be2bbe34e019166755ab463135494e84d1f185ae93a609cc3' },
          { name: 'onnxruntime.dll', to: 'bin/onnxruntime.dll', size: 14203904, sha256: '9ab1e925c610b42410b1ebacc61306436282522221bf3b3c6ea5950d000d44be' },
          { name: 'onnxruntime_providers_shared.dll', to: 'bin/onnxruntime_providers_shared.dll', size: 10752, sha256: '3ef52275f70976fd0ac83f6a4e516cad045622851d5d4ce692f0926333cc8062' },
          { name: 'sherpa-onnx-c-api.dll', to: 'bin/sherpa-onnx-c-api.dll', size: 2793984, sha256: 'fcc10f089dfccdf05c26acd92fcb1877e68cd169935857677b661e36b5bf097e' },
          { name: 'sherpa-onnx-cxx-api.dll', to: 'bin/sherpa-onnx-cxx-api.dll', size: 128512, sha256: 'a3343356c5adfd987e2625a7226313add4dbf5891029015e6fb5bd3833d087b1' },
        ],
      },
    ],
  },
  'whisper-model': {
    label: { en: 'speech model (medium, 99 languages)', zh: '语音模型（medium，99 语种）' },
    version: 'ggml-medium-q5_0',
    note: { en: '514 MB; any ggml model dropped into models/ is also picked up', zh: '514 MB；也可以自行放入任意 ggml 模型' },
    downloads: [
      {
        name: 'ggml-medium-q5_0.bin',
        url: 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin',
        mirrors: ['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin'],
        archive: false,
        size: 539212467,
        sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
        files: [
          { name: 'ggml-medium-q5_0.bin', to: 'models/ggml-medium-q5_0.bin', size: 539212467, sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f' },
        ],
      },
    ],
  },
  'diarization-models': {
    label: { en: 'diarization models', zh: '说话人分离模型' },
    version: 'pyannote-3.0 + 3D-Speaker',
    note: { en: 'segmentation + voice embedding, 33 MB', zh: '分段 + 声纹嵌入，33 MB' },
    downloads: [
      {
        name: 'sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
        mirrors: [MIRROR_PREFIX + 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'],
        archive: true,
        size: 6958444,
        sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
        files: [
          { name: 'model.onnx', to: 'models/segmentation.onnx', size: 5992913, sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079' },
        ],
      },
      {
        name: '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
        mirrors: [MIRROR_PREFIX + 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'],
        archive: false,
        size: 28281138,
        sha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11',
        files: [
          { name: '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx', to: 'models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx', size: 28281138, sha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11' },
        ],
      },
    ],
  },
}

/** User-facing component order. */
export const COMPONENT_IDS = ['ffmpeg', 'whisper', 'whisper-model', 'sherpa', 'diarization-models']

const ALIASES = {
  all: COMPONENT_IDS,
  models: ['whisper-model', 'diarization-models'],
  binaries: ['ffmpeg', 'whisper', 'sherpa'],
}

/** Expand the shorthand names accepted by the tool and the settings page. */
export function expandComponents(input) {
  const list = Array.isArray(input) ? input : input ? [input] : ['all']
  const ids = []
  for (const entry of list) {
    const key = String(entry ?? '').trim()
    const expanded = ALIASES[key] ?? [key]
    for (const id of expanded) {
      if (!COMPONENTS[id]) throw new Error(`unknown dependency component "${id}"; choose ${COMPONENT_IDS.join(', ')}, models, binaries or all`)
      if (!ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

export function supported() {
  return process.platform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64')
}

/** Bytes a full install would download. */
export function downloadBytes(ids = COMPONENT_IDS) {
  let total = 0
  for (const id of ids) {
    for (const download of COMPONENTS[id].downloads) {
      if (download.size) total += download.size
      else if (!download.archive) total += download.files.reduce((sum, file) => sum + (file.size ?? 0), 0)
      else total += download.files.reduce((sum, file) => sum + (file.size ?? 0), 0)
    }
  }
  return total
}

function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(file)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

async function fileSize(file) {
  try { return (await stat(file)).size } catch { return -1 }
}

async function pathExists(file) {
  try { await access(file); return true } catch { return false }
}

/** Recursively find a file by base name (case-insensitive) below `dir`. */
async function findFileByName(dir, name) {
  const wanted = name.toLowerCase()
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.toLowerCase() !== wanted) continue
    const parent = entry.parentPath ?? entry.path
    return path.join(parent, entry.name)
  }
  return undefined
}

function runTar(archive, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', destination], { windowsHide: true })
    const errors = []
    child.stderr.on('data', (chunk) => errors.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar exited with ${code}: ${Buffer.concat(errors).toString('utf8').trim()}`))
    })
  })
}

function expandZip(archive, destination) {
  return new Promise((resolve, reject) => {
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
    const script = `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    const errors = []
    child.stderr.on('data', (chunk) => errors.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Expand-Archive exited with ${code}: ${Buffer.concat(errors).toString('utf8').trim()}`))
    })
  })
}

async function extractArchive(archive, destination) {
  await mkdir(destination, { recursive: true })
  try {
    await runTar(archive, destination)
  } catch (error) {
    if (!/\.zip$/i.test(archive)) throw error
    // Windows ships bsdtar since 1803, but keep a fallback for stripped images.
    await expandZip(archive, destination)
  }
}

async function downloadFile(url, destination, { signal, timeoutMs = 1_800_000, onProgress } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`download from ${new URL(url).host} timed out`)), timeoutMs)
  const composite = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: composite,
      headers: { 'user-agent': 'dsh-video-reader/1.8 (+https://github.com/ck99998888/dsh-video-reader)' },
    })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const total = Number(response.headers.get('content-length')) || 0
    await mkdir(path.dirname(destination), { recursive: true })
    const stream = createWriteStream(destination)
    const reader = response.body.getReader()
    let received = 0
    let lastEmit = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (!stream.write(value)) await new Promise((resolve) => stream.once('drain', resolve))
        const now = Date.now()
        if (now - lastEmit > 750) {
          lastEmit = now
          onProgress?.({ received, total })
        }
      }
      await new Promise((resolve, reject) => {
        stream.once('error', reject)
        stream.once('finish', resolve)
        stream.end()
      })
      onProgress?.({ received, total: total || received })
      return { url, bytes: received, total: total || received }
    } catch (error) {
      stream.destroy()
      throw error
    }
  } finally {
    clearTimeout(timer)
  }
}

function candidateUrls(download, preferMirror) {
  const urls = [download.url, ...(download.mirrors ?? [])]
  if (preferMirror) return [...urls].reverse()
  return urls
}

function tmpSuffix() {
  return `${process.pid}-${Date.now().toString(36)}`
}

/** Place one verified file at its final location. */
async function placeFile(source, relativeTo, expected) {
  const finalPath = path.join(localRoot(), ...String(relativeTo).split('/'))
  await mkdir(path.dirname(finalPath), { recursive: true })
  const temp = `${finalPath}.tmp-${tmpSuffix()}`
  await copyFile(source, temp)
  try {
    const size = await fileSize(temp)
    if (expected.size && size !== expected.size) throw new Error(`size mismatch for ${expected.to}: got ${size}, expected ${expected.size}`)
    if (expected.sha256) {
      const digest = await sha256OfFile(temp)
      if (digest !== expected.sha256) throw new Error(`sha256 mismatch for ${expected.to}: got ${digest}`)
    }
    await rm(finalPath, { force: true })
    await rename(temp, finalPath)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return finalPath
}

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  components: [],
  component: null,
  phase: null,
  file: null,
  received: 0,
  total: 0,
  bytes: 0,
  error: null,
  log: [],
}

export function installState() {
  return { ...state, log: state.log.slice(-12) }
}

function setState(patch) {
  Object.assign(state, patch)
}

function logLine(message) {
  state.log.push(`${new Date().toISOString().slice(11, 19)} ${message}`)
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200)
}

async function acquireLock() {
  const lockPath = path.join(localRoot(), '.install.lock')
  await mkdir(localRoot(), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      await handle.close()
      return async () => { await unlink(lockPath).catch(() => {}) }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = await readFile(lockPath, 'utf8').then((text) => JSON.parse(text)).catch(() => ({}))
      if (info.at && Date.now() - info.at < 15 * 60_000) {
        throw new Error('another dependency install is already running (lock: %LOCALAPPDATA%\\dsh-video-reader\\.install.lock)')
      }
      await unlink(lockPath).catch(() => {})
    }
  }
  throw new Error('could not acquire the dependency install lock')
}

/**
 * Install the requested components. Downloads run one at a time, each file is
 * hash-checked, and nothing is moved into place until it verifies.
 */
export async function install({ components = ['all'], mirror = false, signal, onProgress } = {}) {
  if (!supported()) throw new Error(`automatic dependency setup currently supports Windows x64 only (this is ${process.platform}/${process.arch}); install ffmpeg and set ffmpegPath/ffprobePath manually`)
  const ids = expandComponents(components)
  if (state.running) throw new Error('a dependency install is already running')
  const release = await acquireLock()
  const staging = path.join(localRoot(), '.staging', `install-${tmpSuffix()}`)
  const startedAt = Date.now()
  setState({ running: true, startedAt, finishedAt: null, components: ids, component: null, phase: 'prepare', file: null, received: 0, total: 0, bytes: 0, error: null, log: [] })
  let installed = 0
  try {
    await mkdir(staging, { recursive: true })
    for (const id of ids) {
      const component = COMPONENTS[id]
      setState({ component: id, phase: 'download', received: 0, total: 0 })
      logLine(`installing ${id} (${component.version})`)
      onProgress?.({ kind: 'component', component: id, phase: 'start' })
      for (const [index, download] of component.downloads.entries()) {
        let done = false
        let lastError
        for (const url of candidateUrls(download, mirror)) {
          if (signal?.aborted) throw new Error('aborted')
          const target = path.join(staging, `${id}-${index}-${download.name}`)
          setState({ phase: 'download', file: download.name, received: 0, total: download.size || 0 })
          logLine(`download ${download.name} from ${new URL(url).host}`)
          try {
            const result = await downloadFile(url, target, {
              signal,
              onProgress: (progress) => {
                setState({ received: progress.received, total: progress.total || download.size || 0 })
                onProgress?.({ kind: 'download', component: id, file: download.name, ...progress })
              },
            })
            if (download.sha256) {
              setState({ phase: 'verify' })
              const digest = await sha256OfFile(target)
              if (digest !== download.sha256) throw new Error(`archive sha256 mismatch: got ${digest}`)
            }
            if (download.size && result.bytes !== download.size) {
              throw new Error(`download size mismatch: got ${result.bytes}, expected ${download.size}`)
            }
            state.bytes += result.bytes
            done = true
            break
          } catch (error) {
            lastError = error
            if (signal?.aborted) throw error
            logLine(`  failed: ${error?.message ?? error}`)
            await rm(target, { force: true }).catch(() => {})
          }
        }
        if (!done) throw new Error(`could not download ${download.name}: ${lastError?.message ?? 'unknown error'}`)

        setState({ phase: download.archive ? 'extract' : 'install', file: download.name })
        let root = path.join(staging, `${id}-${index}-extract`)
        if (download.archive) {
          await extractArchive(path.join(staging, `${id}-${index}-${download.name}`), root)
        } else {
          root = path.join(staging, `${id}-${index}-${download.name}`)
        }
        for (const file of download.files) {
          const source = download.archive
            ? await findFileByName(root, file.name)
            : root
          if (!source) throw new Error(`${file.name} is missing from ${download.name}`)
          await placeFile(source, file.to, file)
        }
        logLine(`  installed ${download.files.length} file(s) from ${download.name}`)
      }
      installed += 1
      onProgress?.({ kind: 'component', component: id, phase: 'done' })
    }
    setState({ phase: 'done' })
    logLine(`done: ${installed} component(s)`)
    return { installed: ids, bytes: state.bytes, durationMs: Date.now() - startedAt }
  } catch (error) {
    setState({ phase: 'failed', error: error?.message ?? String(error) })
    logLine(`failed: ${error?.message ?? error}`)
    throw error
  } finally {
    setState({ running: false, finishedAt: Date.now() })
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    await release()
  }
}

/** Facts about the toolchain the plugin can currently see (bundled, local or PATH). */
export async function dependencyStatus(config = {}) {
  const [ffmpeg, recognizer, diarizer] = await Promise.all([
    describeToolchain(config).catch((error) => ({ ffmpeg: { ok: false, reason: String(error) }, ffprobe: { ok: false, reason: String(error) } })),
    resolveRecognizer(config).catch(() => ({ ready: false })),
    resolveDiarizer(config).catch(() => ({ ready: false })),
  ])
  const component = (id, ready, extra = {}) => {
    const meta = COMPONENTS[id]
    return {
      id,
      label: meta.label,
      version: meta.version,
      note: meta.note,
      ready: Boolean(ready),
      ...extra,
    }
  }
  const ffmpegReady = Boolean(ffmpeg.ffmpeg?.ok && ffmpeg.ffprobe?.ok)
  const components = [
    component('ffmpeg', ffmpegReady, {
      location: ffmpeg.ffmpeg?.command,
      version: ffmpeg.ffmpeg?.ok ? String(ffmpeg.ffmpeg.version).split(' ').slice(0, 3).join(' ') : 'not found',
      reason: ffmpegReady ? undefined : (ffmpeg.ffmpeg?.reason ?? ffmpeg.ffprobe?.reason),
    }),
    component('whisper', Boolean(recognizer.binary), { location: recognizer.binary }),
    component('whisper-model', Boolean(recognizer.model), { location: recognizer.model }),
    component('sherpa', Boolean(diarizer.binary), { location: diarizer.binary }),
    component('diarization-models', Boolean(diarizer.segmentation && diarizer.embedding), {
      location: diarizer.segmentation && diarizer.embedding ? `${diarizer.segmentation} + ${path.basename(diarizer.embedding)}` : undefined,
    }),
  ]
  return {
    supported: supported(),
    platform: `${process.platform}/${process.arch}`,
    root: localRoot(),
    ready: components.every((entry) => entry.ready),
    downloadBytes: downloadBytes(COMPONENT_IDS),
    installedBytes: COMPONENT_IDS.reduce((sum, id) => sum + COMPONENTS[id].downloads.reduce((inner, download) => inner + (download.size || download.files.reduce((acc, file) => acc + (file.size ?? 0), 0)), 0), 0),
    components,
    install: installState(),
  }
}

/** Install exactly the components that are not usable yet; a no-op when all are ready. */
export async function ensureComponents(ids, options = {}) {
  const requested = expandComponents(ids)
  const status = await dependencyStatus(options.config ?? {})
  const ready = new Map(status.components.map((entry) => [entry.id, entry.ready]))
  const missing = requested.filter((id) => !ready.get(id))
  if (missing.length === 0) return { installed: [], skipped: requested, status }
  const result = await install({ components: missing, mirror: options.mirror, signal: options.signal, onProgress: options.onProgress })
  return { ...result, installed: missing, skipped: requested.filter((id) => !missing.includes(id)), status: await dependencyStatus(options.config ?? {}) }
}
