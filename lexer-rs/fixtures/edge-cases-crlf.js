#!/usr/bin/env node
// Tricky inputs for an import lexer. Run: npm run bench:lexer -- lexer-rs/fixtures
import defaultExport from './plain.js'
import * as ns from "./namespace.js"
import { a, b as c, "string-name" as d } from './named.js'
import def, { e } from './mixed.js'
import from from './default-named-from.js'
import './side-effect.js'
import json from './data.json' with { type: 'json' }
import {
  multi,
  line, // comment inside the braces
} from './multiline.js'
export { f } from './reexport.js'
export * from './star.js'
export * as starNs from './star-ns.js'
export { g as default } from './reexport-default.js'
export const notAnImport = 1
export default function () {}

// none of these are imports
const s1 = "import x from './in-double-quotes.js'"
const s2 = 'export * from "./in-single-quotes.js"'
const t1 = `import y from './in-template.js'`
/* import z from './in-block-comment.js' */
const obj = { import: 1, export: 2 }
obj.import('./method-call.js')
obj?.import('./optional-method.js')
obj
  .import('./method-on-next-line.js')

// template literals with nested expressions and nested templates
const t2 = `outer ${ `inner ${ import('./in-template-expr.js') }` } ${ { a: 1 }.a } done`

// regex vs division
const r1 = /import x from '.\/regex.js'/g
const r2 = a / 2 / 3
const r3 = [1, 2].map((x) => x / 2)
const r4 = /[/'"`]/.test(s1)
function f1() { return /'/.test(s1) }
const r5 = typeof /x/
const r6 = (1) / 2

// dynamic imports
import('./dynamic.js')
import ( "./dynamic-spaces.js" )
import('./dynamic-with-options.js', { with: { type: 'json' } })
import(`./template-dynamic.js`)
import('./' + name)
import(name)
const lazy = async () => (await import('./awaited.js')).default
;[...import.meta.glob]
if (import.meta.hot) import.meta.hot.accept('./accepted.js')
import.meta.url

// unicode and escapes
const ünïcödé = '✓ — 漢字 🎉'
import('./emoji-🎉.js')
import esc from './esc\u0061ped.js'
const t3 = `\`${'}'}\``
