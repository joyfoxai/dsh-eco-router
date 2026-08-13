/**
 * dsh-eco-router — a token-efficient model-routing flywheel for the DeepSeek Harness.
 *
 * Captures OpenSquilla's core idea ("same budget, more capability"): route each
 * turn to the cheapest model tier that can handle it. The plugin observes every
 * turn's (task → model → result), distills a per-category routing table with
 * per-model error counts, persists it to `eco_router.json`, and registers an
 * `eco_route` tool that recommends the cheapest historically-successful model
 * tier for a given task. With `autoRoute` enabled it also overrides the routed
 * model at the `agent/request` waterfall.
 *
 * `tiers` / `autoRoute` are runtime-editable through the `dsh-eco-router`
 * settings namespace (base = the composition `config`, user layer = the UI).
 *
 * @module @joyfoxai/dsh-eco-router
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Module augmentations only: registers `ctx.agents`, `ctx.fs`, `ctx.tools`, `ctx.llm`,
// `ctx.settings`, and the scoped agent/tool events on the Cordis interfaces.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-eco-router'
export const inject = ['agents', 'fs', 'tools', 'settings', 'llm']

const SETTINGS_NS = settingsNamespace('dsh-eco-router')

/** Composition configuration (static defaults; `tiers`/`autoRoute` become the settings `base`). */
export interface Config {
  /** Absolute path to persist the distilled routing table. Defaults to `<session cwd>/eco_router.json`. */
  routerPath?: string
  /** Maximum characters of a user message kept for task classification. */
  maxTextChars?: number
  /** Ordered model ids, cheapest first. */
  tiers?: string[]
  /** When true, the `agent/request` waterfall overrides the routed model. */
  autoRoute?: boolean
}

/** Runtime schema for the composition config. */
export const Config: z<Config> = z.object({
  routerPath: z.string().default(''),
  maxTextChars: z.number().min(64).max(4000).default(500),
  tiers: z.array(z.string()).default(['deepseek-v4-flash', 'deepseek-v4-pro']),
  autoRoute: z.boolean().default(false),
})

/** Settings-namespace schema. `modelCatalog` is host-derived (read-only to the UI). */
const settingsSchema = z.object({
  tiers: z.array(z.string()).default(['deepseek-v4-flash', 'deepseek-v4-pro']),
  autoRoute: z.boolean().default(false),
  modelCatalog: z.array(z.object({
    provider: z.string().required(),
    id: z.string().required(),
    name: z.string(),
  })).default([]),
})

interface ModelCatalogEntry {
  provider: string
  id: string
  name: string
}

type Category = 'media' | 'code' | 'research' | 'documents' | 'comm' | 'general'

interface ModelStat {
  uses: number
  errors: number
}

interface CategoryStat {
  category: Category
  turns: number
  errors: number
  models: Record<string, ModelStat>
}

interface TurnRecord {
  turn: number
  category: Category
  text: string
  steps: { step: number; provider: string; model: string }[]
  tools: { name: string; isError: boolean }[]
  errors: number
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

/** Enumerate every model the mounted providers advertise, for the settings UI dropdown. */
async function enumerateModels(ctx: Context): Promise<ModelCatalogEntry[]> {
  try {
    const out: ModelCatalogEntry[] = []
    for (const provider of ctx.llm.listProviders()) {
      try {
        const models = await ctx.llm.listModels(provider.id)
        for (const model of models) out.push({ provider: model.provider, id: model.id, name: model.name })
      } catch { /* a provider that fails to list contributes nothing */ }
    }
    return out
  } catch {
    return []
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const maxTextChars = config.maxTextChars ?? 500

  const agent = ctx.agents.currentInitiator()
  if (agent === undefined) {
    throw new Error('dsh-eco-router: no initiating agent — mount this plugin inside an agent session')
  }
  const agentCtx = agent.ctx

  const cwd = agent.session.header.cwd
  const routerPath = (typeof config.routerPath === 'string' && config.routerPath.length > 0)
    ? config.routerPath
    : (typeof cwd === 'string' && cwd.length > 0
      ? `${cwd.replace(/\/+$/, '')}/eco_router.json`
      : `${process.cwd()}/eco_router.json`)

  // Settings: base = composition config; the user layer (UI) overrides tiers/autoRoute.
  const modelCatalog = await enumerateModels(ctx)
  let tiers = config.tiers ?? ['deepseek-v4-flash', 'deepseek-v4-pro']
  let autoRoute = config.autoRoute ?? false

  const scope = ctx.settings.register(SETTINGS_NS, settingsSchema, {
    base: { tiers, autoRoute, modelCatalog },
  })
  const applyResolved = (value: { tiers?: string[]; autoRoute?: boolean }): void => {
    tiers = value.tiers ?? tiers
    autoRoute = value.autoRoute ?? autoRoute
  }
  applyResolved(scope.get())
  ctx.effect(() => scope.watch((next) => { applyResolved(next) }))

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
        const model = step.model
        if (!model) continue
        let ms = stat.models[model]
        if (ms === undefined) ms = stat.models[model] = { uses: 0, errors: 0 }
        ms.uses++
      }
      if (record.errors > 0 && record.steps.length > 0) {
        const primary = record.steps[0]?.model
        if (primary) {
          let ms = stat.models[primary]
          if (ms === undefined) ms = stat.models[primary] = { uses: 0, errors: 0 }
          ms.errors += record.errors
        }
      }
    }
    categories = next
  }

  function recommendFor(category: Category): { model: string; reason: string } | null {
    const cheapest = tiers[0]
    if (cheapest === undefined) return null
    const stat = categories[category]
    if (stat === undefined) {
      return { model: cheapest, reason: 'cold start: no history, start cheapest' }
    }
    for (const model of tiers) {
      const info = stat.models[model]
      if (info && info.uses > 0 && info.errors === 0) {
        return { model, reason: 'cheapest tier with zero errors for this task type' }
      }
    }
    for (const model of tiers) {
      const info = stat.models[model]
      if (info !== undefined && info.errors > 0) continue
      return { model, reason: 'cheaper tier errored for this task type; escalate' }
    }
    return { model: tiers[tiers.length - 1] ?? cheapest, reason: 'all tiers errored; escalate to most capable' }
  }

  async function persist(): Promise<void> {
    distill()
    const data = { kind: 'dsh-eco-router', version: 1, turnCount: order.length, tiers, categories }
    try {
      const target = await ctx.fs.resolve(routerPath)
      await ctx.fs.writeText(target, JSON.stringify(data))
    } catch {
      // Best-effort: the flywheel stays in memory for the session even if the write fails.
    }
  }

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
    if (autoRoute && tiers.length > 1) {
      try {
        const recommendation = recommendFor(currentCategory)
        if (recommendation !== null && recommendation.model !== resolved.model) {
          return { ...resolved, model: recommendation.model }
        }
      } catch { /* routing is advisory; never break the request */ }
    }
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
    description: 'Recommend or inspect the dsh-eco-router routing decision. Given a task, return the cheapest historically-successful model tier (recommend), or dump the full learned routing table (list).',
    parameters: {
      task: { type: 'string', description: 'task text to classify and recommend a model for' },
      action: { type: 'string', description: 'recommend (default) or list' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      distill()
      if (args.action === 'list') {
        return JSON.stringify({ kind: 'dsh-eco-router', turnCount: order.length, tiers, categories }, null, 2)
      }
      const category = args.task ? classify(args.task) : 'general'
      const recommendation = recommendFor(category)
      return JSON.stringify({
        kind: 'dsh-eco-router',
        taskCategory: category,
        tiers,
        recommendation,
        categoryStat: categories[category] ?? null,
      }, null, 2)
    },
  }))
}
