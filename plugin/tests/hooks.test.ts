import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/** The world beneath the plugin: env, session facts, an in-memory fs. */
export function world(on: On, env: Record<string, string> = {}) {
  const files = new Map<string, string>()
  mock.env(on, { HOME: '/home/u', FEATHERCODE_LOG_DIR: '/logs', ...env })
  mock.store(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.version', () => ({ value: { version: '2.1.293', base: '2.1.293', builtAt: '' } }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return files
}

test('logs each request and reports it in /feathercode-stats', async ($, on) => {
  const files = world(on, { FEATHERCODE_FEATURES: 'observe' })
  on('turn.step', async function* () {
    return {
      turnId: 't',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'm', input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/work' })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of stream) {
    // drain
  }
  await stream
  const out = await $.command.run({ command: 'feathercode-stats', args: '' })
  expect(out.text).toContain('requests 1')
  expect(out.text).toContain('cache read 100')
  expect(out.text).toContain('observe only')
  const log = files.get('/logs/sess-1.jsonl') ?? ''
  expect(log).toContain('"ev":"start"')
})
