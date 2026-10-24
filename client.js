/**
 * Settings page for the Video Reader plugin: the screen-capture controls.
 *
 * The page talks to the Host half over the plugin's own same-origin prefix
 * route (`/video-reader/settings`, `/video-reader/preview`), so nothing here
 * depends on a private RPC surface.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-reader',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const API = '/video-reader'

    const TEXT = {
      zh: {
        nav: '视频阅读器',
        title: '屏幕捕获',
        intro: '让智能体“看一眼”当前桌面。抓取只在本机进行：帧写入会话缓存目录，不会上传。',
        enabled: '允许智能体读取屏幕',
        enabledHint: '关闭后 screen_capture 工具会直接拒绝执行。',
        region: '抓取范围',
        regionFull: '整个桌面',
        regionWindow: '指定窗口',
        regionRect: '自定义区域',
        windowTitle: '窗口标题片段（子串匹配，标题会随页面变化）',
        windowTitleHint: '填稳定的片段，例如 Microsoft Edge、哔哩哔哩、记事本。整段标题会随页面内容变，容易匹配不到。',
        rect: '区域（左、上、宽、高，单位像素）',
        fps: '帧率（帧/秒）',
        seconds: '默认时长（秒，0 表示单张截图）',
        width: '每帧宽度（像素）',
        mouse: '抓取时包含鼠标指针',
        save: '保存',
        preview: '抓一帧预览',
        capturing: '抓取中…',
        saved: '已保存',
        previewHint: '预览就是此刻的屏幕内容，确认范围是否正确。',
        privacy: '注意：抓取会包含屏幕上的一切可见内容（包括聊天窗口、验证码等）。建议只抓需要的窗口或区域。',
        failed: '操作失败',
        loading: '正在读取设置…',
        retry: '重试',
        refresh: '刷新窗口列表',
        noWindows: '（选择一个窗口）',
        recordTitle: '长时录制',
        recordHint: '录制成视频文件而不是一堆截图：1 小时 × 30fps = 108,000 帧，只有视频形态才合理。录制在后台进行，随时可以停止，然后用「视频读取」按需抽帧。',
        recordFps: '录制帧率',
        recordSeconds: '最长时长（秒）',
        recordMaxMB: '文件上限（MB）',
        recordWidth: '录制宽度（0 = 原始）',
        recordStart: '开始录制',
        recordStop: '停止录制',
        recordIdle: '当前没有录制。',
        readTitle: '全帧读取',
        readHint: '每次调用最多附多少帧作为图片；其余用 screen_frames_read 分页读完，插件不会抽样。',
        readBatch: '每批帧数',
        watchTitle: '实时监控',
        watchHint: '按间隔采样小图，画面变化超过阈值就抓全尺寸帧并尝试唤醒模型；唤醒失败时事件留在队列，可用状态查询抽取。',
        watchInterval: '采样间隔（毫秒）',
        watchThreshold: '变化阈值',
        watchMinutes: '最长分钟',
        watchStart: '开始监控',
        watchStop: '停止监控',
        watchIdle: '当前没有监控。',
      },
      en: {
        nav: 'Video Reader',
        title: 'Screen capture',
        intro: 'Lets the agent take a look at the current desktop. Capture stays local: frames land in the session cache directory and are never uploaded.',
        enabled: 'Allow the agent to read the screen',
        enabledHint: 'When off, the screen_capture tool refuses to run.',
        region: 'Capture area',
        regionFull: 'Whole desktop',
        regionWindow: 'One window',
        regionRect: 'Custom rectangle',
        windowTitle: 'Window title fragment (substring, the title changes with the page)',
        windowTitleHint: 'Use a stable fragment such as Microsoft Edge, Notepad, or the app name. A full title changes with page content and is easy to miss.',
        rect: 'Rectangle (left, top, width, height in pixels)',
        fps: 'Frame rate (fps)',
        seconds: 'Default length (seconds, 0 = single still)',
        width: 'Width per frame (px)',
        mouse: 'Include the mouse pointer',
        save: 'Save',
        preview: 'Capture a preview',
        capturing: 'Capturing…',
        saved: 'Saved',
        previewHint: 'The preview is what is on screen right now — use it to confirm the area.',
        privacy: 'Note: a capture includes everything visible on screen (chat windows, codes, and so on). Prefer capturing a single window or rectangle.',
        failed: 'Failed',
        loading: 'Loading settings…',
        retry: 'Retry',
        refresh: 'Refresh windows',
        noWindows: '(pick a window)',
        recordTitle: 'Long recording',
        recordHint: 'Records a video file instead of piles of stills: one hour at 30 fps is 108,000 frames, which only makes sense as a video. Recording runs in the background; stop it later and sample it with video_read.',
        recordFps: 'Record fps',
        recordSeconds: 'Max seconds',
        recordMaxMB: 'Size cap (MB)',
        recordWidth: 'Record width (0 = native)',
        recordStart: 'Start recording',
        recordStop: 'Stop recording',
        recordIdle: 'Nothing is recording.',
        readTitle: 'Full-frame reading',
        readHint: 'How many frames one call attaches as images; the rest are read with screen_frames_read. The plugin never samples down.',
        readBatch: 'Frames per batch',
        watchTitle: 'Live watching',
        watchHint: 'Samples a tiny frame on an interval; when the picture changes past the threshold it saves a full-size frame and tries to wake the model. Failed wakes stay queued for a status poll.',
        watchInterval: 'Interval (ms)',
        watchThreshold: 'Change threshold',
        watchMinutes: 'Max minutes',
        watchStart: 'Start watching',
        watchStop: 'Stop watching',
        watchIdle: 'Nothing is being watched.',
      },
    }

    function isChinese(ctx) {
      try {
        const active = ctx?.locale?.getLocale?.()?.active
        if (active) return String(active).toLowerCase().startsWith('zh')
      } catch { /* fall through to the browser hint */ }
      return browserPrefersChinese()
    }

    function browserPrefersChinese() {
      const tag = (typeof navigator !== 'undefined' && navigator.language) || 'en'
      return String(tag).toLowerCase().startsWith('zh')
    }

    const S = {
      page: {
        padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px',
        maxWidth: '760px', color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--dsw-font-family)', fontSize: '13px',
      },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      intro: { margin: 0, fontSize: '12.5px', lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px 16px',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      group: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' },
      label: { fontSize: '12.5px', color: 'var(--dsw-alias-label-primary)', minWidth: '150px' },
      hint: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, margin: 0 },
      input: {
        background: 'var(--dsw-alias-bg-base)', color: 'inherit', fontSize: '12.5px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '7px',
        padding: '5px 8px', width: '96px', outline: 'none',
      },
      wideInput: {
        background: 'var(--dsw-alias-bg-base)', color: 'inherit', fontSize: '12.5px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '7px',
        padding: '5px 8px', flex: '1 1 260px', minWidth: '200px', outline: 'none',
      },
      button: {
        fontSize: '12.5px', padding: '6px 14px', borderRadius: '7px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      primary: {
        fontSize: '12.5px', padding: '6px 14px', borderRadius: '7px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-brand-primary)', color: '#fff',
        background: 'var(--dsw-alias-brand-primary)',
      },
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      preview: {
        display: 'block', maxWidth: '100%', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
    }

    function fieldLabel(text) {
      return h('span', { style: S.label }, text)
    }

    function numberInput(value, onChange, min, max, step) {
      return h('input', {
        type: 'number', style: S.input, value,
        min, max, step: step ?? 1,
        onChange: (event) => onChange(Number(event.target.value)),
      })
    }

    /** Same defaults as the Host half: the page renders controls even if the route is unreachable. */
    const DEFAULT_SETTINGS = {
      enabled: true,
      region: 'full',
      windowTitle: '',
      rect: { x: 0, y: 0, width: 1280, height: 720 },
      fps: 2,
      seconds: 3,
      width: 1280,
      drawMouse: false,
      maxFrames: 12,
      recordFps: 30,
      recordSeconds: 3600,
      recordMaxMB: 2000,
      recordWidth: 1280,
      readBatch: 20,
      watchIntervalMs: 2000,
      watchThreshold: 0.02,
      watchMinutes: 30,
    }

    /** A render failure must show up as text, not as an empty settings page. */
    function withBoundary(Component, label) {
      return class Boundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) {
          return { error }
        }

        componentDidCatch(error) {
          try { console.error('[video-reader] settings page failed', error) } catch { /* ignore */ }
        }

        render() {
          if (this.state.error) {
            const detail = String(this.state.error?.stack ?? this.state.error?.message ?? this.state.error)
            return h('div', { style: { padding: '24px', fontSize: '12.5px', color: 'var(--dsw-alias-state-error-primary)' } },
              h('p', { style: { margin: '0 0 8px' } }, `${label}: ${String(this.state.error?.message ?? this.state.error)}`),
              h('pre', {
                style: {
                  margin: 0, padding: '10px', borderRadius: '8px', whiteSpace: 'pre-wrap',
                  fontSize: '11px', lineHeight: 1.5, maxHeight: '320px', overflow: 'auto',
                  background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
                  color: 'var(--dsw-alias-label-secondary)',
                },
              }, detail.split('\n').slice(0, 12).join('\n')),
            )
          }
          return h(Component, this.props)
        }
      }
    }

    function makePage(ctx) {
      return function ScreenCaptureSettings() {
        const [draft, setDraft] = useState(DEFAULT_SETTINGS)
        const [loading, setLoading] = useState(true)
        const [status, setStatus] = useState('')
        const [error, setError] = useState('')
        const [busy, setBusy] = useState(false)
        const [preview, setPreview] = useState('')
        const [windows, setWindows] = useState([])
        const [recordings, setRecordings] = useState([])
        const [recordBusy, setRecordBusy] = useState(false)
        const [watchers, setWatchers] = useState([])
        const [watchBusy, setWatchBusy] = useState(false)
        const previewUrl = useRef('')

        // Language is resolved from the browser first: touching the Cordis
        // context during render is what produced the "listeners" crash.
        const [zh, setZh] = useState(() => browserPrefersChinese())
        useEffect(() => {
          const read = () => {
            try {
              const active = ctx?.locale?.getLocale?.()?.active
              if (active) setZh(String(active).toLowerCase().startsWith('zh'))
            } catch { /* keep the browser guess */ }
          }
          read()
          let off
          try {
            const subscribe = ctx?.locale?.subscribe
            if (subscribe) off = subscribe(read)
          } catch { /* locale service unavailable */ }
          return () => { if (off) { try { off() } catch { /* disposed */ } } }
        }, [])

        const t = (key) => (zh ? TEXT.zh[key] : TEXT.en[key]) ?? key

        const load = () => {
          setLoading(true)
          fetch(`${API}/settings`, { headers: { accept: 'application/json' } })
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return response.json()
            })
            .then((value) => { setDraft((current) => ({ ...current, ...value })); setError('') })
            .catch((failure) => setError(`${t('failed')}: ${failure?.message ?? failure}`))
            .finally(() => setLoading(false))
        }

        useEffect(() => { load() }, [])

        useEffect(() => () => {
          if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
        }, [])

        const patch = (values) => {
          setDraft((current) => ({ ...current, ...values }))
          setStatus('')
        }

        const save = async () => {
          if (!draft) return
          setBusy(true)
          setError('')
          try {
            const response = await fetch(`${API}/settings`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(draft),
            })
            const body = await response.json()
            if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
            setDraft(body)
            setStatus(t('saved'))
          } catch (failure) {
            setError(`${t('failed')}: ${failure?.message ?? failure}`)
          } finally {
            setBusy(false)
          }
        }

        const capture = async () => {
          setBusy(true)
          setError('')
          setStatus(t('capturing'))
          try {
            const response = await fetch(`${API}/preview?t=${Date.now()}`, { cache: 'no-store' })
            if (!response.ok) {
              const body = await response.json().catch(() => ({}))
              throw new Error(body?.error ?? `HTTP ${response.status}`)
            }
            const blob = await response.blob()
            if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
            previewUrl.current = URL.createObjectURL(blob)
            setPreview(previewUrl.current)
            setStatus('')
          } catch (failure) {
            setError(`${t('failed')}: ${failure?.message ?? failure}`)
          } finally {
            setBusy(false)
          }
        }

        const refreshWatchers = () => {
          fetch(`${API}/watch/status`).then((response) => response.json())
            .then((value) => setWatchers(Array.isArray(value?.watchers) ? value.watchers : []))
            .catch(() => {})
        }

        const startWatch = async () => {
          setWatchBusy(true)
          setError('')
          try {
            const response = await fetch(`${API}/watch/start`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                intervalMs: draft.watchIntervalMs,
                threshold: draft.watchThreshold,
                maxMinutes: draft.watchMinutes,
              }),
            })
            const body = await response.json()
            if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
            refreshWatchers()
          } catch (failure) {
            setError(`${t('failed')}: ${failure?.message ?? failure}`)
          } finally {
            setWatchBusy(false)
          }
        }

        const stopWatch = async (id) => {
          setWatchBusy(true)
          setError('')
          try {
            const response = await fetch(`${API}/watch/stop`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(id ? { id } : {}),
            })
            const body = await response.json()
            if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
            refreshWatchers()
          } catch (failure) {
            setError(`${t('failed')}: ${failure?.message ?? failure}`)
          } finally {
            setWatchBusy(false)
          }
        }

        const refreshWindows = () => {
          fetch(`${API}/windows`).then((response) => response.json())
            .then((value) => setWindows(Array.isArray(value?.windows) ? value.windows : []))
            .catch(() => setWindows([]))
        }

        const refreshRecordings = () => {
          fetch(`${API}/record/status`).then((response) => response.json())
            .then((value) => setRecordings(Array.isArray(value?.recordings) ? value.recordings : []))
            .catch(() => {})
        }

        const startRecord = async () => {
          setRecordBusy(true)
          setError('')
          try {
            const response = await fetch(`${API}/record/start`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ fps: draft.recordFps, seconds: draft.recordSeconds, maxMB: draft.recordMaxMB }),
            })
            const body = await response.json()
            if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
            refreshRecordings()
          } catch (failure) {
            setError(`${t('failed')}: ${failure?.message ?? failure}`)
          } finally {
            setRecordBusy(false)
          }
        }

        const stopRecord = async (id) => {
          setRecordBusy(true)
          setError('')
          try {
            const response = await fetch(`${API}/record/stop`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(id ? { id } : {}),
            })
            const body = await response.json()
            if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
            refreshRecordings()
          } catch (failure) {
            setError(`${t('failed')}: ${failure?.message ?? failure}`)
          } finally {
            setRecordBusy(false)
          }
        }

        useEffect(() => { refreshWindows(); refreshRecordings(); refreshWatchers() }, [])
        useEffect(() => {
          if (recordings.length === 0 && watchers.length === 0) return undefined
          const timer = setInterval(() => { refreshRecordings(); refreshWatchers() }, 3000)
          return () => clearInterval(timer)
        }, [recordings.length, watchers.length])

        const rect = draft.rect ?? DEFAULT_SETTINGS.rect
        const setRect = (values) => patch({ rect: { ...rect, ...values } })

        return h('div', { style: S.page },
          h('h2', { style: S.title }, t('title')),
          h('p', { style: S.intro }, t('intro')),
          loading ? h('p', { style: S.hint }, t('loading')) : null,
          error
            ? h('div', { style: { ...S.card, borderColor: 'var(--dsw-alias-state-error-primary)' } },
              h('p', { style: S.error }, error),
              h('button', { style: S.button, onClick: load }, t('retry')),
            )
            : null,

          h('div', { style: S.card },
            h('div', { style: S.row },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox', checked: draft.enabled !== false,
                  onChange: (event) => patch({ enabled: event.target.checked }),
                }),
                h('span', { style: { fontSize: '13px', fontWeight: 500 } }, t('enabled')),
              ),
            ),
            h('p', { style: S.hint }, t('enabledHint')),
          ),

          h('div', { style: S.card },
            h('div', { style: S.row }, fieldLabel(t('region'))),
            h('div', { style: S.group },
              ...[['full', t('regionFull')], ['window', t('regionWindow')], ['rect', t('regionRect')]].map(([value, text]) =>
                h('label', { key: value, style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                  h('input', {
                    type: 'radio', name: 'vr-region', value, checked: draft.region === value,
                    onChange: () => patch({ region: value }),
                  }),
                  h('span', null, text),
                ),
              ),
            ),
            draft.region === 'window'
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { style: S.row },
                  h('select', {
                    style: { ...S.wideInput, minWidth: '340px' },
                    value: `${draft.windowTitle ?? ''}\u0001${draft.windowProcess ?? ''}`,
                    onChange: (event) => {
                      const [title, process] = String(event.target.value).split('\u0001')
                      patch({ windowTitle: title ?? '', windowProcess: process ?? '' })
                    },
                  },
                    h('option', { value: '\u0001' }, t('noWindows')),
                    ...(draft.windowTitle && !windows.some((entry) => entry.title === draft.windowTitle)
                      ? [h('option', { key: '__current', value: `${draft.windowTitle}\u0001${draft.windowProcess ?? ''}` },
                        `(当前) ${draft.windowTitle}`)]
                      : []),
                    ...windows.map((entry) => h('option', {
                      key: `${entry.pid}-${entry.title}`,
                      value: `${entry.title}\u0001${entry.process ?? ''}`,
                    }, `${entry.process || '?'} — ${String(entry.title).slice(0, 48)} (${entry.width}×${entry.height})`)),
                  ),
                  h('button', { type: 'button', style: S.button, onClick: refreshWindows }, t('refresh')),
                ),
                h('p', { style: S.hint }, t('windowTitleHint')),
              )
              : null,
            draft.region === 'rect'
              ? h('div', { style: S.row },
                fieldLabel(t('rect')),
                numberInput(rect.x, (value) => setRect({ x: value }), 0, 20000),
                numberInput(rect.y, (value) => setRect({ y: value }), 0, 20000),
                numberInput(rect.width, (value) => setRect({ width: value }), 16, 20000),
                numberInput(rect.height, (value) => setRect({ height: value }), 16, 20000),
              )
              : null,

            h('div', { style: S.row },
              fieldLabel(t('fps')),
              numberInput(draft.fps, (value) => patch({ fps: value }), 1, 30),
            ),
            h('div', { style: S.row },
              fieldLabel(t('seconds')),
              numberInput(draft.seconds, (value) => patch({ seconds: value }), 0, 30),
            ),
            h('div', { style: S.row },
              fieldLabel(t('width')),
              numberInput(draft.width, (value) => patch({ width: value }), 320, 3840, 10),
            ),
            h('div', { style: S.row },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox', checked: draft.drawMouse === true,
                  onChange: (event) => patch({ drawMouse: event.target.checked }),
                }),
                h('span', null, t('mouse')),
              ),
            ),
          ),

          h('div', { style: S.card },
            h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600 } }, t('recordTitle')),
            h('p', { style: S.hint }, t('recordHint')),
            h('div', { style: S.row },
              fieldLabel(t('recordFps')),
              numberInput(draft.recordFps, (value) => patch({ recordFps: value }), 1, 30),
              fieldLabel(t('recordSeconds')),
              numberInput(draft.recordSeconds, (value) => patch({ recordSeconds: value }), 10, 7200, 60),
              fieldLabel(t('recordMaxMB')),
              numberInput(draft.recordMaxMB, (value) => patch({ recordMaxMB: value }), 100, 20000, 100),
              fieldLabel(t('recordWidth')),
              numberInput(draft.recordWidth, (value) => patch({ recordWidth: value }), 0, 3840, 80),
            ),
            h('div', { style: S.row },
              h('button', { style: S.primary, onClick: startRecord, disabled: recordBusy || recordings.length > 0 }, t('recordStart')),
              h('button', { style: S.button, onClick: () => stopRecord(recordings[0]?.id), disabled: recordBusy || recordings.length === 0 }, t('recordStop')),
            ),
            recordings.length === 0
              ? h('p', { style: S.hint }, t('recordIdle'))
              : recordings.map((row) => h('p', { key: row.id, style: S.hint },
                `${row.label} · ${row.elapsedSeconds}s · ${(row.bytes / 1048576).toFixed(1)}MB · ${row.fps}fps · ${row.path}`)),
          ),

          h('div', { style: S.card },
            h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600 } }, t('readTitle')),
            h('p', { style: S.hint }, t('readHint')),
            h('div', { style: S.row },
              fieldLabel(t('readBatch')),
              numberInput(draft.readBatch, (value) => patch({ readBatch: value }), 1, 40),
            ),
          ),

          h('div', { style: S.card },
            h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600 } }, t('watchTitle')),
            h('p', { style: S.hint }, t('watchHint')),
            h('div', { style: S.row },
              fieldLabel(t('watchInterval')),
              numberInput(draft.watchIntervalMs, (value) => patch({ watchIntervalMs: value }), 500, 60000, 100),
              fieldLabel(t('watchThreshold')),
              numberInput(draft.watchThreshold, (value) => patch({ watchThreshold: value }), 0.002, 0.5, 0.005),
              fieldLabel(t('watchMinutes')),
              numberInput(draft.watchMinutes, (value) => patch({ watchMinutes: value }), 1, 240),
            ),
            h('div', { style: S.row },
              h('button', { style: S.primary, onClick: startWatch, disabled: watchBusy || watchers.length > 0 }, t('watchStart')),
              h('button', { style: S.button, onClick: () => stopWatch(watchers[0]?.id), disabled: watchBusy || watchers.length === 0 }, t('watchStop')),
            ),
            watchers.length === 0
              ? h('p', { style: S.hint }, t('watchIdle'))
              : watchers.map((row) => h('p', { key: row.id, style: S.hint },
                `${row.label} · ${row.elapsedSeconds}s · every ${row.intervalMs}ms · ${row.changes} changes`)),
          ),

          h('div', { style: S.row },
            h('button', { style: S.primary, onClick: save, disabled: busy }, t('save')),
            h('button', { style: S.button, onClick: capture, disabled: busy }, t('preview')),
            status ? h('span', { style: S.status }, status) : null,
            error ? h('span', { style: S.error }, error) : null,
          ),

          preview
            ? h('div', { style: S.card },
              h('p', { style: S.hint }, t('previewHint')),
              h('img', { src: preview, style: S.preview, alt: 'screen preview' }),
            )
            : null,

          h('p', { style: S.hint }, t('privacy')),
        )
      }
    }

    return {
      // The loader attributes slot registrations to this name; without it the
      // entry was created under the owner's identity and stayed inactive.
      name: 'dsh-video-reader',
      inject: ['slots', 'locale'],
      apply(ctx) {
        const Page = makePage(ctx)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'video-reader',
          order: 70,
          label: () => (browserPrefersChinese() ? TEXT.zh.nav : TEXT.en.nav),
        }, withBoundary(Page, isChinese(ctx) ? '视频阅读器设置页' : 'Video Reader settings')))
      },
    }
  },
})
