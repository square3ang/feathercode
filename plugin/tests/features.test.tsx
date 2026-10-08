import { describe, expect, mock, test } from 'claude-code/testing'

import { cmd, START, world } from './hooks.test'

const ENGINE_SECTIONS = [
  { id: 'lean_body', text: 'You are...\nIMPORTANT: Assist with authorized security testing, the policy.\n# Harness', scope: 'shared' as const },
  { id: 'memory', text: '# Memory\n'.repeat(50), scope: 'session' as const },
  { id: 'other-mod:rules', text: 'Team rules', scope: 'session' as const },
]
const COMPOSE = { model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: [], tools: ['Bash', 'Edit', 'Read', 'Write'], outputStyle: null, traits: ['lean', 'print'] } as never

describe('system prompt', () => {
  test('replaces the engine sections with one shared OpenCode section, keeps other mods', async ($, on) => {
    world(on)
    on('prompt.compose', () => ({ sections: ENGINE_SECTIONS }))
    await $.session.start(START)
    const r = await $.prompt.compose(COMPOSE)
    const ids = r.sections.map(s => s.id)
    expect(ids).toEqual(['feathercode:system', 'other-mod:rules'])
    const sys = r.sections[0]!
    expect(sys.scope).toBe('shared')
    expect(sys.text).toContain('IMPORTANT: Assist with authorized security testing, the policy.')
    expect(sys.text).toContain('Use the Edit tool for targeted changes')
    expect(sys.text).toContain('# Code comments')
    expect(sys.text).not.toContain('OpenCode')
  })

  test('observe mode leaves the prompt alone', { options: { features: 'observe' } }, async ($, on) => {
    world(on)
    on('prompt.compose', () => ({ sections: ENGINE_SECTIONS }))
    await $.session.start(START)
    const r = await $.prompt.compose(COMPOSE)
    expect(r.sections.map(s => s.id)).toEqual(['lean_body', 'memory', 'other-mod:rules'])
  })

  test('drops the userEmail context block', async ($, on) => {
    world(on)
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    await $.session.start(START)
    const r = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'x' }, { name: 'userEmail', text: 'a@b' }, { name: 'currentDate', text: 'd' }] })
    expect(r.blocks.map(b => b.name)).toEqual(['claudeMd', 'currentDate'])
  })
})

describe('attachments', () => {
  test('drops todo / token reminders and git status, compacts skills', async ($, on) => {
    world(on)
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    await $.session.start(START)
    const todo = await $.prompt.attachment({ type: 'todo_reminder', text: 'todo', origin: { kind: 'engine' } } as never)
    expect(todo.text).toBeNull()
    const git = await $.prompt.attachment({
      type: 'session_context',
      text: "As you answer the user's questions, you can use the following context:\n# gitStatus\nbranch main\n\nClaude Code attached this context automatically; it isn't part of the user's message.",
      origin: { kind: 'engine' },
    } as never)
    expect(git.text).toBeNull()
    const skills = await $.prompt.attachment({
      type: 'skill_listing',
      text: 'The following skills are available:\n\n- pdf: Use this skill for PDFs. It also does many other long things.\n- a:b (scoped): Do X. Then Y.',
      origin: { kind: 'engine' },
    } as never)
    expect(skills.text).toBe('The following skills are available:\n\n- pdf: Use this skill for PDFs.\n- a:b (scoped): Do X.')
  })

  test("a settings hook's context passes untouched", async ($, on) => {
    world(on)
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    await $.session.start(START)
    const r = await $.prompt.attachment({ type: 'todo_reminder', text: 'mine', origin: { kind: 'hook', event: 'UserPromptSubmit' } } as never)
    expect(r.text).toBe('mine')
  })
})

describe('tools', () => {
  const engine = { plugin: 'engine', tier: 'core' } as never
  test('heavy tools are deferred, light ones get OpenCode descriptions', async ($, on) => {
    world(on)
    on('tool.describe', ($, e) => ({ description: e.description, ...(e.isDeferred ? { isDeferred: true } : {}) }))
    await $.session.start(START)
    const wf = await $.tool.describe({ tool: 'Workflow', description: 'x'.repeat(3000), provider: engine })
    expect(wf.isDeferred).toBe(true)
    const bash = await $.tool.describe({ tool: 'Bash', description: 'long', provider: engine })
    expect(bash.isDeferred).toBeUndefined()
    expect(bash.description).toContain('Execute a bash command')
    const mcp = await $.tool.describe({ tool: 'mcp__x__y', description: 'mine', provider: { plugin: 'mcp:x', tier: 'user' } as never })
    expect(mcp.description).toBe('mine')
  })
})

describe('build / plan', () => {
  test('/plan denies edits outside the plan dir, appends the reminder once, /build lifts it', async ($, on) => {
    world(on)
    const session = mock.session(on)
    on('tool.check', () => ({ decision: 'allow' }))
    await $.session.start(START)
    const out = await $.command.run(cmd('plan'))
    expect(out.text).toContain('Plan mode')
    const denied = await $.tool.check({ tool: 'Edit', input: { file_path: '/work/a.py', old_string: 'a', new_string: 'b' } })
    expect(denied.decision).toBe('deny')
    expect(denied.reason).toContain('/work/.opencode/plan')
    const inPlan = await $.tool.check({ tool: 'Write', input: { file_path: '/work/.opencode/plan/p.md', content: '' } })
    expect(inPlan.decision).toBe('allow')
    const sneaky = await $.tool.check({ tool: 'Write', input: { file_path: '/work/.opencode/plan/../../x', content: '' } })
    expect(sneaky.decision).toBe('deny')
    const bash = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    expect(bash.decision).toBe('allow')
    expect((await $.command.run(cmd('plan'))).text).toContain('Already')
    await $.command.run(cmd('build'))
    const ok = await $.tool.check({ tool: 'Edit', input: { file_path: '/work/a.py', old_string: 'a', new_string: 'b' } })
    expect(ok.decision).toBe('allow')
    const texts = session.appended().map(r => JSON.stringify(r.message.content))
    expect(texts.length).toBe(2)
    expect(texts[0]).toContain('You are in Plan mode')
    expect(texts[1]).toContain('NO LONGER in Plan mode')
  })

  test("the hook never turns the engine's deny or ask into an allow", async ($, on) => {
    world(on)
    mock.session(on)
    on('tool.check', ($, e) => (e.tool === 'Bash' ? { decision: 'deny', reason: 'settings rule' } : { decision: 'ask' }))
    await $.session.start(START)
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf x' } })).decision).toBe('deny')
    expect((await $.tool.check({ tool: 'Edit', input: { file_path: '/work/a', old_string: 'a', new_string: 'b' } })).decision).toBe('ask')
    await $.command.run(cmd('plan'))
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf x' } })).decision).toBe('deny')
    const inPlan = await $.tool.check({ tool: 'Write', input: { file_path: '/work/.opencode/plan/p.md', content: '' } })
    expect(inPlan.decision).toBe('ask')
    const outside = await $.tool.check({ tool: 'NotebookEdit', input: { notebook_path: '/work/n.ipynb', new_source: '' } })
    expect(outside.decision).toBe('deny')
    const noPath = await $.tool.check({ tool: 'Edit', input: null })
    expect(noPath.decision).toBe('deny')
  })

  test('a resumed session gets its mode back', async ($, on) => {
    world(on, { 'mode:sess-1': 'plan' })
    mock.session(on)
    on('tool.check', () => ({ decision: 'allow' }))
    await $.session.start(START)
    const denied = await $.tool.check({ tool: 'Edit', input: { file_path: '/work/a.py', old_string: 'a', new_string: 'b' } })
    expect(denied.decision).toBe('deny')
  })

  test('the band shows plan mode and its button switches back', async ($, on) => {
    world(on)
    mock.session(on)
    await $.session.start(START)
    await $.command.run(cmd('plan'))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'feathercode',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never,
      })
      expect(await ui.find({ type: 'Text', text: /plan/ })).toBeDefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount({
      plugin: 'feathercode',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never,
    })
    await ui.press({ key: 'build' })
    const stats = await $.command.run(cmd('feathercode-stats'))
    expect(stats.text).toContain('mode: build')
    await ui.unmount()
  })
})

describe('agents', () => {
  test('registers explore/general and hides the built-ins they replace', async ($, on) => {
    world(on)
    const registered: string[] = []
    on('agent.register', ($, e) => {
      registered.push(e.name)
      return { value: { agent: `feathercode:${e.name}` } }
    })
    on('agent.offer', () => ({ isOffered: true }))
    await $.session.start(START)
    expect(registered).toEqual(['explore', 'general'])
    const engine = { plugin: 'engine', tier: 'core' } as never
    expect((await $.agent.offer({ agent: 'Explore', description: '', source: 'built-in', provider: engine })).isOffered).toBe(false)
    expect((await $.agent.offer({ agent: 'general-purpose', description: '', source: 'built-in', provider: engine })).isOffered).toBe(false)
    expect((await $.agent.offer({ agent: 'claude-code-guide', description: '', source: 'built-in', provider: engine })).isOffered).toBe(true)
  })
})

describe('compaction', () => {
  const msgs = (n: number) => {
    const out: { role: 'user' | 'assistant'; text: string; toolUses: never[]; handle: string }[] = []
    for (let i = 0; i < n; i++) {
      out.push({ role: 'user', text: `prompt ${i} ` + 'p'.repeat(8000), toolUses: [], handle: `u${i}` })
      out.push({ role: 'assistant', text: `answer ${i} ` + 'a'.repeat(8000), toolUses: [], handle: `a${i}` })
    }
    return out
  }

  test('summarises with a fork and returns one checkpoint message', async ($, on) => {
    world(on)
    const prompts: string[] = []
    on('model.fork', ($, e) => {
      prompts.push(e.prompt)
      return { value: { isAnswered: true, text: '## Objective\n- finish', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 9, cache_creation_input_tokens: 0 } } }
    })
    await $.session.start(START)
    const r = await $.session.compact({ trigger: 'manual', messages: msgs(10) } as never)
    expect(r.messages?.length).toBe(1)
    const text = r.messages![0]!.text
    expect(text.startsWith('<conversation-checkpoint>')).toBe(true)
    expect(text).toContain('## Objective\n- finish')
    expect(text).toContain('<recent-context>')
    expect(text).toContain('[User]: prompt 9')
    expect(r.messages![0]!.handle).toBeUndefined()
    expect(prompts[0]).toContain('You MUST summarize the conversation above')
  })

  test('nudges once when the template is missing; precompute is skipped', async ($, on) => {
    world(on)
    let calls = 0
    on('model.fork', () => {
      calls++
      const text = calls === 1 ? 'Here you go' : '## Objective\n- ok'
      return { value: { isAnswered: true, text, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
    })
    await $.session.start(START)
    const r = await $.session.compact({ trigger: 'manual', messages: msgs(5) } as never)
    expect(calls).toBe(2)
    expect(r.messages?.[0]?.text).toContain('- ok')
    const pre = await $.session.compact({ trigger: 'precompute', messages: msgs(5) } as never)
    expect(pre.skip).toBeDefined()
  })

  test('messages tail keeps the recent originals with their handles', { options: { compaction_tail: 'messages' } }, async ($, on) => {
    world(on)
    on('model.fork', () => ({ value: { isAnswered: true, text: '## Objective\n- x', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
    await $.session.start(START)
    const r = await $.session.compact({ trigger: 'manual', messages: msgs(10) } as never)
    const out = r.messages!
    expect(out[0]!.text).not.toContain('<recent-context>')
    expect(out.length).toBeGreaterThan(1)
    expect(out[1]!.handle?.startsWith('u')).toBe(true)
    expect(out.at(-1)!.handle).toBe('a9')
  })
})

describe('stats panel', () => {
  test('the pane draws the stats on terminal and desktop; headless falls back to text', async ($, on) => {
    world(on)
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'feathercode',
        surface,
        component: 'Pane',
        requestId: 'feathercode-stats',
        props: { title: 'feathercode', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: {} } as never,
      })
      expect(await ui.find({ type: 'Text', text: /feathercode stats/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /cache read/ })).toBeDefined()
      await ui.unmount()
    }
    const out = await $.command.run(cmd('feathercode-panel'))
    expect(out.text).toContain('feathercode stats')
  })
})
