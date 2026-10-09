import Counter from './Counter'
import { greet } from './greet'
import './App.css'

export default function App() {
  return (
    <main>
      <h1>{greet('React')}</h1>
      <p className="hint">
        Edit <code>src/App.jsx</code> or <code>src/Counter.jsx</code> and save.
      </p>
      <Counter />
    </main>
  )
}
