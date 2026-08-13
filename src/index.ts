/**
 * dsh-eco-router — a token-efficient model-routing flywheel for the DeepSeek Harness.
 *
 * Captures OpenSquilla's core idea ("same budget, more capability"): route each
 * turn to the cheapest model that can handle it. This plugin observes every
 * turn's (task → model → result), distills a per-category routing table,
 * persists it to `eco_router.json`, and registers an `eco_route` tool that
 * recommends the cheapest historically-successful model for a given task.
 *
 * @module @joyfoxai/dsh-eco-router
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Module augmentations only: registers `ctx.agents`, `ctx.fs`, `ctx.tools`, and
// the scoped agent/tool events on the Cordis Context and Events interfaces.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'dsh-eco-router'
export const inject = ['agents', 'fs', 'tools']

/** Configuration for the eco-router flywheel. */
export interface Config {
  /** Absolute path to persist the distilled routing table. Defaults to `<session cwd>/eco_router.json`. */
  routerPath?: string
  /** Maximum characters of a user message kept for task classification. */
  maxTextChars?: number
}

/** Runtime configuration schema for the plugin. */
export const Config: z<Config> = z.object({
  routerPath: z.string().optional(),
  maxTextChars: z.number().int().min(64).max(4000).default(500),
})

type Category = 'media' | 'code' | 'research' | 'documents' | 'comm' | 'general'

interface TurnRecord {
  turn: number
  category: Category
  text: string
  steps: { step: number; provider: string; model: string }[]
  tools: { name: string; isError: boolean }[]
  errors: number
}

interface CategoryStat {
  category: Category
  turns: number
  errors: number
  models: Record<string, number>
}

/** Coarse task classifier — a cheap, dependency-free proxy for task type. */
function classify(text: string): Category {
  const t = text.toLowerCase()
  if (/(视频|video|mp4|ffmpeg|hyperframe|render|字幕|clip|动画|animation)/.test(t)) return 'media'
  if (/(代码|code|git|github|pr\b|bug|refactor|函数|编译|test|测试|repo|仓库|实现|implement)/.test(t)) return 'code'
  if (/(搜索|search|web|查|research|调研|资料|news|事实|fact)/.test(t)) return 'research'
  if (/(文档|docx?|pdf|pptx|xlsx|excel|word|表格|ppt|markdown|报告|report|论文|paper)/.test(t)) return 'documents'
  if (/(邮件|mail|飞书|lark|消息|通知|calendar|日程|会议|meeting|slack|telegram)/.test(t)) return 'comm'
  return 'general'
}

/** Extract plain text from a user message's text blocks. */
function textOf(message: { content: readonly ContentBlock[] }): string {
  let out = ''
  for (const block of message.content) {
    if (block.type === 'text') out += `${block.text} `
  }
  return out
}

export function apply(ctx: Context, config: Config = {}): void {
  const maxTextChars = config.maxTextChars ?? 500

  const agent = ctx.agents.currentInitiator()
  if (agent === undefined) {
    throw new Error('dsh-eco-router: no initiating agent — mount this plugin inside an agent session')
  }
  const agentCtx = agent.ctx

  const cwd = agent.session.header.cwd
  const routerPath = config.routerPath
    ?? (typeof cwd === 'string' && cwd.length > 0
      ? `${cwd.replace(/\/+$/, '')}/eco_router.json`
      : `${process.cwd()}/eco_router.json`)

  const byTurn: Record<number, TurnRecord> = {}
  const order: number[] = []
  let categories: Record<string, CategoryStat> = {}
  let currentTurn: number | null = null
  let currentCategory: Category = 'general'
  let currentText = ''

  function ensureTurn(turn: number): TurnRecord | undefined {
    if (!Number.isInteger(turn)) return undefined
    let record = byTurn[turn]
    if (record === undefined) {
      record = { turn, category: currentCategory, text: currentText.slice(0, 200), steps: [], tools: [], errors: 0 }
      byTurn[turn] = record
      order.push(turn)
    }
    return record
  }

  function distill(): void {
    const next: Record<string, CategoryStat> = {}
    for (const turn of order) {
      const record = byTurn[turn]
      if (record === undefined) continue
      const category = record.category
      let stat = next[category]
      if (stat === undefined) stat = next[category] = { category, turns: 0, errors: 0, models: {} }
      stat.turns++
      stat.errors += record.errors
      for (const step of record.steps) {
        if (step.model) stat.models[step.model] = (stat.models[step.model] ?? 0) + 1
      }
    }
    categories = next
  }

  async function persist(): Promise<void> {
    distill()
    const data = { kind: 'dsh-eco-router', version: 1, turnCount: order.length, categories }
    try {
      const target = await ctx.fs.resolve(routerPath)
      await ctx.fs.writeText(target, JSON.stringify(data))
    } catch {
      // Best-effort: the flywheel stays in memory for the session even if the write fails.
    }
  }

  // Scoped listeners on the initiating agent's context. These are registered on
  // a different fiber than this plugin's, so their disposers are collected and
  // tied back to this plugin's lifetime via ctx.effect.
  const disposers: (() => void)[] = []

  disposers.push(agentCtx.on('agent/inbox/claimed', (payload) => {
    try {
      const text = textOf(payload.message).slice(0, maxTextChars)
      if (text.trim().length === 0) return
      currentText = text
      currentCategory = classify(text)
      currentTurn = payload.turn
      ensureTurn(payload.turn)
    } catch { /* observer never breaks the loop */ }
  }))

  disposers.push(agentCtx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      currentTurn = payload.turn
      const record = ensureTurn(payload.turn)
      if (record !== undefined) {
        record.steps.push({ step: payload.step, provider: resolved.provider, model: resolved.model })
      }
    } catch { /* observer never breaks the loop */ }
    return resolved
  }))

  disposers.push(agentCtx.on('tools/result', (exec, result) => {
    try {
      if (currentTurn === null) return
      const record = byTurn[currentTurn]
      if (record === undefined) return
      const isError = result.isError
      record.tools.push({ name: exec.name, isError })
      if (isError) record.errors++
    } catch { /* observer never breaks the loop */ }
  }))

  disposers.push(agentCtx.on('agent/error', (payload) => {
    try {
      const record = ensureTurn(payload.turn)
      if (record !== undefined) record.errors++
    } catch { /* observer never breaks the loop */ }
  }))

  disposers.push(agentCtx.on('agent/turn-stopping', () => {
    void persist()
  }))

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  })

  ctx.tools.register(defineTool({
    name: 'eco_route',
    description: 'Query the dsh-eco-router flywheel: the learned table mapping task categories to the models that served them and their error counts, plus an optional recommendation for a given task. Use it before expensive work to route each task to the cheapest model that historically succeeded (token-efficient routing).',
    parameters: {
      task: { type: 'string', description: 'optional task text to classify and get a per-category recommendation for' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      distill()
      const out: Record<string, unknown> = {
        kind: 'dsh-eco-router',
        turnCount: order.length,
        categories,
      }
      if (args.task) {
        const category = classify(args.task)
        out.taskCategory = category
        out.recommendation = categories[category] ?? null
      }
      return JSON.stringify(out, null, 2)
    },
  }))
}
