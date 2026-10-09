/**
 * Dependency pre-bundling: what happens to `import React from "react"`.
 *
 * Two problems with serving node_modules straight to the browser:
 *
 *  1. The browser can't resolve bare specifiers. `"react"` isn't a URL.
 *  2. Most packages aren't browser-ready ESM. React ships CommonJS (`module.exports`,
 *     `require()`, `process.env.NODE_ENV`), and even ESM packages can be split into
 *     hundreds of tiny files, each one a separate HTTP request.
 *
 * So at startup we:
 *   - scan the app's source for bare imports (scanImports),
 *   - bundle all of them with esbuild in ONE build with code splitting, so react and
 *     react-dom share a single copy of React (two copies would break hooks),
 *   - write the result to node_modules/.mini-vite/deps and serve it at /@modules/<name>.js.
 *
 * Vite equivalent: packages/vite/src/node/optimizer/ (index.ts, scan.ts)
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type * as Esbuild from 'esbuild'
import { parseImports } from './lexer/index.js'
import { resolveImportPath } from './resolve.js'
import { DEPS_PREFIX, ESBUILD_RE, JS_RE, c, isBareImport, log, normalizePath } from './utils.js'

let esbuildPromise: Promise<typeof Esbuild> | undefined

/** esbuild is only loaded when needed (JSX/TS or bare imports), so a vanilla app never touches it. */
export function loadEsbuild(): Promise<typeof Esbuild> {
  return (esbuildPromise ??= import('esbuild').catch(() => {
    throw new Error('esbuild is required for JSX/TS files and npm dependencies: npm install esbuild')
  }))
}

/** JSX/TS -> plain JS. esbuild only strips types and compiles JSX here; it does not bundle. */
export async function esbuildTransform(code: string, file: string, sourcefile: string): Promise<string> {
  const esbuild = await loadEsbuild()
  const ext = path.extname(file).slice(1) as 'jsx' | 'ts' | 'tsx'
  const result = await esbuild.transform(code, {
    loader: ext,
    // "automatic" runtime turns <div/> into `jsx("div")` imported from "react/jsx-runtime",
    // which is itself a bare import the optimizer has to bundle.
    jsx: 'automatic',
    sourcemap: 'inline',
    sourcefile,
    target: 'es2022',
  })
  return result.code
}

/** "react-dom/client" -> "react-dom_client" (a flat file name for the cache dir). */
function flattenId(spec: string): string {
  return spec.replace(/\//g, '_')
}

const VALID_ID = /^[A-Za-z_$][\w$]*$/
const RESERVED = new Set(['default', 'arguments', 'eval', 'await', 'yield', 'let', 'static'])

/**
 * Build the virtual entry module for one dependency.
 *
 * esbuild can bundle CommonJS into ESM, but the result only has a `default` export,
 * because `module.exports` is a runtime object and ESM exports must be static. So
 * `import { useState } from "react"` would fail. We fix that by loading the package in
 * Node, reading its export names, and re-exporting each one explicitly.
 *
 * (Vite takes a different route: it rewrites `import { useState } from "react"` at the
 * import site into `import __cjs from "react"; const useState = __cjs.useState`.
 * Both approaches solve the same CJS/ESM interop gap.)
 */
function createDepEntry(spec: string, req: NodeJS.Require): string {
  const s = JSON.stringify(spec)
  let mod: unknown
  try {
    mod = req(spec)
  } catch {
    return `export * from ${s};`
  }
  if (Object.prototype.toString.call(mod) === '[object Module]') {
    // Already ESM (Node's require(esm) returned a namespace): pass it straight through.
    return `export * from ${s};` + ('default' in (mod as object) ? `export { default } from ${s};` : '')
  }
  const names =
    mod && (typeof mod === 'object' || typeof mod === 'function')
      ? Object.keys(mod).filter((k) => VALID_ID.test(k) && !RESERVED.has(k))
      : []
  return [
    `import __default from ${s};`,
    `export default __default;`,
    names.length ? `export const { ${names.join(', ')} } = __default;` : '',
  ].join('\n')
}

/**
 * Crawl the app from index.html and collect every bare import.
 * We follow relative imports with the same lexer the dev server uses for rewriting.
 */
export async function scanImports(root: string): Promise<Set<string>> {
  const deps = new Set<string>()
  const htmlFile = path.join(root, 'index.html')
  if (!fs.existsSync(htmlFile)) return deps

  const html = fs.readFileSync(htmlFile, 'utf-8')
  const queue: string[] = []
  for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)) {
    const file = resolveImportPath(src!, htmlFile, root)
    if (file) queue.push(file)
  }

  const seen = new Set<string>()
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file) || !JS_RE.test(file)) continue
    seen.add(file)
    try {
      let code = fs.readFileSync(file, 'utf-8')
      if (ESBUILD_RE.test(file)) code = await esbuildTransform(code, file, file)
      const imports = parseImports(code, normalizePath(path.relative(root, file)))
      for (const { n: spec, d } of imports) {
        if (!spec || d === -2) continue
        if (isBareImport(spec)) deps.add(spec)
        else {
          const resolved = resolveImportPath(spec, file, root)
          if (resolved) queue.push(resolved)
        }
      }
    } catch {
      // Syntax errors are reported properly when the browser requests the file.
    }
  }
  return deps
}

export class DepOptimizer {
  readonly cacheDir: string
  private deps = new Set<string>()
  private building: Promise<void> = Promise.resolve()
  private servedToBrowser = false

  constructor(
    private root: string,
    /** Called when a re-bundle invalidates modules the page already loaded. */
    private onFullReload: () => void,
  ) {
    this.cacheDir = path.join(root, 'node_modules', '.mini-vite', 'deps')
  }

  async init(force: boolean): Promise<void> {
    const found = await scanImports(this.root)
    found.forEach((d) => this.deps.add(d))
    if (!this.deps.size) return

    const metaFile = path.join(this.cacheDir, '_metadata.json')
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      if (!force && meta.hash === this.hash()) {
        log(c.dim(`deps cache is fresh: ${[...this.deps].join(', ')}`))
        return
      }
    } catch {}
    await this.build()
  }

  /** Map a bare specifier to its URL, bundling it first if we haven't seen it before. */
  async resolve(spec: string): Promise<string> {
    if (!this.deps.has(spec)) {
      log(c.yellow(`new dependency found: ${spec}, re-bundling...`))
      this.deps.add(spec)
      const needsReload = this.servedToBrowser
      this.building = this.building.then(() => this.build())
      await this.building
      // Chunks were regenerated. A page that already holds the old copy of a dep must
      // reload, or it would end up with two React instances.
      if (needsReload) this.onFullReload()
    }
    await this.building
    this.servedToBrowser = true
    return DEPS_PREFIX + flattenId(spec) + '.js'
  }

  /** Cache key: the set of deps plus the lockfile. A different lockfile means different package versions. */
  private hash(): string {
    const h = crypto.createHash('sha1').update([...this.deps].sort().join(','))
    let dir = this.root
    while (true) {
      const lock = path.join(dir, 'package-lock.json')
      if (fs.existsSync(lock)) {
        h.update(fs.readFileSync(lock))
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return h.digest('hex').slice(0, 8)
  }

  private async build(): Promise<void> {
    const start = performance.now()
    const esbuild = await loadEsbuild()
    const deps = [...this.deps].sort()
    const root = this.root
    const req = createRequire(path.join(root, 'noop.js'))

    fs.rmSync(this.cacheDir, { recursive: true, force: true })
    await esbuild.build({
      absWorkingDir: this.root,
      entryPoints: deps.map((d) => ({ in: `dep-entry:${d}`, out: flattenId(d) })),
      bundle: true,
      format: 'esm',
      // Code splitting puts modules shared between entries (React itself) into common
      // chunks, so react, react-dom/client and react/jsx-runtime all use ONE React.
      splitting: true,
      platform: 'browser',
      target: 'es2022',
      outdir: this.cacheDir,
      define: { 'process.env.NODE_ENV': '"development"' },
      logLevel: 'error',
      plugins: [
        {
          name: 'dep-entry',
          setup(build) {
            build.onResolve({ filter: /^dep-entry:/ }, (args) => ({
              path: args.path.slice('dep-entry:'.length),
              namespace: 'dep-entry',
            }))
            build.onLoad({ filter: /.*/, namespace: 'dep-entry' }, (args) => ({
              contents: createDepEntry(args.path, req),
              resolveDir: root,
              loader: 'js',
            }))
          },
        },
      ],
    })
    fs.writeFileSync(path.join(this.cacheDir, '_metadata.json'), JSON.stringify({ hash: this.hash(), deps }, null, 2))
    log(`pre-bundled ${c.green(deps.join(', '))} ${c.dim(`in ${Math.round(performance.now() - start)}ms`)}`)
  }
}
