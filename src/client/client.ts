/**
 * Browser half of HMR. Served at /@vite/client and injected into index.html.
 *
 * It does three things:
 *   1. Opens a WebSocket to the dev server and listens for update messages.
 *   2. Implements `import.meta.hot` (createHotContext). The server prepends a call to it
 *      in every module that uses HMR.
 *   3. On update: runs dispose handlers, re-imports the changed module with `?t=<timestamp>`
 *      (a new URL, so the browser's module cache misses), then hands the fresh module
 *      to the accept callbacks.
 *
 * Vite equivalent: packages/vite/src/client/client.ts and packages/vite/src/shared/hmr.ts
 */

// Mirrored from src/hmr.ts. The client is compiled for the browser and can't import Node code.
interface Update {
  type: 'js-update'
  path: string
  acceptedPath: string
  timestamp: number
}
type HmrPayload =
  | { type: 'connected' }
  | { type: 'update'; updates: Update[] }
  | { type: 'full-reload'; path?: string }
  | { type: 'error'; err: { message: string; stack?: string; id?: string } }

type ModuleNamespace = Record<string, unknown>
type HotData = Record<string, unknown>

interface HotCallback {
  deps: string[]
  fn: (modules: Array<ModuleNamespace | undefined>) => void
}

const PREFIX = '[mini-vite]'

// ---------------------------------------------------------------------------
// 1. WebSocket connection
// ---------------------------------------------------------------------------

const socketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
const socket = new WebSocket(socketUrl, 'mini-vite-hmr')

socket.addEventListener('message', ({ data }) => handleMessage(JSON.parse(data) as HmrPayload))

socket.addEventListener('close', async ({ wasClean }) => {
  if (wasClean) return
  console.log(`${PREFIX} server connection lost. Polling for restart...`)
  // Ping until the server is back, then reload to get a fresh module graph.
  while (true) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      await fetch(location.origin, { method: 'HEAD' })
      location.reload()
      return
    } catch {}
  }
})

async function handleMessage(payload: HmrPayload): Promise<void> {
  switch (payload.type) {
    case 'connected':
      console.debug(`${PREFIX} connected.`)
      break

    case 'update': {
      // If the page broke on load (overlay showing), some modules never ran, so their
      // accept callbacks never registered. A clean reload is the only safe recovery.
      if (hasErrorOverlay()) {
        location.reload()
        return
      }
      // Fetch all new modules in parallel, then apply in order.
      const apply = await Promise.all(payload.updates.map(fetchUpdate))
      apply.forEach((fn) => fn?.())
      break
    }

    case 'full-reload':
      console.log(`${PREFIX} page reload ${payload.path ?? ''}`)
      location.reload()
      break

    case 'error':
      console.error(`${PREFIX} ${payload.err.message}\n${payload.err.stack ?? ''}`)
      showErrorOverlay(payload.err)
      break
  }
}

// ---------------------------------------------------------------------------
// 2. import.meta.hot
// ---------------------------------------------------------------------------

/** ownerPath -> callbacks registered via accept() by the module living at that URL. */
const hotModulesMap = new Map<string, { id: string; callbacks: HotCallback[] }>()
/** ownerPath -> cleanup the old module instance registered via dispose(). */
const disposeMap = new Map<string, (data: HotData) => void | Promise<void>>()
/** ownerPath -> `import.meta.hot.data`, the object that survives across versions of a module. */
const dataMap = new Map<string, HotData>()

export function createHotContext(ownerPath: string) {
  if (!dataMap.has(ownerPath)) dataMap.set(ownerPath, {})

  // This runs every time the module executes. If it's executing again, it's a new
  // version, and the old version's accept callbacks are stale.
  const existing = hotModulesMap.get(ownerPath)
  if (existing) existing.callbacks = []

  function acceptDeps(deps: string[], fn: HotCallback['fn']): void {
    const mod = hotModulesMap.get(ownerPath) ?? { id: ownerPath, callbacks: [] }
    mod.callbacks.push({ deps, fn })
    hotModulesMap.set(ownerPath, mod)
  }

  return {
    get data(): HotData {
      return dataMap.get(ownerPath)!
    },

    accept(
      deps?: string | string[] | ((mod: ModuleNamespace | undefined) => void),
      callback?: (mod: any) => void,
    ): void {
      if (typeof deps === 'function' || deps === undefined) {
        // accept() / accept(newModule => ...): self-accepting
        acceptDeps([ownerPath], ([mod]) => deps?.(mod))
      } else if (typeof deps === 'string') {
        // accept('./dep.js', newDep => ...). The server already rewrote './dep.js' to '/src/dep.js'.
        acceptDeps([deps], ([mod]) => callback?.(mod))
      } else {
        // accept(['./a.js', './b.js'], ([newA, newB]) => ...)
        acceptDeps(deps, callback ?? (() => {}))
      }
    },

    dispose(cb: (data: HotData) => void): void {
      disposeMap.set(ownerPath, cb)
    },

    /** Give up on hot-updating this module. (Vite propagates to importers; we keep it simple.) */
    invalidate(): void {
      location.reload()
    },
  }
}

// ---------------------------------------------------------------------------
// 3. Applying an update
// ---------------------------------------------------------------------------

async function fetchUpdate({ path, acceptedPath, timestamp }: Update): Promise<(() => void) | undefined> {
  const boundary = hotModulesMap.get(path)
  // The boundary never executed (e.g. it was never imported on this page).
  if (!boundary) return

  // Capture the callbacks *before* re-importing. The new module's createHotContext()
  // clears the list, but it's the old instance's callbacks that should get the new module.
  const callbacks = boundary.callbacks.filter((cb) => cb.deps.includes(acceptedPath))

  const dispose = disposeMap.get(acceptedPath)
  if (dispose) await dispose(dataMap.get(acceptedPath)!)

  // The `?t=` makes this a URL the browser has never seen, so it runs the module again.
  // CSS & co. also need `?import` to be served as JS.
  const isJs = /\.(m?js|jsx|tsx?)$/.test(acceptedPath)
  const url = `${acceptedPath}?${isJs ? '' : 'import&'}t=${timestamp}`

  let newModule: ModuleNamespace
  try {
    newModule = await import(/* @vite-ignore */ url)
  } catch (e) {
    console.error(e)
    console.error(`${PREFIX} failed to reload ${acceptedPath}. This could be due to syntax errors or importing non-existent modules.`)
    return
  }

  return () => {
    for (const { deps, fn } of callbacks) {
      fn(deps.map((dep) => (dep === acceptedPath ? newModule : undefined)))
    }
    console.debug(`${PREFIX} hot updated: ${path === acceptedPath ? path : `${acceptedPath} via ${path}`}`)
  }
}

// ---------------------------------------------------------------------------
// CSS helpers, used by the JS modules the server generates for `import './x.css'`
// ---------------------------------------------------------------------------

const styleSheets = new Map<string, HTMLStyleElement>()

export function updateStyle(id: string, css: string): void {
  let style = styleSheets.get(id)
  if (!style) {
    style = document.createElement('style')
    style.setAttribute('data-mini-vite-id', id)
    document.head.appendChild(style)
    styleSheets.set(id, style)
  }
  style.textContent = css
}

export function removeStyle(id: string): void {
  styleSheets.get(id)?.remove()
  styleSheets.delete(id)
}

// ---------------------------------------------------------------------------
// Error overlay
// ---------------------------------------------------------------------------

const OVERLAY_ID = 'mini-vite-error-overlay'

function hasErrorOverlay(): boolean {
  return !!document.getElementById(OVERLAY_ID)
}

function showErrorOverlay(err: { message: string; stack?: string; id?: string }): void {
  const show = () => {
    document.getElementById(OVERLAY_ID)?.remove()
    const el = document.createElement('div')
    el.id = OVERLAY_ID
    el.style.cssText =
      'position:fixed;inset:0;z-index:99999;padding:32px;overflow:auto;background:rgba(0,0,0,.88);' +
      'color:#ff6b6b;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;cursor:pointer'
    el.textContent =
      `${PREFIX} ${err.id ? `Internal server error: ${err.id}\n\n` : ''}${err.message}\n\n` +
      `${err.stack ?? ''}\n\nFix the code and save to reload. Click to dismiss.`
    el.onclick = () => el.remove()
    document.body.appendChild(el)
  }
  if (document.body) show()
  else document.addEventListener('DOMContentLoaded', show)
}
