/**
 * The module graph: every module the browser has requested, and who imports whom.
 *
 * It's built lazily. Nothing is crawled up front; each time we transform a module we
 * learn its imports and record the edges. That's why Vite starts instantly: it only
 * ever processes what the browser actually asks for.
 *
 * HMR needs the graph to walk *upwards* (importers) from a changed file and find
 * a module that knows how to accept the update.
 *
 * Vite equivalent: packages/vite/src/node/server/moduleGraph.ts
 */

export interface TransformResult {
  code: string
  etag: string
}

export class ModuleNode {
  /** Modules that import this one (edges pointing up, used for HMR propagation). */
  importers = new Set<ModuleNode>()
  /** Modules this one imports (edges pointing down). */
  importedModules = new Set<ModuleNode>()
  /** Deps whose updates this module handles via `import.meta.hot.accept('./dep', cb)`. */
  acceptedHmrDeps = new Set<ModuleNode>()
  /** True if the module calls `import.meta.hot.accept()` / `accept(cb)` on itself. */
  isSelfAccepting = false
  /** Cached output of the transform pipeline. Cleared when the file (or a dep) changes. */
  transformResult: TransformResult | null = null
  /**
   * When this module last changed. Importers that get re-transformed append `?t=<timestamp>`
   * to its URL so the browser fetches a fresh copy instead of reusing the cached instance.
   */
  lastHMRTimestamp = 0

  constructor(
    public readonly url: string,
    public readonly file: string,
  ) {}
}

export class ModuleGraph {
  private urlToModule = new Map<string, ModuleNode>()
  // One file can back several URLs in Vite (e.g. ?raw, ?url), hence a Set.
  private fileToModules = new Map<string, Set<ModuleNode>>()

  getModuleByUrl(url: string): ModuleNode | undefined {
    return this.urlToModule.get(url)
  }

  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModules.get(file)
  }

  ensureEntry(url: string, file: string): ModuleNode {
    let mod = this.urlToModule.get(url)
    if (!mod) {
      mod = new ModuleNode(url, file)
      this.urlToModule.set(url, mod)
      let set = this.fileToModules.get(file)
      if (!set) this.fileToModules.set(file, (set = new Set()))
      set.add(mod)
    }
    return mod
  }

  /**
   * Called after a module is transformed: replace its outgoing edges with what we just found,
   * and remove it from the importers of anything it no longer imports.
   */
  updateModuleInfo(
    mod: ModuleNode,
    imported: Map<string, string>, // url -> file
    acceptedUrls: Set<string>,
    isSelfAccepting: boolean,
  ): void {
    mod.isSelfAccepting = isSelfAccepting

    const next = new Set<ModuleNode>()
    for (const [url, file] of imported) {
      const dep = this.ensureEntry(url, file)
      dep.importers.add(mod)
      next.add(dep)
    }
    for (const dep of mod.importedModules) {
      if (!next.has(dep)) dep.importers.delete(mod)
    }
    mod.importedModules = next

    mod.acceptedHmrDeps = new Set(
      [...acceptedUrls].map((url) => this.urlToModule.get(url)).filter((m): m is ModuleNode => !!m),
    )
  }

  /**
   * A file changed: drop the cached transform of the module and of every importer
   * between it and an HMR boundary, and stamp them with the update's timestamp.
   *
   * Example: format.js changes, message.js imports it, main.js accepts message.js.
   * When the client re-imports `/message.js?t=123`, message.js must be re-transformed
   * so its import of format.js becomes `/format.js?t=123`. Otherwise the browser
   * would hand back the old format.js instance.
   */
  invalidateModule(mod: ModuleNode, timestamp: number, seen = new Set<ModuleNode>()): void {
    if (seen.has(mod)) return
    seen.add(mod)
    mod.lastHMRTimestamp = timestamp
    mod.transformResult = null
    if (mod.isSelfAccepting) return
    for (const importer of mod.importers) {
      if (!importer.acceptedHmrDeps.has(mod)) this.invalidateModule(importer, timestamp, seen)
    }
  }

  /** JSON snapshot for the /__mini-vite/graph debug endpoint. */
  toJSON() {
    return [...this.urlToModule.values()].map((m) => ({
      url: m.url,
      file: m.file,
      imports: [...m.importedModules].map((d) => d.url),
      importers: [...m.importers].map((d) => d.url),
      acceptedHmrDeps: [...m.acceptedHmrDeps].map((d) => d.url),
      isSelfAccepting: m.isSelfAccepting,
      lastHMRTimestamp: m.lastHMRTimestamp,
      transformed: !!m.transformResult,
    }))
  }
}
