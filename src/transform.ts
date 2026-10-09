/**
 * The transform pipeline. Runs when the browser requests a module:
 *
 *   read file
 *     -> compile (JSX/TS via esbuild; CSS/JSON/assets become JS modules)
 *     -> import analysis: find every import with es-module-lexer, resolve it, and rewrite
 *        the specifier to a URL the browser can fetch
 *     -> record the edges in the module graph
 *     -> inject `import.meta.hot` if the module uses HMR
 *
 * Vite equivalent: packages/vite/src/node/server/transformRequest.ts
 *                  packages/vite/src/node/plugins/importAnalysis.ts  <- the interesting one
 */
import fs from 'node:fs/promises'
import { init, parse } from 'es-module-lexer'
import type { ServerContext } from './context.js'
import type { ModuleNode, TransformResult } from './moduleGraph.js'
import { esbuildTransform } from './optimizer.js'
import { fileToUrl, resolveImportPath, urlToFile } from './resolve.js'
import { CLIENT_URL, ESBUILD_RE, JS_RE, cleanUrl, etag, injectQuery, isBareImport } from './utils.js'

export async function transformRequest(url: string, ctx: ServerContext): Promise<TransformResult> {
  const cleanedUrl = cleanUrl(url)
  const file = urlToFile(cleanedUrl, ctx.root, ctx.optimizer.cacheDir)
  // The graph is keyed by the URL *without* query, so `/a.js` and `/a.js?t=123` are the same node.
  const mod = ctx.graph.ensureEntry(cleanedUrl, file)
  if (mod.transformResult) return mod.transformResult

  // Transforms are async (esbuild, dep bundling), so the file can change while one is in
  // flight. If that happens, a newer transform has started, and this one must not
  // overwrite its cache entry or graph edges with stale content.
  const invalidatedAt = mod.lastHMRTimestamp

  const analysis = await importAnalysis(await loadAndCompile(mod), mod, ctx)
  const result = { code: analysis.code, etag: etag(analysis.code) }

  if (mod.lastHMRTimestamp === invalidatedAt) {
    ctx.graph.updateModuleInfo(mod, analysis.importedModules, analysis.acceptedUrls, analysis.isSelfAccepting)
    mod.transformResult = result
  }
  return result
}

/** Turn whatever the file is into JavaScript source. */
async function loadAndCompile(mod: ModuleNode): Promise<string> {
  const { url, file } = mod

  if (JS_RE.test(file)) {
    const code = await fs.readFile(file, 'utf-8')
    return ESBUILD_RE.test(file) ? esbuildTransform(code, file, url) : code
  }

  // `import './style.css'` -> a JS module that injects a <style> tag and replaces
  // its contents on every hot update. That's all CSS HMR is.
  if (file.endsWith('.css')) {
    const css = await fs.readFile(file, 'utf-8')
    return [
      `import { updateStyle } from ${JSON.stringify(CLIENT_URL)};`,
      `const css = ${JSON.stringify(css)};`,
      `updateStyle(${JSON.stringify(url)}, css);`,
      `import.meta.hot.accept();`,
      `export default css;`,
    ].join('\n')
  }

  if (file.endsWith('.json')) {
    return `export default ${await fs.readFile(file, 'utf-8')};`
  }

  // Any other asset (`import logo from './logo.svg'`) evaluates to its URL.
  return `export default ${JSON.stringify(url)};`
}

interface Edit {
  start: number
  end: number
  text: string
}

/** Apply text replacements back to front so earlier offsets stay valid. (A tiny MagicString.) */
function applyEdits(code: string, edits: Edit[]): string {
  for (const { start, end, text } of [...edits].sort((a, b) => b.start - a.start)) {
    code = code.slice(0, start) + text + code.slice(end)
  }
  return code
}

interface ImportAnalysis {
  code: string
  importedModules: Map<string, string> // url -> file
  acceptedUrls: Set<string>
  isSelfAccepting: boolean
}

async function importAnalysis(code: string, mod: ModuleNode, ctx: ServerContext): Promise<ImportAnalysis> {
  await init
  const [imports] = parse(code, mod.url)

  const edits: Edit[] = []
  const importedModules = new Map<string, string>()

  for (const { n: specifier, s: start, e: end, d: dynamicIndex } of imports) {
    if (dynamicIndex === -2) continue // `import.meta`, not an import
    // `import(someVariable)`: unknowable until runtime, so we leave it alone.
    // (Vite injects a runtime helper for this case.)
    if (!specifier) continue

    const resolved = await resolveImport(specifier, mod, ctx)
    if (!resolved) continue
    importedModules.set(resolved.url, resolved.file)

    let url = resolved.url
    // Non-JS imports (CSS, JSON, images) get `?import` so the server knows to answer with
    // a JS module rather than the raw file, which is what a <link> or <img> would get.
    if (!resolved.isDep && !JS_RE.test(url)) url = injectQuery(url, 'import')
    // Cache busting: if this dep was hot-updated, point at the new version.
    const depMod = ctx.graph.getModuleByUrl(resolved.url)
    if (depMod?.lastHMRTimestamp) url = injectQuery(url, `t=${depMod.lastHMRTimestamp}`)

    // For static imports, [start, end) is the bare text inside the quotes.
    // For dynamic `import('./x')` it includes the quotes.
    const isDynamic = dynamicIndex > -1
    edits.push({ start, end, text: isDynamic ? JSON.stringify(url) : url })
  }

  let isSelfAccepting = false
  const acceptedUrls = new Set<string>()
  const usesHmr = code.includes('import.meta.hot')

  if (usesHmr) {
    const accepted = lexAcceptedHmrDeps(code)
    isSelfAccepting = accepted.selfAccepts
    // `import.meta.hot.accept('./message.js', cb)`: the client matches updates by URL,
    // so './message.js' has to be rewritten to '/src/message.js' just like an import.
    for (const dep of accepted.deps) {
      const resolved = await resolveImport(dep.specifier, mod, ctx)
      if (!resolved) continue
      acceptedUrls.add(resolved.url)
      edits.push({ start: dep.start, end: dep.end, text: JSON.stringify(resolved.url) })
    }
  }

  code = applyEdits(code, edits)

  if (usesHmr) {
    // Give this module its own `import.meta.hot` object, bound to its URL.
    // Prepended on the same line so line numbers (and esbuild's source map) stay correct.
    code =
      `import { createHotContext as __mv_createHotContext } from ${JSON.stringify(CLIENT_URL)};` +
      `import.meta.hot = __mv_createHotContext(${JSON.stringify(mod.url)});` +
      code
  }
  return { code, importedModules, acceptedUrls, isSelfAccepting }
}

interface ResolvedImport {
  url: string
  file: string
  isDep: boolean
}

async function resolveImport(specifier: string, importer: ModuleNode, ctx: ServerContext): Promise<ResolvedImport | null> {
  // Our own virtual modules and remote URLs are left as-is and stay out of the graph.
  if (specifier.startsWith('/@vite/') || /^(https?:|data:|\/\/)/.test(specifier)) return null

  if (isBareImport(specifier)) {
    const url = await ctx.optimizer.resolve(specifier)
    return { url, file: urlToFile(url, ctx.root, ctx.optimizer.cacheDir), isDep: true }
  }

  const file = resolveImportPath(specifier, importer.file, ctx.root)
  if (!file) {
    throw new Error(`Failed to resolve import "${specifier}" from "${importer.url}". Does the file exist?`)
  }
  return { url: fileToUrl(file, ctx.root), file, isDep: false }
}

interface AcceptedDep {
  specifier: string
  /** Offsets of the string literal, quotes included. */
  start: number
  end: number
}

/**
 * Find out what a module accepts by scanning its `import.meta.hot.accept(...)` calls:
 *
 *   accept()  /  accept(cb)            -> self-accepting
 *   accept('./dep', cb)                -> accepts updates of ./dep
 *   accept(['./a', './b'], cb)         -> accepts updates of ./a and ./b
 *
 * A hand-written scanner, not a parser. Vite does the same thing (lexAcceptedHmrDeps).
 */
export function lexAcceptedHmrDeps(code: string): { selfAccepts: boolean; deps: AcceptedDep[] } {
  let selfAccepts = false
  const deps: AcceptedDep[] = []

  for (const match of code.matchAll(/import\.meta\.hot\.accept\s*\(/g)) {
    let i = skipWhitespace(code, match.index + match[0].length)
    const ch = code[i]
    if (isQuote(ch)) {
      deps.push(readString(code, i))
    } else if (ch === '[') {
      i++
      while (i < code.length) {
        i = skipWhitespace(code, i)
        if (code[i] === ',') i++
        else if (isQuote(code[i])) {
          const dep = readString(code, i)
          deps.push(dep)
          i = dep.end
        } else break // `]`, or something we can't analyze statically
      }
    } else {
      selfAccepts = true
    }
  }
  return { selfAccepts, deps }
}

function isQuote(ch: string | undefined): boolean {
  return ch === '"' || ch === "'" || ch === '`'
}

function skipWhitespace(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i]!)) i++
  return i
}

function readString(code: string, start: number): AcceptedDep {
  const quote = code[start]
  let i = start + 1
  while (i < code.length && code[i] !== quote) {
    if (code[i] === '\\') i++
    i++
  }
  return { specifier: code.slice(start + 1, i), start, end: i + 1 }
}

/** Inject the HMR client into index.html. Nothing in the user's HTML references it. */
export function transformIndexHtml(html: string): string {
  const tag = `<script type="module" src="${CLIENT_URL}"></script>`
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n    ${tag}`) : tag + html
}
