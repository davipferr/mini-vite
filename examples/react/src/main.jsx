// Two new problems compared to the vanilla app:
//
//   1. JSX. Browsers can't parse <App />, so esbuild compiles it to jsx(App, {})
//      (imported from "react/jsx-runtime") on every request.
//   2. Bare imports. "react-dom/client" isn't a URL. The optimizer pre-bundles it
//      and the import gets rewritten to "/@modules/react-dom_client.js".

import { createRoot } from 'react-dom/client'
import App from './App' // no extension: the resolver tries .js, .jsx, .ts...
import './index.css'

const root = createRoot(document.getElementById('root'))
root.render(<App />)

if (import.meta.hot) {
  // Re-render with the new App whenever App.jsx (or anything below it) changes.
  //
  // Notice that component state resets: the new App is a different function, so React
  // treats it as a different component and remounts the tree. Keeping state across
  // edits is what React Fast Refresh (react-refresh) does, and why Vite's React plugin exists.
  import.meta.hot.accept('./App', (newModule) => {
    root.render(<newModule.default />)
  })
}
