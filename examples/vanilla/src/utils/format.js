// Not accepted by anyone directly. A change here propagates up:
// format.js -> message.js -> main.js (which accepts message.js).
export function shout(text) {
  return text.toUpperCase() + '!'
}
