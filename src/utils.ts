import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Files the browser can execute as ES modules once we've transformed them. */
export const JS_RE = /\.(m?js|jsx|tsx?)$/
/** Files that browsers can't run directly; they go through esbuild first. */
export const ESBUILD_RE = /\.(jsx|tsx?)$/

/** Extensions tried, in order, when an import omits one (`import App from './App'`). */
export const RESOLVE_EXTENSIONS = ['.js', '.mjs', '.jsx', '.ts', '.tsx', '.json']

/** URL the HMR client is served from. Every page gets a <script> tag for it. */
export const CLIENT_URL = '/@vite/client'
/** URL prefix for pre-bundled npm dependencies. */
export const DEPS_PREFIX = '/@modules/'
/** URL prefix for files outside the project root. */
export const FS_PREFIX = '/@fs'

/** Strip `?query` and `#hash`: `/src/a.css?import&t=123` -> `/src/a.css` */
export function cleanUrl(url: string): string {
  return url.replace(/[?#].*$/, '')
}

/** Add a query param to a URL that may already have one. */
export function injectQuery(url: string, query: string): string {
  return url + (url.includes('?') ? '&' : '?') + query
}

/** Windows paths use `\`, but URLs and our map keys use `/`. */
export function normalizePath(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * A "bare" import names a package rather than a file: `react`, `react-dom/client`, `@scope/pkg`.
 * The browser has no idea where those live, which is why a dev server must rewrite them.
 */
export function isBareImport(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(spec)
}

export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function etag(content: string | Buffer): string {
  return `W/"${crypto.createHash('sha1').update(content).digest('base64url').slice(0, 27)}"`
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
}

export function mimeType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

const ansi = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`
export const c = { dim: ansi(2), bold: ansi(1), red: ansi(31), green: ansi(32), yellow: ansi(33), cyan: ansi(36) }

export function log(msg: string): void {
  const time = new Date().toLocaleTimeString()
  console.log(`${c.dim(time)} ${c.cyan(c.bold('[mini-vite]'))} ${msg}`)
}
