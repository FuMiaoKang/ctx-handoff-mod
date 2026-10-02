import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const usage = (tokens: number) =>
  ({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 })

// 引擎底下的世界：用量、fork、/clear、送出，全部記下來
const world = (on: On, tokens: number, window = 1_000_000, store: Record<string, unknown> = {}, agents: { id: string; status: string }[] = []) => {
  const forks: string[] = []
  const commands: string[] = []
  const submits: string[] = []
  const clock = mock.clock(on)
  mock.store(on, store)
  on('session.id', () => ({ value: 'S1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window }, rateLimits: [] } }))
  on('model.fork', (_$, e: { prompt: string }) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true as const, text: 'HANDOFF: 測試', usage: usage(tokens) } }
  })
  on('command.run', (_$, e: { command: string }) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('turn.complete', () => ({ text: '' }))
  on('agent.list', () => ({ value: agents.map(a => ({ ...a, description: '', type: 'general-purpose' })) }))
  on('tool.call', (_$, e: { tool: string }) => e.tool === 'Workflow'
    ? { result: {}, text: 'Workflow started in the background. Task ID: wf_abc123' }
    : { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg123456' } })
  on('prompt.submit', (_$, e: { text?: string }) => {
    submits.push(e.text ?? '')
    return { text: e.text ?? '' }
  })
  return { clock, forks, commands, submits }
}

const resume = ($: Engine) =>
  $.command.run({ command: 'handoff-resume', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const endTurn = ($: Engine) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

test('達 600k：產生 handoff → /clear → 送出', async ($, on) => {
  const w = world(on, 650_000)
  await endTurn($)
  await w.clock.advance(0)
  expect(w.forks.length).toBe(1)
  expect(w.commands).toEqual(['clear'])
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain('HANDOFF: 測試')
})

test('200k 視窗：門檻降為 160k', async ($, on) => {
  const w = world(on, 170_000, 200_000)
  await endTurn($)
  await w.clock.advance(0)
  expect(w.commands).toEqual(['clear'])
})

test('門檻以下閒置：刷新 3 次後存離席 handoff，不 /clear', async ($, on) => {
  const w = world(on, 100_000)
  await endTurn($)
  await w.clock.advance(0)
  expect(w.commands).toEqual([])
  for (let i = 1; i <= 3; i++) {
    await w.clock.advance(55 * 60_000)
    expect(w.forks).toEqual(Array(i).fill('只回覆 OK'))
  }
  await w.clock.advance(55 * 60_000)
  expect(w.forks.length).toBe(4)
  expect(w.forks[3]).toContain('HANDOFF')
  expect(w.commands).toEqual([])
  expect(w.submits).toEqual([])
  // 之後不再排計時器
  await w.clock.advance(5 * 60 * 60_000)
  expect(w.forks.length).toBe(4)
  // 存下的離席 handoff 能用 /handoff-resume 取回
  await resume($)
  await w.clock.advance(0)
  expect(w.commands).toEqual(['clear'])
  expect(w.submits[0]).toContain('HANDOFF: 測試')
})

test('刷新關閉：閒置 55 分鐘直接存離席 handoff', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, { refresh: false })
  await endTurn($)
  await w.clock.advance(55 * 60_000)
  expect(w.forks.length).toBe(1)
  expect(w.forks[0]).toContain('HANDOFF')
})

test('context 太小：不刷新也不產生 handoff', async ($, on) => {
  const w = world(on, 10_000)
  await endTurn($)
  await w.clock.advance(5 * 60 * 60_000)
  expect(w.forks).toEqual([])
})

test('handoff-resume：/clear 後送出 handoff 和被攔下的訊息', async ($, on) => {
  const w = world(on, 100_000, 1_000_000, { 'away:S1': { handoff: 'HANDOFF: 測試', held: '我回來了' } })
  await resume($)
  await w.clock.advance(0)
  expect(w.commands).toContain('clear')
  expect(w.submits[0]).toContain('HANDOFF: 測試')
  expect(w.submits[0]).toContain('我回來了')
  // 用過就刪：再跑一次不會再 /clear
  await resume($)
  await w.clock.advance(0)
  expect(w.commands).toEqual(['clear'])
})

test('背景 shell 還在跑：延後 handoff，通知到了再做', async ($, on) => {
  const w = world(on, 650_000)
  await $.tool.call({ tool: 'Bash', command: 'sleep 999', run_in_background: true })
  await endTurn($)
  await w.clock.advance(0)
  expect(w.commands).toEqual([])
  // 背景工作結束的通知會帶 task id，並觸發下一個回合
  await $.prompt.submit({ text: '<task-notification> bg123456 completed', origin: { kind: 'task-notification' }, wait: false })
  await endTurn($)
  await w.clock.advance(0)
  expect(w.commands).toEqual(['clear'])
})

test('子代理還在跑：延後 handoff', async ($, on) => {
  const w = world(on, 650_000, 1_000_000, {}, [{ id: 'a1', status: 'running' }])
  await endTurn($)
  await w.clock.advance(0)
  expect(w.commands).toEqual([])
})

test('背景 Workflow：從輸出抓到 task id，延後到通知再做', async ($, on) => {
  const w = world(on, 650_000)
  await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' })
  await endTurn($)
  await w.clock.advance(0)
  expect(w.commands).toEqual([])
  await $.prompt.submit({ text: '<task-notification> wf_abc123 completed', origin: { kind: 'task-notification' }, wait: false })
  await endTurn($)
  await w.clock.advance(0)
  expect(w.commands).toEqual(['clear'])
})
