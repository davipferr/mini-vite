/**
 * Server half of Hot Module Replacement:
 *
 *   fs.watch says a file changed
 *     -> find its module(s) in the graph, invalidate cached transforms
 *     -> walk up the importers until every path hits an "HMR boundary"
 *        (a module that accepts the update)
 *     -> push `{ type: 'update', updates: [...] }` over the WebSocket
 *     -> if some path reaches the top of the graph without a boundary, send `full-reload`
 *
 * Vite equivalent: packages/vite/src/node/server/hmr.ts (updateModules, propagateUpdate)
 *                  packages/vite/src/node/server/ws.ts
 */
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { ServerContext } from './context.js'
import type { ModuleNode } from './moduleGraph.js'
import { c, log, normalizePath } from './utils.js'

/** Messages sent to the browser. Mirrored in src/client/client.ts. */
export interface Update {
  type: 'js-update'
  /** The boundary: the module whose accept callback will run. */
  path: string
  /** The module to re-import (the boundary itself, or one of its direct deps). */
  acceptedPath: string
  timestamp: number
}

export type HmrPayload =
  | { type: 'connected' }
  | { type: 'update'; updates: Update[] }
  | { type: 'full-reload'; path?: string }
  | { type: 'error'; err: { message: string; stack?: string; id?: string } }

export interface HmrChannel {
  send(payload: HmrPayload): void
  close(): void
}

/** Subprotocol name, so our socket doesn't collide with other upgrade requests on the same server. */
const HMR_PROTOCOL = 'mini-vite-hmr'

/** The WebSocket shares the HTTP server's port: we answer HTTP "Upgrade" requests ourselves. */
export function createHmrChannel(server: http.Server): HmrChannel {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    if (req.headers['sec-websocket-protocol'] !== HMR_PROTOCOL) return
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected' } satisfies HmrPayload))
  })

  return {
    send(payload) {
      const data = JSON.stringify(payload)
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(data)
      }
    },
    close() {
      for (const client of wss.clients) client.terminate()
      wss.close()
    },
  }
}

/**
 * Watch the project for changes. fs.watch is noisy: one save often fires several events
 * (editors write, truncate, rename...), so each file gets a short debounce.
 */
export function watchFiles(root: string, onChange: (file: string) => void): fs.FSWatcher {
  const timers = new Map<string, NodeJS.Timeout>()
  return fs.watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const rel = filename.toString()
    if (/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(rel)) return
    const file = path.join(root, rel)
    clearTimeout(timers.get(file))
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file)
        onChange(file)
      }, 30),
    )
  })
}

export function handleFileChange(file: string, ctx: ServerContext): void {
  const shortName = normalizePath(path.relative(ctx.root, file))

  // HTML isn't a module. Nothing can "accept" it.
  if (file.endsWith('.html')) {
    log(`${c.green('page reload')} ${c.dim(shortName)}`)
    ctx.hmr.send({ type: 'full-reload', path: '/' + shortName })
    return
  }

  const mods = ctx.graph.getModulesByFile(file)
  // Not in the graph means the browser never loaded it, so there's nothing to update.
  if (!mods?.size) return

  const timestamp = Date.now()
  const seen = new Set<ModuleNode>()
  for (const mod of mods) ctx.graph.invalidateModule(mod, timestamp, seen)

  const updates: Update[] = []
  for (const mod of mods) {
    const boundaries: Boundary[] = []
    const hasDeadEnd = propagateUpdate(mod, boundaries)
    if (hasDeadEnd) {
      log(`${c.green('page reload')} ${c.dim(shortName)} ${c.dim('(no HMR boundary)')}`)
      ctx.hmr.send({ type: 'full-reload', path: mod.url })
      return
    }
    for (const { boundary, acceptedVia } of boundaries) {
      if (updates.some((u) => u.path === boundary.url && u.acceptedPath === acceptedVia.url)) continue
      updates.push({ type: 'js-update', path: boundary.url, acceptedPath: acceptedVia.url, timestamp })
    }
  }

  for (const u of updates) {
    log(`${c.green('hmr update')} ${u.acceptedPath}${u.path !== u.acceptedPath ? c.dim(` (accepted by ${u.path})`) : ''}`)
  }
  ctx.hmr.send({ type: 'update', updates })
}

interface Boundary {
  /** The module that accepts. */
  boundary: ModuleNode
  /** Which of its deps (or itself) it accepted. */
  acceptedVia: ModuleNode
}

/**
 * Walk up the importer chain from the changed module, collecting HMR boundaries.
 * Returns true on a "dead end": a path that reached a module with no importers
 * (the entry, usually main.js) without anything accepting, which means full reload.
 *
 *            main.js   <- accept('./message.js')  => boundary {main, via message}
 *              |
 *          message.js  <- doesn't accept, keep going up
 *              |
 *          format.js   <- changed
 */
function propagateUpdate(mod: ModuleNode, boundaries: Boundary[], chain: ModuleNode[] = [mod]): boolean {
  if (mod.isSelfAccepting) {
    boundaries.push({ boundary: mod, acceptedVia: mod })
    return false
  }

  if (mod.importers.size === 0) return true

  for (const importer of mod.importers) {
    if (importer.acceptedHmrDeps.has(mod)) {
      boundaries.push({ boundary: importer, acceptedVia: mod })
      continue
    }
    if (chain.includes(importer)) return true // circular import: give up and reload
    if (propagateUpdate(importer, boundaries, [...chain, importer])) return true
  }
  return false
}
