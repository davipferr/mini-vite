# mini-vite

A ~1,400-line, heavily commented Vite clone in Node + TypeScript, written to answer one question:
**what actually happens when you run `npm run dev`?**

It resolves imports, builds a module graph, rewrites import paths, pre-bundles npm
dependencies, and does hot module replacement over a WebSocket.

Runtime dependencies:

| package           | why                                                                      |
| ----------------- | ------------------------------------------------------------------------ |
| `ws`              | the WebSocket that pushes "file changed" to the browser                  |
| `es-module-lexer` | finds `import` statements and their exact offsets (Vite uses it too)     |
| `esbuild`         | phase 2 only: JSX/TS → JS and bundling `react`. Lazy-loaded, so the vanilla app never touches it |

Everything else (the HTTP server, resolver, module graph, rewriting, file watching, HMR
propagation and the browser HMR client) is hand-written.

## Run it

```bash
npm install
```

```bash
npm run dev:vanilla
```

```bash
npm run dev:react
```

Or point it at any folder that has an `index.html`: `node dist/cli.js <root> [--port 5173] [--force] [--debug]`.

`--debug` logs every request with its timing. `/__mini-vite/graph` shows the live module graph as JSON.

## The tour: what happens on `npm run dev`

### 1. Startup ([server.ts](src/server.ts), [optimizer.ts](src/optimizer.ts))

The server starts in a few milliseconds because **it doesn't build anything**. The only
up-front work is dependency pre-bundling, and only if the app imports npm packages:

1. **Scan.** Crawl from `index.html` through every `<script src>` and relative import, and
   collect the bare imports (`react`, `react-dom/client`, `react/jsx-runtime`).
2. **Bundle.** One `esbuild.build` with all of them as entry points and `splitting: true`.
   Splitting matters: React's code lands in a shared chunk, so `react` and `react-dom` use
   the *same* React. Two copies would break hooks.
3. **Cache.** Output goes to `node_modules/.mini-vite/deps/`, keyed by a hash of the deps and
   the lockfile. The next start reuses it ("deps cache is fresh").

CommonJS gotcha: esbuild turns `module.exports` into a single `default` export, so
`import { useState } from 'react'` would fail. `createDepEntry` loads the package in Node,
reads its export names, and generates `export const { useState, ... } = __default`.
Vite fixes the same gap differently, by rewriting the import site.

### 2. The browser asks for `/` ([transform.ts](src/transform.ts) `transformIndexHtml`)

`index.html` is served with one line added:

```html
<script type="module" src="/@vite/client"></script>
```

That's the HMR client ([client.ts](src/client/client.ts)). It opens the WebSocket.

### 3. The browser asks for `/src/main.js` ([transform.ts](src/transform.ts))

This is the core of the dev server. Each module goes through:

```
read file
  → compile         .jsx/.ts via esbuild.transform; .css/.json/images become JS modules
  → importAnalysis  es-module-lexer finds every import, with exact character offsets
  → resolve         './counter' → C:\app\src\counter.js → '/src/counter.js'
                    'react'     → '/@modules/react.js'
  → rewrite         splice the new URLs into the code
  → graph           record main.js → counter.js edges
  → hmr             if the code mentions import.meta.hot, prepend createHotContext(url)
```

Try it: `curl localhost:5173/src/main.js` and compare with the file on disk.

```js
// on disk                           // what the browser gets
import './style.css'                 import '/src/style.css?import'
import App from './App'              import App from '/src/App.jsx'
import { useState } from 'react'     import { useState } from '/@modules/react.js'
```

The browser then requests each of those URLs and the process repeats. **The module graph
grows lazily, one request at a time.** Nothing the browser doesn't ask for gets processed.

`?import` marks "imported from JS": the same `style.css` is raw CSS for a `<link>`, but a JS
module (that injects a `<style>` tag) for `import './style.css'`.

Every response has `Cache-Control: no-cache` + `ETag`. The browser revalidates each module
and gets a `304` if nothing changed.

### 4. You save a file ([hmr.ts](src/hmr.ts))

```
fs.watch fires (debounced, since one save = several events)
  → find the file's module in the graph
  → invalidate it, plus the importers up to the boundary (drop cached transforms, stamp a timestamp)
  → propagateUpdate: walk up importers looking for HMR boundaries
  → ws.send({ type: 'update', updates: [{ path, acceptedPath, timestamp }] })
     or ws.send({ type: 'full-reload' }) if some path hit the top with no boundary
```

A **boundary** is a module that called `import.meta.hot.accept`:

```
main.js        accept('./message.js', cb)   ← boundary: { path: main.js, acceptedPath: message.js }
  └ message.js                              ← no accept, keep walking up
      └ format.js                           ← you edited this
```

### 5. The browser applies it ([client.ts](src/client/client.ts) `fetchUpdate`)

1. Run the old module's `dispose(data)` handler (clean up listeners, stash state in `data`).
2. `import('/src/message.js?t=1712345')`. **The `?t=` is the trick.** ES modules are cached
   by URL forever, so a new URL is the only way to make the browser execute a module again.
3. Call the boundary's accept callback with the fresh module.

Because `message.js` was invalidated, its re-transform rewrites its own import to
`/src/utils/format.js?t=1712345`, so the new `message.js` gets the new `format.js` too.

## Things to try

**Vanilla app** (`npm run dev:vanilla`), with DevTools Network open:

| edit                      | what happens                                    | why                                         |
| ------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `style.css`               | colors change, no reload                        | CSS modules are self-accepting              |
| `counter.js` label        | label changes, **count survives**               | self-accepting, state passed via `hot.data` |
| `message.js`              | only the message changes                        | `main.js` accepts it                        |
| `utils/format.js`         | same                                            | update bubbles up to `main.js`              |
| `main.js`                 | full reload                                     | no importer can accept it (dead end)        |
| `index.html`              | full reload                                     | HTML isn't a module                         |
| a syntax error            | error overlay; fix it and the page recovers     |                                             |

**React app** (`npm run dev:react`):

- Edit `Counter.jsx`. The UI updates without a reload, but **the count resets to 0**.
  `main.jsx` re-renders the new `App`, which is a different function, so React remounts the tree.
  Preserving state across edits is what React Fast Refresh does, and why
  `@vitejs/plugin-react` exists. (A great next step: wire in `react-refresh`.)
- Add `import { version } from 'react-dom'` to `App.jsx` while the server runs. A new
  dependency gets discovered, re-bundled, and the page reloads.
- Open `/__mini-vite/graph` and look at `react_jsx-runtime.js`. You never imported it:
  esbuild's JSX transform did.

## Phase 3: the import lexer in Rust, compiled to WebAssembly

Finding imports is the hottest step in the server: it runs on every module, every time
one changes. So that one function is swappable. The rest of the server stays in TypeScript
and calls `parseImports(code)` ([src/lexer/index.ts](src/lexer/index.ts)) without knowing
which implementation answers:

```bash
node dist/cli.js examples/react --lexer js        # es-module-lexer (default)
node dist/cli.js examples/react --lexer rust      # lexer-rs
node dist/cli.js examples/react --lexer compare   # both, per-module timings + diffs
```

```bash
npm run bench:lexer
```

In compare mode, every module logs `js 0.030ms  rust 0.016ms  ✓ 4 imports`, and
`/__mini-vite/lexer` shows the totals. es-module-lexer's answer is the one used, so a Rust
bug can't break the app. `bench:lexer` checks both lexers against every JS file in `node_modules`
(results must be identical) and then times them, grouped by file size. To run it on your own
code: `npm run bench:lexer -- path/to/src`. [lexer-rs/fixtures](lexer-rs/fixtures) holds
the tricky cases (strings, regexes, nested templates, `obj.import()`...).

### How Node talks to Rust

[lexer-rs/src/lib.rs](lexer-rs/src/lib.rs) has no dependencies and no wasm-bindgen. It
exports three plain functions, and [src/lexer/rust.ts](src/lexer/rust.ts) drives them:

```
JS                                         wasm (Rust)
ptr = input_buffer(code.length)    ───►    resize a Vec<u16>, return its address
write code as UTF-16 at ptr        ───►    (JS writes straight into wasm memory)
n = parse(code.length)             ───►    lex, store [s, e, d, isLiteral] per import
read n*4 i32s at output_ptr()      ◄───    (JS reads straight out of wasm memory)
```

Wasm functions only take and return numbers, so strings travel through the shared memory.
Rust lexes UTF-16 code units (`&[u16]`), not UTF-8, so its offsets are JS string indexes
with no conversion. That's also how es-module-lexer works.

### Reading the numbers honestly

- **es-module-lexer is already WebAssembly** (C compiled to wasm). This is wasm vs wasm,
  not JS vs Rust. Both pay the same cost to copy the string in and the results out.
- **lexer-rs does less work.** es-module-lexer also collects *exports*, statement ranges
  (`ss`/`se`), import attributes and facade detection; lexer-rs only finds what the dev
  server uses (`n`, `s`, `e`, `d`). Part of the speedup is simply skipping that work.
- **It's still small change.** Lexing all of this app's modules takes about a millisecond
  either way. In a real dev server, disk reads and esbuild's JSX transform cost far more.
- **Correctness is checked against es-module-lexer, not proven.** A lexer can't fully tell
  a regex from a division without parsing (`if (x) /re/.test(y)` fools lexer-rs). Run
  `bench:lexer` on more code to hunt for cases.

### Rebuilding the wasm

`wasm/mini_vite_lexer.wasm` is committed, so you only need Rust to change the lexer:

```bash
rustup target add wasm32-unknown-unknown
```

```bash
npm run build:wasm
```

## Map to the real Vite source

Clone [vitejs/vite](https://github.com/vitejs/vite) and open `packages/vite/src/`:

| mini-vite                         | Vite                                                       |
| --------------------------------- | ---------------------------------------------------------- |
| `server.ts`                       | `node/server/index.ts`, `node/server/middlewares/`          |
| `transform.ts` `transformRequest` | `node/server/transformRequest.ts`                           |
| `transform.ts` `importAnalysis`   | `node/plugins/importAnalysis.ts`                            |
| `transform.ts` `lexAcceptedHmrDeps` | `node/plugins/importAnalysis.ts` → `lexAcceptedHmrDeps` (`node/server/hmr.ts`) |
| `resolve.ts`                      | `node/plugins/resolve.ts`                                   |
| `moduleGraph.ts`                  | `node/server/moduleGraph.ts`                                |
| `hmr.ts` `propagateUpdate`        | `node/server/hmr.ts` → `propagateUpdate`                    |
| `optimizer.ts`                    | `node/optimizer/index.ts`, `node/optimizer/scan.ts`         |
| `client/client.ts`                | `client/client.ts`, `shared/hmr.ts`                         |

What real Vite adds on top: a plugin system (Rollup-compatible hooks; every step above is
a plugin), source-map chaining, `?t=` for CSS `<link>`s, HMR pruning, `hot.invalidate()`
propagation, `import.meta.glob`, env variables, SSR, and a production build via Rollup.

## Project layout

```
src/
  cli.ts            argument parsing
  server.ts         http server and request routing
  transform.ts      compile → import analysis → rewrite
  resolve.ts        specifier ↔ file ↔ URL
  moduleGraph.ts    ModuleNode, ModuleGraph, invalidation
  hmr.ts            WebSocket channel, fs.watch, update propagation
  optimizer.ts      dep scanning + esbuild pre-bundling
  client/client.ts  browser side: WebSocket, import.meta.hot, overlay
  lexer/index.ts    parseImports(): js / rust / compare switch
  lexer/rust.ts     loads the .wasm, copies strings in and results out
  lexer/bench.ts    correctness + speed comparison
lexer-rs/           the Rust import lexer (compiled to wasm/mini_vite_lexer.wasm)
examples/
  vanilla/          phase 1: plain JS, CSS, dynamic import
  react/            phase 2: JSX, TS, bare imports
```
