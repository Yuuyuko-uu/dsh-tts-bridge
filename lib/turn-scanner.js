// Incremental session polling. Keep unfinished turns between snapshots, but never
// replay the history already present when a session starts being watched.
export function createSessionTurnScanner({ onCompleted, onStart = () => {}, onError = () => {} }) {
  const sessions = new Map()

  return (targets) => {
    const active = new Set()
    for (const session of targets) {
      const id = String(session.id)
      const seq = Number(session.seq)
      active.add(id)
      let tracked = sessions.get(id)
      if (!tracked || seq < tracked.seq) {
        tracked = { seq, turns: new Map() }
        sessions.set(id, tracked)
        onStart(id, seq)
        continue
      }
      if (seq <= tracked.seq) continue

      let events
      try {
        events = session.snapshotEvents(tracked.seq)
      } catch (error) {
        onError(error, id)
        continue
      }
      tracked.seq = seq
      for (const event of events) {
        if (!event) continue
        const data = event.data || {}
        if (data.turn === undefined || data.turn === null) continue
        if (event.type === 'assistant/message') {
          const text = tracked.turns.get(data.turn) || []
          const blocks = data.message && data.message.content
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                text.push(block.text.trim())
              }
            }
          }
          tracked.turns.set(data.turn, text)
        } else if (event.type === 'turn/end') {
          const text = tracked.turns.get(data.turn)
          // Failed, interrupted and empty turns must release their buffers too.
          tracked.turns.delete(data.turn)
          if (data.reason && data.reason.kind === 'completed' && text && text.length) {
            onCompleted(text.join('\n\n'), id, data.turn)
          }
        }
      }
    }
    // Unwatched, archived or unloaded sessions start fresh if selected again.
    for (const id of sessions.keys()) {
      if (!active.has(id)) sessions.delete(id)
    }
  }
}
