/**
 * The one function the dev server uses to find imports, with a switchable implementation:
 *
 *   --lexer js       es-module-lexer (C compiled to wasm, what Vite uses). The default.
 *   --lexer rust     lexer-rs (Rust compiled to wasm, ours)
 *   --lexer compare  run both on every module, use es-module-lexer's answer, and log
 *                    timings and any difference between the two
 */
import * as esModuleLexer from 'es-module-lexer'
import { c, log } from '../utils.js'
import * as rustLexer from './rust.js'
import type { ImportSpecifier } from './rust.js'

export type { ImportSpecifier }
export type LexerMode = 'js' | 'rust' | 'compare'
export const LEXER_MODES: readonly LexerMode[] = ['js', 'rust', 'compare']

let mode: LexerMode = 'js'

export async function initLexer(lexerMode: LexerMode): Promise<void> {
  mode = lexerMode
  await esModuleLexer.init // es-module-lexer is also wasm and must be compiled first
  if (mode !== 'js') await rustLexer.init()
}

export function parseImports(code: string, name?: string): readonly ImportSpecifier[] {
  if (mode === 'js') return esModuleLexer.parse(code, name)[0]
  if (mode === 'rust') return rustLexer.parse(code, name)
  return compareLexers(code, name)
}

// ---------------------------------------------------------------------------
// compare mode
// ---------------------------------------------------------------------------

const stats = { calls: 0, bytes: 0, jsMs: 0, rustMs: 0, mismatches: [] as Array<{ name?: string; diff: string }> }

export function getLexerStats() {
  return {
    mode,
    ...stats,
    jsMs: +stats.jsMs.toFixed(3),
    rustMs: +stats.rustMs.toFixed(3),
    rustVsJs: stats.jsMs ? `${(stats.rustMs / stats.jsMs).toFixed(2)}x the time of es-module-lexer` : null,
  }
}

type Outcome = { imports: readonly ImportSpecifier[]; error?: undefined } | { imports?: undefined; error: Error }

function timed(fn: () => readonly ImportSpecifier[]): [Outcome, number] {
  const start = performance.now()
  let outcome: Outcome
  try {
    outcome = { imports: fn() }
  } catch (error) {
    outcome = { error: error as Error }
  }
  return [outcome, performance.now() - start]
}

function compareLexers(code: string, name?: string): readonly ImportSpecifier[] {
  const [js, jsMs] = timed(() => esModuleLexer.parse(code, name)[0])
  const [rust, rustMs] = timed(() => rustLexer.parse(code, name))

  stats.calls++
  stats.bytes += code.length
  stats.jsMs += jsMs
  stats.rustMs += rustMs

  const diff = diffOutcomes(js, rust)
  if (diff) stats.mismatches.push({ name, diff })

  const label = (name ?? '<anonymous>').padEnd(28)
  const timing = `js ${jsMs.toFixed(3)}ms  rust ${rustMs.toFixed(3)}ms`
  const result = diff ? c.red(`✗ ${diff}`) : c.green(`✓ ${js.error ? 'both errored' : `${js.imports!.length} imports`}`)
  log(`${c.dim('lexer')} ${label} ${c.dim(timing)}  ${result}`)

  // es-module-lexer stays the source of truth, so a Rust bug can't break the app.
  if (js.error) throw js.error
  return js.imports!
}

/** Describe the first difference between two lexer results, or return null if they agree. */
export function diffOutcomes(a: Outcome, b: Outcome): string | null {
  if (a.error || b.error) {
    if (a.error && b.error) return null
    return a.error ? `only es-module-lexer failed: ${a.error.message}` : `only rust failed: ${b.error!.message}`
  }
  const x = a.imports!
  const y = b.imports!
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i]
    const q = y[i]
    if (!p || !q) return `import #${i}: ${p ? 'missing in rust' : 'extra in rust'} (${JSON.stringify(p ?? q)})`
    if (p.n !== q.n || p.s !== q.s || p.e !== q.e || p.d !== q.d) {
      const fmt = (v: ImportSpecifier) => JSON.stringify({ n: v.n, s: v.s, e: v.e, d: v.d })
      return `import #${i}: js ${fmt(p)} vs rust ${fmt(q)}`
    }
  }
  return null
}

export { esModuleLexer, rustLexer }
