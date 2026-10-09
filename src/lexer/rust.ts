/**
 * Loads lexer-rs (Rust compiled to WebAssembly) and exposes the same `parse()` shape as
 * es-module-lexer, so the rest of the server can't tell them apart.
 *
 * There's no generated glue (no wasm-bindgen). A wasm module only understands numbers,
 * so passing a string means:
 *
 *   ask Rust for a buffer -> write the string into wasm memory -> call parse(len)
 *   -> read the results back out of wasm memory as an Int32Array
 *
 * Those two copies are the cost of crossing the JS/wasm boundary. es-module-lexer
 * (C compiled to wasm) pays exactly the same toll.
 */
import fs from 'node:fs'

export interface ImportSpecifier {
  /** The specifier's value (`./a.js`), or undefined when not a plain string (`import(x)`). */
  readonly n: string | undefined
  /** Specifier start/end. Static: without quotes. Dynamic: with quotes. import.meta: the whole thing. */
  readonly s: number
  readonly e: number
  /** -1 static import, -2 import.meta, otherwise the offset of the `(` of a dynamic import(). */
  readonly d: number
}

/** The functions lexer-rs/src/lib.rs exports. */
interface LexerExports {
  memory: WebAssembly.Memory
  input_buffer(len: number): number
  parse(len: number): number
  output_ptr(): number
}

const wasmFile = new URL('../../wasm/mini_vite_lexer.wasm', import.meta.url)
let wasm: LexerExports | undefined

export async function init(): Promise<void> {
  if (wasm) return
  // Compile + instantiate. The module needs no imports: no WASI, no JS callbacks.
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmFile))
  wasm = instance.exports as unknown as LexerExports
}

export function parse(code: string, name = '@'): ImportSpecifier[] {
  if (!wasm) throw new Error('Rust lexer not initialized: await init() first')

  const len = code.length // UTF-16 code units, which is what Rust lexes
  const ptr = wasm.input_buffer(len)
  // Create the view *after* input_buffer(): growing wasm memory replaces memory.buffer,
  // and views created on the old one become detached (length 0).
  // Buffer#write with 'utf16le' copies the string's code units straight in, no temp copy.
  Buffer.from(wasm.memory.buffer, ptr, len * 2).write(code, 'utf16le')

  const count = wasm.parse(len)
  if (count < 0) throw parseError(code, -count - 1, name)

  const out = new Int32Array(wasm.memory.buffer, wasm.output_ptr(), count * 4)
  const imports: ImportSpecifier[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const s = out[i * 4]!
    const e = out[i * 4 + 1]!
    const d = out[i * 4 + 2]!
    const isLiteral = out[i * 4 + 3] === 1
    // Rust reports where the string is; reading its value is easier on the JS side.
    const n = isLiteral ? decodeString(d > -1 ? code.slice(s + 1, e - 1) : code.slice(s, e)) : undefined
    imports[i] = { n, s, e, d }
  }
  return imports
}

/** Same message format as es-module-lexer: "Parse error <name>:<line>:<col>". */
function parseError(code: string, offset: number, name: string): Error {
  const before = code.slice(0, offset).split(/\r\n|\r|\n/)
  return new Error(`Parse error ${name}:${before.length}:${before.at(-1)!.length + 1}`)
}

/** Process escape sequences in a string literal's body: `\x41` -> `A`. Rare in import paths. */
function decodeString(raw: string): string {
  if (!raw.includes('\\')) return raw
  return raw.replace(/\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|(\r\n|[\r\n])|(.))/gs,
    (_, codePoint, u4, x2, lineContinuation, ch) => {
      if (codePoint || u4 || x2) return String.fromCodePoint(parseInt(codePoint ?? u4 ?? x2, 16))
      if (lineContinuation) return ''
      return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }[ch as string] ?? ch
    })
}
