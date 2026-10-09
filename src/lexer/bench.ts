/**
 * Compare es-module-lexer and the Rust lexer: same results? which is faster?
 *
 *   npm run bench:lexer                 corpus = examples/ + every .js/.mjs/.cjs in node_modules
 *   npm run bench:lexer -- <dir> ...    corpus = the given directories
 *
 * es-module-lexer is the reference: any difference counts as a Rust bug.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { esbuildTransform } from '../optimizer.js'
import { c } from '../utils.js'
import { diffOutcomes, esModuleLexer, initLexer, rustLexer } from './index.js'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

interface SourceFile {
  file: string
  code: string
}

async function collectCorpus(dirs: string[]): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'target') await walk(full)
      } else if (/\.(m?js|cjs)$/.test(entry.name)) {
        files.push({ file: full, code: fs.readFileSync(full, 'utf-8') })
      } else if (/\.(jsx|tsx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        // what the dev server actually lexes: esbuild's output
        files.push({ file: full, code: await esbuildTransform(fs.readFileSync(full, 'utf-8'), full, full) })
      }
    }
  }
  for (const dir of dirs) await walk(dir)
  return files
}

const parsers = {
  'es-module-lexer': (code: string) => esModuleLexer.parse(code)[0],
  rust: (code: string) => rustLexer.parse(code),
}
type ParserName = keyof typeof parsers

function run(name: ParserName, code: string) {
  try {
    return { imports: parsers[name](code) }
  } catch (error) {
    return { error: error as Error }
  }
}

function checkCorrectness(corpus: SourceFile[]): SourceFile[] {
  let agree = 0
  let bothFailed = 0
  const mismatches: Array<{ file: string; diff: string }> = []
  const comparable: SourceFile[] = []

  for (const src of corpus) {
    const js = run('es-module-lexer', src.code)
    const diff = diffOutcomes(js, run('rust', src.code))
    if (diff) mismatches.push({ file: path.relative(projectRoot, src.file), diff })
    else if (js.error) bothFailed++
    else {
      agree++
      comparable.push(src)
    }
  }

  console.log(c.bold('\nCorrectness') + c.dim(' (es-module-lexer is the reference)'))
  console.log(`  ${c.green(String(agree))} files with identical results`)
  if (bothFailed) console.log(`  ${bothFailed} files rejected by both`)
  console.log(`  ${mismatches.length ? c.red(String(mismatches.length)) : c.green('0')} mismatches`)
  for (const m of mismatches.slice(0, 15)) console.log(`    ${c.yellow(m.file)}\n      ${m.diff}`)
  if (mismatches.length > 15) console.log(c.dim(`    ...and ${mismatches.length - 15} more`))
  return comparable
}

/** Time `passes` runs over every file; returns ms per pass (best of several rounds). */
function timePasses(name: ParserName, files: SourceFile[]): number {
  const parse = parsers[name]
  const once = () => {
    const start = performance.now()
    for (const { code } of files) parse(code)
    return performance.now() - start
  }
  for (let i = 0; i < 3; i++) once() // warm up the JIT and grow wasm memory
  let best = Infinity
  const deadline = performance.now() + 1500
  for (let i = 0; i < 5 || (performance.now() < deadline && i < 200); i++) best = Math.min(best, once())
  return best
}

function benchmark(files: SourceFile[]): void {
  const groups: Array<[string, SourceFile[]]> = [
    ['small  (< 4 KB)', files.filter((f) => f.code.length < 4_000)],
    ['medium (4–100 KB)', files.filter((f) => f.code.length >= 4_000 && f.code.length < 100_000)],
    ['large  (≥ 100 KB)', files.filter((f) => f.code.length >= 100_000)],
    ['all', files],
  ]

  console.log(c.bold('\nSpeed') + c.dim(' (best pass, files both lexers agree on)\n'))
  console.log(c.dim('  group               files      size   es-module-lexer        rust              rust vs js'))
  for (const [label, group] of groups) {
    if (!group.length) continue
    const chars = group.reduce((sum, f) => sum + f.code.length, 0)
    const js = timePasses('es-module-lexer', group)
    const rust = timePasses('rust', group)
    const mbps = (ms: number) => `${(chars / 1e6 / (ms / 1000)).toFixed(0).padStart(5)} MB/s`
    const ratio = js / rust
    const verdict = ratio >= 1 ? c.green(`${ratio.toFixed(2)}x faster`) : c.yellow(`${(1 / ratio).toFixed(2)}x slower`)
    console.log(
      `  ${label.padEnd(18)} ${String(group.length).padStart(6)} ${`${(chars / 1e6).toFixed(1)} MB`.padStart(9)}` +
        `   ${js.toFixed(2).padStart(8)}ms ${c.dim(mbps(js))}   ${rust.toFixed(2).padStart(8)}ms ${c.dim(mbps(rust))}   ${verdict}`,
    )
  }
  console.log(c.dim('\n  size = UTF-16 code units (≈ characters). Small files are dominated by the per-call cost of'))
  console.log(c.dim('  crossing into wasm; large files measure the lexing loop itself.\n'))
}

const dirs = process.argv.slice(2)
const corpusDirs = dirs.length
  ? dirs.map((d) => path.resolve(d))
  : [path.join(projectRoot, 'examples'), path.join(projectRoot, 'node_modules')]

await initLexer('compare')
const corpus = await collectCorpus(corpusDirs)
const totalMb = corpus.reduce((sum, f) => sum + f.code.length, 0) / 1e6
console.log(`${c.cyan(c.bold('[lexer bench]'))} ${corpus.length} files, ${totalMb.toFixed(1)} MB from ${corpusDirs.map((d) => path.relative(projectRoot, d) || '.').join(', ')}`)

benchmark(checkCorrectness(corpus))
