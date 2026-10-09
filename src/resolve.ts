/**
 * Mapping between the three "names" every module has:
 *
 *   specifier  what the source code says          './counter'        'react'
 *   file       where it lives on disk             C:\app\src\counter.js
 *   url        what the browser requests          /src/counter.js    /@modules/react.js
 *
 * The browser only understands URLs, so the dev server's main job is turning
 * specifiers into URLs (rewriting) and URLs back into files (serving).
 *
 * Vite equivalent: packages/vite/src/node/plugins/resolve.ts
 */
import path from 'node:path'
import { DEPS_PREFIX, FS_PREFIX, RESOLVE_EXTENSIONS, cleanUrl, isFile, normalizePath } from './utils.js'

/**
 * Find the actual file for a path that may be missing its extension or point at a directory,
 * the same way Node and bundlers do: exact match, then `+ext`, then `/index+ext`.
 */
export function tryResolveFile(base: string): string | null {
  if (isFile(base)) return base
  for (const ext of RESOLVE_EXTENSIONS) {
    if (isFile(base + ext)) return base + ext
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const index = path.join(base, 'index' + ext)
    if (isFile(index)) return index
  }
  return null
}

/**
 * Resolve a relative (`./x`) or root-absolute (`/src/x`) specifier written inside `importer`.
 * Bare imports (`react`) are not handled here; they belong to the dep optimizer.
 */
export function resolveImportPath(spec: string, importer: string, root: string): string | null {
  const clean = cleanUrl(spec)
  const base = clean.startsWith('/') ? path.join(root, clean) : path.resolve(path.dirname(importer), clean)
  return tryResolveFile(base)
}

/** C:\app\src\main.js -> /src/main.js   (files outside root -> /@fs/C:/elsewhere/x.js) */
export function fileToUrl(file: string, root: string): string {
  const rel = path.relative(root, file)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const abs = normalizePath(file)
    return FS_PREFIX + (abs.startsWith('/') ? '' : '/') + abs
  }
  return '/' + normalizePath(rel)
}

/** The reverse of fileToUrl, plus the virtual /@modules/ namespace for pre-bundled deps. */
export function urlToFile(url: string, root: string, depsDir: string): string {
  const clean = decodeURIComponent(cleanUrl(url))
  if (clean.startsWith(DEPS_PREFIX)) return path.join(depsDir, clean.slice(DEPS_PREFIX.length))
  if (clean.startsWith(FS_PREFIX + '/')) {
    const abs = clean.slice(FS_PREFIX.length)
    // "/C:/x" on Windows -> "C:/x"; "/home/x" on POSIX stays as is
    return path.resolve(/^\/[a-zA-Z]:\//.test(abs) ? abs.slice(1) : abs)
  }
  return path.join(root, clean)
}
