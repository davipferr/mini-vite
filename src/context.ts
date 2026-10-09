import type { HmrChannel } from './hmr.js'
import type { ModuleGraph } from './moduleGraph.js'
import type { DepOptimizer } from './optimizer.js'

/** Everything the request handlers and the HMR engine share. */
export interface ServerContext {
  root: string
  graph: ModuleGraph
  optimizer: DepOptimizer
  hmr: HmrChannel
  debug: boolean
}
