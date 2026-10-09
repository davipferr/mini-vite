#!/usr/bin/env node
import { createServer } from './server.js'
import { c } from './utils.js'

const HELP = `
Usage: mini-vite [root] [options]

Options:
  --port <n>   port to listen on (default 5173)
  --force      ignore the dependency cache and re-bundle
  --debug      log every request with its timing
  -h, --help   show this message
`

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP)
  process.exit(0)
}

let root = '.'
let port = 5173
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg === '--port') port = Number(args[++i])
  else if (!arg.startsWith('--')) root = arg
}

createServer({ root, port, force: args.includes('--force'), debug: args.includes('--debug') }).catch((err: Error) => {
  console.error(c.red(`error when starting dev server:\n${err.stack ?? err.message}`))
  process.exit(1)
})
