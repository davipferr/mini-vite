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
examples/
  vanilla/          phase 1: plain JS, CSS, dynamic import
  react/            phase 2: JSX, TS, bare imports
```
