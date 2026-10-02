import type { EngineInterface, Register, Timer } from 'claude-code'

const tag = '[ctx-handoff]'

// 在場 handoff：context 達 min(600k, 視窗 × 80%) 時產生 handoff → /clear → 送出
const THRESHOLD = 600_000
const WINDOW_RATIO = 0.8
// 1 小時快取：最後一次用到快取後 55 分鐘刷新，最多 3 次，第 4 次改產生離席 handoff
const IDLE_MS = 55 * 60_000
const MAX_REFRESH = 3
// 太小的 context 重建很便宜，不值得刷新或產生離席 handoff
const MIN_TOKENS = 30_000
const KEEP = 5

const HANDOFF_PROMPT = [
  '為接手這段工作的新對話寫一份 handoff，第一行寫「HANDOFF:」加一句話的目標，全文不超過 1500 字。',
  '依序寫：1. 目標 2. 目前狀態（已完成／進行中） 3. 已做的決定與理由 4. 相關檔案路徑與指令 5. 下一步 6. 待使用者回答的問題。',
  '只寫接手需要的事實，沒有的項目寫「無」，不要寒暄。',
].join('\n')

type Kind = 'present' | 'away' | 'manual'
type Saved = { at: number; sessionId: string; kind: Kind; tokens: number | null; text: string }
type Away = { handoff: string; held?: string }

const awayKey = (sessionId: string) => `away:${sessionId}`
const thresholdOf = (window: number) => Math.min(THRESHOLD, Math.floor(window * WINDOW_RATIO))

let idle: Timer | undefined
let refreshes = 0
let busy = false
// 背景 shell／workflow／monitor：id → 開始時間（子代理另由 $.agent.list() 查）
const background = new Map<string, number>()
const STALE_MS = 12 * 60 * 60_000
const BG_ID = /\b(?:task[ _-]?id|ID)\b["'\s:=]+([A-Za-z0-9_-]{6,})/i

async function runningWork($: EngineInterface) {
  const now = await $.clock.now()
  for (const [id, at] of background) if (now - at > STALE_MS) background.delete(id)
  const agents = (await $.agent.list()).filter(a => a.status === 'running').length
  return background.size + agents
}

async function isRefreshOn($: EngineInterface) {
  return (await $.store.get('refresh')) !== false
}

async function makeHandoff($: EngineInterface, kind: Kind, tokens: number | null) {
  const r = await $.model.fork({ prompt: HANDOFF_PROMPT })
  if (!r.isAnswered) {
    $.ui.log(`${tag} handoff 產生失敗：${r.reason}`)
    $.ui.toast(`${tag} handoff 產生失敗`)
    return undefined
  }
  const saved: Saved = { at: await $.clock.now(), sessionId: await $.session.id(), kind, tokens, text: r.text }
  const list = ((await $.store.get('handoffs')) as Saved[] | undefined) ?? []
  await $.store.set('handoffs', [...list, saved].slice(-KEEP))
  return r.text
}

// 產生 handoff → /clear → 把 handoff（和使用者留下的訊息）送進新對話
async function clearAndSubmit($: EngineInterface, intro: string, handoff: string) {
  await $.command.run({ command: 'clear' })
  await $.prompt.submit({ text: `${intro}\n\n${handoff}` })
}

function schedule($: EngineInterface) {
  idle?.cancel()
  idle = $.clock.after(IDLE_MS, () => void onIdle($))
}

async function onIdle($: EngineInterface) {
  idle = undefined
  if (busy) return
  const { context } = await $.session.usage()
  const tokens = context.tokens ?? 0
  if (tokens < MIN_TOKENS) return

  if ((await isRefreshOn($)) && refreshes < MAX_REFRESH) {
    const r = await $.model.fork({ prompt: '只回覆 OK' })
    refreshes += 1
    $.ui.log(r.isAnswered
      ? `${tag} 快取刷新 ${refreshes}/${MAX_REFRESH} cache_read=${r.usage.cache_read_input_tokens} cache_creation=${r.usage.cache_creation_input_tokens}`
      : `${tag} 快取刷新 ${refreshes}/${MAX_REFRESH} 失敗：${r.reason}`)
    schedule($)
    return
  }

  busy = true
  try {
    const handoff = await makeHandoff($, 'away', tokens)
    if (handoff === undefined) return
    await $.store.set(awayKey(await $.session.id()), { handoff } satisfies Away)
    $.ui.log(`${tag} 離席 handoff 已存好（${tokens} tokens），不會自動 /clear`)
    $.ui.toast(`${tag} 離席 handoff 已存好`)
  } finally {
    busy = false
  }
}

async function present($: EngineInterface, tokens: number | null, kind: Kind) {
  busy = true
  idle?.cancel()
  idle = undefined
  try {
    const handoff = await makeHandoff($, kind, tokens)
    if (handoff === undefined) return
    const why = kind === 'manual' ? '手動執行 /handoff-now' : `context 達 ${tokens} tokens`
    await clearAndSubmit($,
      `${tag} 上一段對話因${why}，已自動 /clear。以下是 handoff：請讀完後用幾行回報你理解的現況與下一步，然後等使用者指示，不要直接動手。`,
      handoff)
    refreshes = 0
  } catch (err) {
    $.ui.log(`${tag} /clear 或送出失敗：${String(err)}`)
  } finally {
    busy = false
  }
}

export const register: Register = on => {
  idle = undefined
  refreshes = 0
  busy = false
  background.clear()

  on('session.start', async ($, e, next) => {
    for (const [name, description] of [
      ['handoff-status', 'ctx-handoff: 顯示 context 用量、門檻、刷新與離席 handoff 狀態'],
      ['handoff-refresh', 'ctx-handoff: 開關閒置時的快取刷新（on / off）'],
      ['handoff-resume', 'ctx-handoff: 用離席 handoff 開新對話接續（會 /clear）'],
      ['handoff-continue', 'ctx-handoff: 放棄離席 handoff，在舊對話送出剛才被攔下的訊息'],
      ['handoff-now', 'ctx-handoff: 立刻產生 handoff 並 /clear；參數要打 yes'],
    ] as const) {
      await $.command.register({ name, description })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined || busy) return out
    // 每個回合都用到快取，TTL 從這裡重算
    schedule($)
    if (e.reason !== 'answer') return out
    const { context } = await $.session.usage()
    if (context.tokens === undefined || context.tokens < thresholdOf(context.window)) return out
    const tokens = context.tokens
    // 還有背景工作就先不 /clear：它結束時的通知會再跑一個回合，到時再判斷
    const running = await runningWork($)
    if (running > 0) {
      $.ui.status(`${tag} handoff 延後：${running} 個背景工作還在跑`)
      $.ui.log(`${tag} context ${tokens} 已達門檻，但有 ${running} 個背景工作，等它們結束再 handoff`)
      return out
    }
    $.ui.status(undefined)
    busy = true
    $.clock.after(0, () => void present($, tokens, 'present'))
    return out
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const at = await $.clock.now()
    if (e.tool === 'Bash') {
      const id = (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId
      if (id !== undefined) background.set(id, at)
    } else if (e.tool === 'Workflow' || e.tool === 'Monitor') {
      const id = BG_ID.exec(ran.text ?? '')?.[1]
      if (id !== undefined) background.set(id, at)
    } else if (e.tool === 'TaskStop') {
      if (e.task_id !== undefined) background.delete(e.task_id)
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      for (const id of background.keys()) if (e.text.includes(id)) background.delete(id)
    }
    const isHuman = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isHuman) return next(e)
    idle?.cancel()
    idle = undefined
    refreshes = 0

    const key = awayKey(await $.session.id())
    const away = (await $.store.get(key)) as Away | undefined
    if (away === undefined || e.text.trimStart().startsWith('/')) return next(e)
    if (away.held === undefined) {
      await $.store.set(key, { ...away, held: e.text } satisfies Away)
      return {
        drop: `${tag} 有一份離席 handoff，舊對話的快取已過期。` +
          '/handoff-resume：開新對話接續，並帶上這則訊息；/handoff-continue：在舊對話送出這則訊息（或直接再送一次）。',
      }
    }
    // 第二次直接送出＝選擇繼續舊對話
    await $.store.delete(key)
    return next(e)
  })

  on('command.run', { command: 'handoff-status' }, async $ => {
    const { context } = await $.session.usage()
    const away = (await $.store.get(awayKey(await $.session.id()))) as Away | undefined
    const list = ((await $.store.get('handoffs')) as Saved[] | undefined) ?? []
    const last = list.at(-1)
    return {
      text: [
        `${tag} context ${context.tokens ?? '?'} / 門檻 ${thresholdOf(context.window)}（視窗 ${context.window}）`,
        `快取刷新 ${(await isRefreshOn($)) ? 'on' : 'off'}，本次閒置已刷新 ${refreshes}/${MAX_REFRESH}，計時器${idle ? '等待中' : '未啟動'}`,
        `離席 handoff：${away ? (away.held === undefined ? '有' : '有（已攔下一則訊息）') : '無'}`,
        `最近一份 handoff：${last ? `${new Date(last.at).toLocaleString()} ${last.kind}` : '無'}`,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'handoff-refresh' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== 'on' && arg !== 'off') return { text: `${tag} 目前 ${(await isRefreshOn($)) ? 'on' : 'off'}；用法 /handoff-refresh on|off` }
    await $.store.set('refresh', arg === 'on')
    return { text: `${tag} 快取刷新已設為 ${arg}${arg === 'off' ? '（閒置 55 分鐘就直接產生離席 handoff）' : ''}` }
  })

  on('command.run', { command: 'handoff-resume' }, async $ => {
    const key = awayKey(await $.session.id())
    const away = (await $.store.get(key)) as Away | undefined
    if (away === undefined) return { text: `${tag} 沒有離席 handoff` }
    await $.store.delete(key)
    const intro = away.held === undefined
      ? `${tag} 上一段對話閒置後產生了 handoff，已開新對話接續。請讀完後用幾行回報你理解的現況與下一步，然後等使用者指示。`
      : `${tag} 上一段對話閒置後產生了 handoff，已開新對話接續。請依 handoff 的脈絡回應最後附上的使用者訊息。`
    const handoff = away.held === undefined ? away.handoff : `${away.handoff}\n\n---\n使用者回來後的第一則訊息：\n${away.held}`
    busy = true
    $.clock.after(0, () => {
      void clearAndSubmit($, intro, handoff)
        .catch(err => $.ui.log(`${tag} /clear 或送出失敗：${String(err)}`))
        .finally(() => { busy = false })
    })
    return { text: `${tag} 即將 /clear 並送出離席 handoff` }
  })

  on('command.run', { command: 'handoff-continue' }, async $ => {
    const key = awayKey(await $.session.id())
    const away = (await $.store.get(key)) as Away | undefined
    if (away === undefined) return { text: `${tag} 沒有離席 handoff` }
    await $.store.delete(key)
    const held = away.held
    if (held === undefined) return { text: `${tag} 已捨棄離席 handoff，繼續舊對話` }
    $.clock.after(0, () => void $.prompt.submit({ text: held }))
    return { text: `${tag} 已捨棄離席 handoff，在舊對話送出剛才的訊息` }
  })

  on('command.run', { command: 'handoff-now' }, async ($, e) => {
    if (e.args.trim() !== 'yes') return { text: `${tag} 會清掉目前對話；確定請打 /handoff-now yes` }
    if (busy) return { text: `${tag} 正在處理另一個 handoff` }
    const { context } = await $.session.usage()
    const tokens = context.tokens ?? null
    busy = true
    $.clock.after(0, () => void present($, tokens, 'manual'))
    return { text: `${tag} 正在產生 handoff，接著 /clear 再送出` }
  })
}
