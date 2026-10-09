// A self-accepting module: it owns its piece of the DOM and re-runs itself on change.
// Change the label and save: the count survives because it travels through hot.data.

const button = document.querySelector('#counter')
const label = 'count is'

let count = import.meta.hot?.data.count ?? 0

function render() {
  button.textContent = `${label} ${count}`
}

function onClick() {
  count++
  render()
}

button.addEventListener('click', onClick)
render()

if (import.meta.hot) {
  import.meta.hot.accept()
  // Runs on the OLD instance right before the new one executes.
  import.meta.hot.dispose((data) => {
    data.count = count
    button.removeEventListener('click', onClick)
  })
}
