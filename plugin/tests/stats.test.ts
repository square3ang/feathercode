import { describe, expect, test } from 'claude-code/testing'

import { Stats, formatStats } from '../hooks/lib/stats'

const usage = (input: number, read: number, write: number) => ({
  input_tokens: input,
  output_tokens: 10,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})
const step = (index: number, extra: Record<string, unknown> = {}) => ({
  turnId: 't1',
  index,
  model: 'm',
  effort: 'medium' as const,
  messageCount: index * 2,
  ...extra,
})

describe('Stats', () => {
  test('a request that reads the previous prefix is no break', async () => {
    const s = new Stats()
    s.step(step(0), usage(2, 10_000, 5_000), 0, 1)
    const r = s.step(step(1), usage(2, 15_000, 300), 2, 3)
    expect(r.isBreak).toBe(false)
    expect(s.totals().breaks).toBe(0)
  })

  test('a shortfall is a break, with the events in between as causes', async () => {
    const s = new Stats()
    s.compose([{ id: 'a', scope: 'shared', text: 'x' }])
    s.step(step(0), usage(2, 10_000, 5_000), 0, 1)
    s.attachment('plan_mode', undefined, 300)
    s.toolCall('ToolSearch', undefined, { query: 'select:Monitor' })
    s.compose([{ id: 'a', scope: 'shared', text: 'y' }])
    const r = s.step(step(1), usage(2, 3_000, 12_000), 2, 3)
    expect(r.isBreak).toBe(true)
    expect(r.lost).toBe(12_002)
    expect(r.causes).toContain('attachment:plan_mode')
    expect(r.causes).toContain('ToolSearch(select:Monitor)')
    expect(r.causes).toContain('system prompt hash')
  })

  test('loops are tracked apart', async () => {
    const s = new Stats()
    s.step(step(0), usage(2, 20_000, 1_000), 0, 1)
    const sub = s.step(step(0, { agentId: 'sub1' }), usage(2, 0, 4_000), 2, 3)
    expect(sub.isBreak).toBe(false)
    const main = s.step(step(1), usage(2, 21_000, 100), 4, 5)
    expect(main.isBreak).toBe(false)
  })

  test('model change is named', async () => {
    const s = new Stats()
    s.step(step(0), usage(2, 20_000, 1_000), 0, 1)
    const r = s.step(step(1, { model: 'other' }), usage(2, 0, 22_000), 2, 3)
    expect(r.causes).toContain('model m→other')
  })

  test('compose reports only changes', async () => {
    const s = new Stats()
    expect(s.compose([{ id: 'a', scope: 'shared', text: 'x' }])).toBeDefined()
    expect(s.compose([{ id: 'a', scope: 'shared', text: 'x' }])).toBeUndefined()
    expect(s.sysChanges).toBe(0)
  })

  test('formatStats prints totals and hit ratio', async () => {
    const s = new Stats()
    s.step(step(0), usage(0, 50, 50), 0, 1)
    const text = formatStats(s, '/tmp/x.jsonl')
    expect(text).toContain('hit 50.0%')
    expect(text).toContain('log: /tmp/x.jsonl')
  })
})
