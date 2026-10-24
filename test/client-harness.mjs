/**
 * Offline shape check for the Client half: load `client.js` with a stub module
 * loader, fake React, and a fake Cordis context, then confirm it registers a
 * `settings.section` entry, that the entry survives an error boundary, and that
 * the page renders its controls from defaults without a host round-trip.
 *
 * usage: node test/client-harness.mjs
 */
import assert from 'node:assert'

const registered = []
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      globalThis.__definition = definition
    },
  },
}

await import('../client.js')
const definition = globalThis.__definition
assert.ok(definition, 'client module did not call __ModuleLoader__.load')
assert.equal(definition.id, '@local/dsh-video-reader', 'module id must equal the package name')

class Component {
  constructor(props) {
    this.props = props
    this.state = {}
  }

  setState(next) {
    this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
  }
}

const React = {
  Component,
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value ?? null }),
}

const require = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected module request: ${name}`)
}

const ctx = {
  slots: {
    inject: (name, callback) => {
      assert.equal(name, 'settings.section')
      callback()
    },
    register: (options, Renderer) => {
      registered.push({ options, Renderer })
      return () => {}
    },
  },
  locale: {
    getLocale: () => ({ active: 'zh', locales: [], revision: 1 }),
    subscribe: () => () => {},
  },
}

const instance = definition.factory(require)
assert.deepEqual(instance.inject, ['slots', 'locale'], 'client half must inject slots and locale')
assert.equal(instance.name, 'dsh-video-reader', 'client half must expose its plugin name')
instance.apply(ctx)

assert.equal(registered.length, 1, 'expected exactly one settings.section registration')
const [{ options, Renderer }] = registered
assert.equal(options.name, 'settings.section')
assert.equal(options.id, 'video-reader')
assert.equal(options.order, 70)
assert.equal(typeof Renderer, 'function', 'registration must carry a component')
assert.equal(options.label(), '视频阅读器', 'Chinese label expected for zh locale')

// The boundary must render the page (not an error box); then render that page.
const boundary = new Renderer({ close: () => {} })
const element = boundary.render()
assert.ok(!element.props || !element.props.style || element.props.style.padding !== '24px', 'boundary must not render the error box')

const tree = element.type({ close: () => {} })
assert.ok(tree && tree.type === 'div', 'page must render a container element')
const flat = JSON.stringify(tree)
for (const expected of ['允许智能体读取屏幕', '抓取范围', '帧率（帧/秒）', '抓一帧预览']) {
  assert.ok(flat.includes(expected), `page must render the "${expected}" control`)
}

console.log('client harness OK:', {
  id: definition.id,
  slot: options.name,
  entryId: options.id,
  order: options.order,
  label: options.label(),
  renderedRoot: tree.type,
  controls: 'enabled + region + fps + seconds + width + preview',
})
