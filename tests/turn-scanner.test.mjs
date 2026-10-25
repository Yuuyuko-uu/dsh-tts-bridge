import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionTurnScanner } from '../lib/turn-scanner.js'

const message = (turn, ...texts) => ({
  type: 'assistant/message',
  data: { turn, message: { content: texts.map((text) => ({ type: 'text', text })) } },
})
const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })

function mockSession(id, history = []) {
  const events = [...history]
  return {
    id,
    get seq() { return events.length },
    snapshotEvents: (after) => events.slice(after),
    append: (...next) => events.push(...next),
    reset: (...next) => events.splice(0, events.length, ...next),
  }
}

function harness() {
  const queued = []
  const scan = createSessionTurnScanner({
    onCompleted: (text, sessionId, turn) => queued.push({ text, sessionId, turn }),
  })
  return { scan, queued }
}

test('assistant message survives until a later scan receives turn/end', () => {
  const { scan, queued } = harness()
  const session = mockSession('A')
  scan([session])
  session.append(message(1, ' hello '))
  scan([session])
  assert.deepEqual(queued, [])
  session.append(end(1))
  scan([session])
  assert.deepEqual(queued, [{ text: 'hello', sessionId: 'A', turn: 1 }])
})

test('same turn number in different sessions keeps independent text', () => {
  const { scan, queued } = harness()
  const a = mockSession('A')
  const b = mockSession('B')
  scan([a, b])
  a.append(message(1, 'from A'))
  b.append(message(1, 'from B'))
  scan([a, b])
  b.append(end(1))
  scan([a, b])
  a.append(end(1))
  scan([a, b])
  assert.deepEqual(queued, [
    { text: 'from B', sessionId: 'B', turn: 1 },
    { text: 'from A', sessionId: 'A', turn: 1 },
  ])
})

test('all text messages and blocks in a turn are collected across scans', () => {
  const { scan, queued } = harness()
  const session = mockSession('A')
  scan([session])
  session.append(message(1, 'first', 'second'))
  scan([session])
  session.append({ type: 'assistant/message', data: { turn: 1, message: { content: [
    { type: 'reasoning', text: 'private reasoning' },
    { type: 'image', text: 'image is not speech' },
    { type: 'text', text: '  ' },
    { type: 'text', text: 'third' },
  ] } } }, end(1))
  scan([session])
  assert.equal(queued[0].text, 'first\n\nsecond\n\nthird')
})

test('initial completed history and a partial historical turn are not replayed', () => {
  const { scan, queued } = harness()
  const session = mockSession('A', [message(1, 'old'), end(1), message(2, 'old partial')])
  scan([session])
  session.append(end(2))
  scan([session])
  assert.deepEqual(queued, [])
  session.append(message(3, 'new'), end(3))
  scan([session])
  assert.deepEqual(queued, [{ text: 'new', sessionId: 'A', turn: 3 }])
})

test('completed turn queues once and releases text before repeated end events', () => {
  const { scan, queued } = harness()
  const session = mockSession('A')
  scan([session])
  session.append(message(1, 'one'), end(1), end(1))
  scan([session])
  scan([session])
  session.append(end(1))
  scan([session])
  assert.equal(queued.length, 1)
})

test('failed and interrupted ends clear buffers without queuing', () => {
  const { scan, queued } = harness()
  const session = mockSession('A')
  scan([session])
  session.append(message(1, 'failed'), message(2, 'interrupted'))
  scan([session])
  session.append(end(1, 'failed'), end(2, 'interrupted'))
  scan([session])
  session.append(end(1), end(2), end(3))
  scan([session])
  assert.deepEqual(queued, [])
  session.append(message(4, 'next'), end(4))
  scan([session])
  assert.deepEqual(queued, [{ text: 'next', sessionId: 'A', turn: 4 }])
})

test('unwatching releases unfinished text and rewatching baselines current history', () => {
  const { scan, queued } = harness()
  const session = mockSession('A')
  scan([session])
  session.append(message(1, 'discard me'))
  scan([session])
  scan([])
  session.append(end(1), message(2, 'while unwatched'), end(2))
  scan([session])
  session.append(end(1), end(2), message(3, 'after rewatch'), end(3))
  scan([session])
  assert.deepEqual(queued, [{ text: 'after rewatch', sessionId: 'A', turn: 3 }])
})

test('a reset session sequence drops stale buffers and establishes a new baseline', () => {
  const { scan, queued } = harness()
  const session = mockSession('A')
  scan([session])
  session.append(message(1, 'stale'), message(2, 'also stale'))
  scan([session])
  session.reset()
  scan([session])
  session.append(end(1), end(2), message(3, 'fresh'), end(3))
  scan([session])
  assert.deepEqual(queued, [{ text: 'fresh', sessionId: 'A', turn: 3 }])
})

test('snapshot errors leave the cursor unchanged so the next scan can retry', () => {
  const errors = []
  const queued = []
  const scan = createSessionTurnScanner({
    onCompleted: (text) => queued.push(text),
    onError: (error, id) => errors.push([error.message, id]),
  })
  const session = mockSession('A')
  scan([session])
  session.append(message(1, 'not lost'), end(1))
  const snapshot = session.snapshotEvents
  session.snapshotEvents = () => { throw new Error('temporary read failure') }
  scan([session])
  session.snapshotEvents = snapshot
  scan([session])
  assert.deepEqual(errors, [['temporary read failure', 'A']])
  assert.deepEqual(queued, ['not lost'])
})
