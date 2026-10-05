#!/usr/bin/env node
// 回歸檢查：把每份真實經驗檔複製到暫存目錄，用 notes.mjs 做一次「加上再刪掉」的空變動，確認寫回後逐位元相同。
// 改 notes.mjs 或 lib.mjs 的解析／輸出後跑一次：node tools/notes-roundtrip.mjs
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { notesFiles, parseNotes } from './lib.mjs'

const tool = join(import.meta.dirname, 'notes.mjs')
const root = mkdtempSync(join(tmpdir(), 'notes-rt-'))
let bad = 0
for (const { dir, file } of notesFiles()) {
  const dest = join(root, 'projects', dir, 'memory')
  mkdirSync(dest, { recursive: true })
  copyFileSync(file, join(dest, 'ctx-handoff.md'))
  const first = parseNotes(readFileSync(file, 'utf8')).memory[0]
  if (!first) { console.log(`SKIP ${dir}（沒有記憶）`); continue }
  const key = first.split('\n')[0].slice(0, 40)
  const ops = join(root, `${dir}.json`)
  writeFileSync(ops, JSON.stringify([{ file: dir, mem: key, op: 'append', text: 'ZZ' }, { file: dir, mem: key, op: 'cut', cut: '。ZZ' }]))
  const r = spawnSync(process.execPath, [tool, 'apply', ops, '--write'], { env: { ...process.env, CLAUDE_CONFIG_DIR: root }, encoding: 'utf8' })
  const same = r.status === 0 && readFileSync(join(dest, 'ctx-handoff.md'), 'utf8') === readFileSync(file, 'utf8')
  if (!same) bad += 1
  console.log(`${same ? 'SAME' : 'DIFF'} ${dir}${r.status === 0 ? '' : `：${r.stderr.trim()}`}`)
}
process.exit(bad ? 1 : 0)
