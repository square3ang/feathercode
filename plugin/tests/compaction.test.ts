import { describe, expect, test } from 'claude-code/testing'

import {
  PRUNED,
  PRUNE_MINIMUM,
  applyPrune,
  buildPrompt,
  ceiling,
  checkpoint,
  hasTemplate,
  isCheckpoint,
  messageToText,
  planPrune,
  splitConversation,
  type Msg,
} from '../hooks/lib/compaction'

const user = (text: string, handle = `u-${text}`): Msg => ({ role: 'user', text, toolUses: [], handle })
const assistant = (text: string, tools: { id: string; tool?: string; out: string }[] = []): Msg => ({
  role: 'assistant',
  text,
  handle: `a-${text}`,
  toolUses: tools.map(t => ({ tool_use_id: t.id, tool: t.tool ?? 'Read', input: { file_path: `/x/${t.id}` }, text: t.out })),
})
const results = (tools: { id: string; out: string }[]): Msg => ({
  role: 'user',
  text: '',
  handle: `r-${tools[0]?.id}`,
  toolUses: [],
  toolResults: tools.map(t => ({ tool_use_id: t.id, text: t.out, isError: false })),
})

/** n exchanges: prompt, assistant with one tool call, its result, answer. */
function conversation(n: number, outChars = 400): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < n; i++) {
    const id = `t${i}`
    out.push(user(`prompt ${i}`), assistant(`working ${i}`, [{ id, out: 'x'.repeat(outChars) }]), results([{ id, out: 'x'.repeat(outChars) }]), assistant(`done ${i}`))
  }
  return out
}

describe('splitConversation', () => {
  test('keeps the newest exchanges within the budget, cut at a user prompt', async () => {
    const msgs = conversation(10, 4000) // ~1k tokens per exchange
    const split = splitConversation(msgs, 3_000)!
    expect(msgs[split.start]!.role).toBe('user')
    expect(msgs[split.start]!.text.startsWith('prompt ')).toBe(true)
    expect(split.start).toBeGreaterThan(0)
    expect(split.recent).toContain('[User]: prompt 9')
    expect(split.recent).not.toContain('[User]: prompt 0')
    expect(split.recent).toContain('[Assistant tool call]: Read(')
  })

  test('everything fitting keeps only the latest exchange', async () => {
    const msgs = conversation(3, 10)
    const split = splitConversation(msgs, 1_000_000)!
    expect(msgs[split.start]!.text).toBe('prompt 2')
  })

  test('a single exchange is summarised whole', async () => {
    const msgs = conversation(1, 10)
    const split = splitConversation(msgs, 1_000_000)!
    expect(split.start).toBe(msgs.length)
    expect(split.recent).toBe('')
  })

  test('tool results are truncated to 1250 chars in the recent text', async () => {
    const msgs = conversation(2, 5000)
    const text = messageToText(msgs[5]!)
    expect(text).toContain('[truncated]')
    expect(text.length).toBeLessThan(1500)
  })
})

describe('prompt and checkpoint', () => {
  test('first and update prompts', async () => {
    expect(buildPrompt(false)).toContain('You MUST summarize the conversation above')
    expect(buildPrompt(true)).toContain('Update the existing checkpoint')
    expect(buildPrompt(false, 'prompt 9')).toContain('beginning "prompt 9"')
    expect(buildPrompt(false, undefined, 'the API')).toContain('Additional focus requested by the user: the API')
  })

  test('checkpoint wraps summary and recent context', async () => {
    const c = checkpoint('## Objective\n- x', '[User]: hi')
    expect(c.startsWith('<conversation-checkpoint>')).toBe(true)
    expect(c).toContain('<summary>\n## Objective\n- x\n</summary>')
    expect(c).toContain('<recent-context>\n[User]: hi\n</recent-context>')
    expect(checkpoint('s', '')).not.toContain('<recent-context>')
    expect(isCheckpoint({ role: 'user', text: c, toolUses: [] })).toBe(true)
    expect(hasTemplate('## Objective\n- a')).toBe(true)
    expect(hasTemplate('Sure, here is a summary')).toBe(false)
  })

  test('ceiling is window - max(10%, 16k), or window - buffer', async () => {
    expect(ceiling(200_000)).toBe(180_000)
    expect(ceiling(1_000_000)).toBe(900_000)
    expect(ceiling(100_000)).toBe(84_000)
    expect(ceiling(200_000, 50_000)).toBe(150_000)
  })
})

describe('prune (v1, opt-in)', () => {
  test('clears outputs past the newest 40k tokens when it frees over 20k', async () => {
    const msgs = conversation(40, 8_000) // 2k tokens per result
    const plan = planPrune(msgs)
    expect(plan.tokens).toBeGreaterThan(PRUNE_MINIMUM)
    expect(plan.ids.has('t0')).toBe(true)
    expect(plan.ids.has('t39')).toBe(false)
    expect(plan.ids.has('t38')).toBe(false)
    const out = applyPrune(msgs, plan)
    const r0 = out.find(m => m.toolResults?.[0]?.tool_use_id === 't0')!
    expect(r0.toolResults![0]!.text).toBe(PRUNED)
    expect(r0.handle).toBeUndefined()
    const last = out.find(m => m.toolResults?.[0]?.tool_use_id === 't39')!
    expect(last.handle).toBe('r-t39')
  })

  test('does nothing under the minimum', async () => {
    expect(planPrune(conversation(10, 400)).ids.size).toBe(0)
  })

  test('skill output is protected and a cleared output stops the walk', async () => {
    const msgs = conversation(40, 8_000)
    msgs[2] = results([{ id: 't0', out: 'x'.repeat(8_000) }])
    msgs[1] = assistant('working 0', [{ id: 't0', tool: 'Skill', out: 'x' }])
    expect(planPrune(msgs).ids.has('t0')).toBe(false)
    const once = applyPrune(msgs, planPrune(msgs))
    expect(planPrune(once).ids.size).toBe(0)
  })
})
