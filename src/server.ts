/**
 * The dev server: a plain node:http server that decides, per request, which job to do.
 *
 *   /@vite/client            -> the HMR client (precompiled, served as-is)
 *   /@modules/react.js       -> a pre-bundled dependency
 *   /  or  *.html            -> index.html with the client <script> injected
 *   *.js/.jsx/.ts or ?import -> run the transform pipeline
 *   anything else            -> static file (images, fonts, <link>ed CSS)
 *
 * Vite equivalent: packages/vite/src/node/server/index.ts and server/middlewares/*
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { init } from 'es-module-lexer'
import type { ServerContext } from './context.js'
import { createHmrChannel, handleFileChange, watchFiles } from './hmr.js'
import { ModuleGraph } from './moduleGraph.js'
import { DepOptimizer } from './optimizer.js'
import { fileToUrl, urlToFile } from './resolve.js'
import { transformIndexHtml, transformRequest } from './transform.js'
import { CLIENT_URL, DEPS_PREFIX, JS_RE, c, etag, isFile, log, mimeType } from './utils.js'

export interface ServerOptions {
  root: string
  port: number
  force: boolean
  debug: boolean
}

const clientFile = fileURLToPath(new URL('./client/client.js', import.meta.url))

export async function createServer(options: ServerOptions): Promise<http.Server> {
  const start = performance.now()
  const root = path.resolve(options.root)
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`No index.html found in ${root}`)
  }
  await init // es-module-lexer is WebAssembly and has to be compiled once before use

  const httpServer = http.createServer()
  const ctx: ServerContext = {
    root,
    graph: new ModuleGraph(),
    hmr: createHmrChannel(httpServer),
    optimizer: null!,
    debug: options.debug,
  }
  ctx.optimizer = new DepOptimizer(root, () => ctx.hmr.send({ type: 'full-reload' }))
  await ctx.optimizer.init(options.force)

  httpServer.on('request', (req, res) => {
    handleRequest(req, res, ctx).catch((err: Error) => {
      log(c.red(`error while serving ${req.url}\n${err.stack ?? err.message}`))
      ctx.hmr.send({ type: 'error', err: { message: err.message, stack: err.stack, id: req.url } })
      if (!res.headersSent) {
        res.statusCode = 500
        res.end(err.message)
      }
    })
  })

  const watcher = watchFiles(root, (file) => {
    try {
      handleFileChange(file, ctx)
    } catch (err) {
      log(c.red(`hmr error: ${(err as Error).stack}`))
    }
  })
  httpServer.on('close', () => {
    watcher.close()
    ctx.hmr.close()
  })

  const port = await listen(httpServer, options.port)
  console.log(
    `\n  ${c.green(c.bold('mini-vite'))} ${c.dim(`ready in ${Math.round(performance.now() - start)} ms`)}\n\n` +
      `  ${c.green('➜')}  Local:  ${c.cyan(`http://localhost:${c.bold(String(port))}/`)}\n` +
      `  ${c.green('➜')}  Graph:  ${c.dim(`http://localhost:${port}/__mini-vite/graph`)}\n` +
      `  ${c.green('➜')}  Root:   ${c.dim(root)}\n`,
  )
  return httpServer
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: ServerContext): Promise<void> {
  const start = performance.now()
  const url = req.url ?? '/'
  const { pathname, searchParams } = new URL(url, 'http://localhost')

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    return void res.end()
  }

  const done = (what: string) => {
    if (ctx.debug) log(`${c.dim(what.padEnd(9))} ${url} ${c.dim(`${(performance.now() - start).toFixed(1)}ms`)}`)
  }

  // 1. The HMR client
  if (pathname === CLIENT_URL) {
    send(req, res, fs.readFileSync(clientFile), 'text/javascript')
    return done('client')
  }

  // 2. Debug view of the module graph (open it in the browser while you play with HMR)
  if (pathname === '/__mini-vite/graph') {
    send(req, res, JSON.stringify(ctx.graph, null, 2), 'application/json')
    return done('graph')
  }

  // 3. Pre-bundled npm dependencies. Already plain ESM, no transform needed.
  if (pathname.startsWith(DEPS_PREFIX)) {
    const file = urlToFile(pathname, ctx.root, ctx.optimizer.cacheDir)
    if (!isFile(file)) return notFound(res)
    send(req, res, fs.readFileSync(file), 'text/javascript')
    return done('dep')
  }

  // 4. HTML
  if (pathname.endsWith('/') || pathname.endsWith('.html')) {
    const file = urlToFile(pathname.endsWith('/') ? pathname + 'index.html' : pathname, ctx.root, ctx.optimizer.cacheDir)
    if (!isFile(file)) return notFound(res)
    return serveHtml(req, res, file, done)
  }

  // 5. Modules: JS-like files, or anything imported from JS (`?import`)
  if (JS_RE.test(pathname) || searchParams.has('import')) {
    const result = await transformRequest(url, ctx)
    send(req, res, result.code, 'text/javascript', result.etag)
    return done('transform')
  }

  // 6. Static files
  const file = urlToFile(pathname, ctx.root, ctx.optimizer.cacheDir)
  if (isFile(file)) {
    // Register it in the graph: it has no importers, so editing it triggers a full reload
    // (e.g. a <link rel="stylesheet">).
    ctx.graph.ensureEntry(fileToUrl(file, ctx.root), file)
    send(req, res, fs.readFileSync(file), mimeType(file))
    return done('static')
  }

  // 7. SPA fallback: /about -> index.html, so client-side routers work
  if (!path.extname(pathname)) {
    return serveHtml(req, res, path.join(ctx.root, 'index.html'), done)
  }

  notFound(res)
}

function serveHtml(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  done: (what: string) => void,
): void {
  send(req, res, transformIndexHtml(fs.readFileSync(file, 'utf-8')), 'text/html')
  done('html')
}

/**
 * Every response is `Cache-Control: no-cache` + ETag: the browser keeps a copy but asks
 * "is this still current?" each time, and we answer 304 if it is. Cheap reloads, never stale.
 */
function send(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string | Buffer,
  type: string,
  tag = etag(body),
): void {
  if (req.headers['if-none-match'] === tag) {
    res.statusCode = 304
    return void res.end()
  }
  res.setHeader('Content-Type', type.startsWith('text/') || type.includes('json') ? `${type}; charset=utf-8` : type)
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('ETag', tag)
  res.end(req.method === 'HEAD' ? undefined : body)
}

function notFound(res: http.ServerResponse): void {
  res.statusCode = 404
  res.end('Not found')
}

/** Listen on `port`, or the next free one, like Vite's 5173 -> 5174 fallback. */
function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log(c.yellow(`port ${port} is in use, trying ${port + 1}...`))
        server.listen(++port)
      } else reject(err)
    }
    server.on('error', onError)
    server.listen(port, () => {
      server.off('error', onError)
      resolve(port)
    })
  })
}
