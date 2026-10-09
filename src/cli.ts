#!/usr/bin/env node
import { LEXER_MODES, type LexerMode } from './lexer/index.js'
import { createServer } from './server.js'
import { c } from './utils.js'

const HELP = `
Usage: mini-vite [root] [options]

Options:
  --port <n>     port to listen on (default 5173)
  --lexer <l>    how imports are found:
                   js       es-module-lexer, C compiled to wasm (default)
                   rust     lexer-rs, Rust compiled to wasm
                   compare  run both on every module, log timings and differences
  --force        ignore the dependency cache and re-bundle
  --debug        log every request with its timing
  -h, --help     show this message
`

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP)
  process.exit(0)
}

let root = '.'
let port = 5173
let lexer: LexerMode = 'js'
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg === '--port') port = Number(args[++i])
  else if (arg === '--lexer') lexer = args[++i] as LexerMode
  else if (!arg.startsWith('--')) root = arg
}

if (!LEXER_MODES.includes(lexer)) {
  console.error(c.red(`--lexer must be one of: ${LEXER_MODES.join(', ')}`))
  process.exit(1)
}

createServer({ root, port, lexer, force: args.includes('--force'), debug: args.includes('--debug') }).catch(
  (err: Error) => {
    console.error(c.red(`error when starting dev server:\n${err.stack ?? err.message}`))
    process.exit(1)
  },
)
