// Entry module. Try editing each file and see what happens:
//
//   style.css        -> styles swap in place, no reload
//   counter.js       -> counter re-runs, keeps its count
//   message.js       -> only the message text changes (main.js accepts it)
//   utils/format.js  -> same: the update bubbles up through message.js to main.js
//   main.js (this)   -> full page reload. Nothing above main.js can accept it.

import './style.css'
import { message } from './message.js'
import './counter.js'

const messageEl = document.querySelector('#message')
messageEl.textContent = message

document.querySelector('#load-lazy').addEventListener('click', async () => {
  // Rewritten to import("/src/lazy.js"). It only joins the module graph once clicked.
  const { describe } = await import('./lazy.js')
  document.querySelector('#lazy-output').textContent = describe()
})

if (import.meta.hot) {
  // main.js is the HMR boundary for message.js: we get the new module and patch the DOM.
  // The server rewrites './message.js' to '/src/message.js' so the client can match it.
  import.meta.hot.accept('./message.js', (newModule) => {
    messageEl.textContent = newModule.message
  })
}
