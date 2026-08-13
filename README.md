# dsh-eco-router

Token-efficient model-routing flywheel for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Captures OpenSquilla's core idea — *"same budget, more capability"* — as a
self-improving routing loop: observe every turn's **(task → model → result)**,
distill a per-category routing table with per-model error counts, persist it to
`eco_router.json`, and expose an `eco_route` tool that routes each task to the
cheapest model tier that historically succeeded.

> 📖 [简体中文文档](README.zh.md)

## Verified

![verify](docs/verify.png)

Real build verification with two model tiers: after a `code` turn succeeds on
`deepseek-v4-flash` and a `media` turn fails on it, `eco_route` routes `code`
tasks to the cheap tier (`deepseek-v4-flash`) and escalates `media` tasks to the
capable tier (`deepseek-v4-pro`).

## What it does

| Stage | Implementation |
| --- | --- |
| Observe the **task** | `agent/inbox/claimed` → user-message text + a coarse category (`media` / `code` / `research` / `documents` / `comm` / `general`) |
| Observe the **model** | `agent/request` waterfall → the `{ provider, model }` routed for each step |
| Observe the **result** | `tools/result` (tool name + `isError`) and `agent/error` |
| Distill | aggregate per category into `{ turns, errors, models: { model: { uses, errors } } }` |
| Persist | write the table to `eco_router.json` at each turn close |
| Recommend | `eco_route` → the cheapest tier with zero errors for the task type |
| Route (opt-in) | `autoRoute: true` also overrides the routed model at `agent/request` |

All listeners are registered on the initiating **agent's scoped context**
(`agent.ctx.on(...)`), the same pattern the harness's own
`installModelSelection` uses, so they observe only this agent's traffic.

## Layout

```
dsh-eco-router/
├── src/index.ts           # the plugin: name / inject / Config / apply
├── preset/
│   ├── agent.cordis.yml   # sample composition row referencing this package
│   └── preset.yml         # preset display metadata
├── docs/verify.png        # real build-verification screenshot
├── package.json
├── tsconfig.json
├── tsdown.config.ts
└── README.zh.md           # 简体中文文档
```

## Prerequisites

> ⚠️ **Dependency status** — the `@deepseek-ai/*` packages this plugin depends
> on (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-agent`,
> `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools`) are
> **not yet published to npm**; they are `workspace:`-internal to the
> [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) monorepo.
> A plain `npm install` outside that repo will fail to resolve them.

To build today, either:

- **build inside the harness monorepo** — place this package under `packages/`
  (or vendor it as a workspace) so the `@deepseek-ai/*` deps resolve as
  workspace packages; or
- **wait for upstream** to publish `@deepseek-ai/*` to npm, then pin the
  `peerDependencies` versions and install normally.

## Build

```bash
npm install
npm run build          # tsdown → lib/index.js + lib/index.d.ts
```

`@deepseek-ai/dsh-*` packages are `peerDependencies`; install them alongside
this package (or build inside a DeepSeek Harness dev environment where they are
workspace packages).

## Mount (as a preset)

Copy this directory into your user preset root and mount it, or add one row to
your own composition:

```yaml
- id: dsh-eco-router
  name: '@joyfoxai/dsh-eco-router'
  config:
    tiers: [deepseek-v4-flash, deepseek-v4-pro]   # cheapest first
    autoRoute: false                               # true → override at agent/request
```

- `tiers` — ordered model ids, cheapest first. `eco_route` recommends the
  cheapest tier with no recorded errors for the task type.
- `autoRoute` — when `true`, the plugin also overrides the routed model at the
  `agent/request` waterfall, instead of only recommending it.

The plugin injects only host services (`agents`, `fs`, `tools`) and publishes
no service of its own, so the row sits loose — it needs no isolate realm.

## Open-sourcing / publishing

1. `npm publish` this package (scope `@joyfoxai`, `access: public`).
2. Users install it and reference it from their `agent.cordis.yml` by name.

The dynamic Cordis Plugin this was ported from (`cordis_define`) is
**process-local and not distributable**; this package is the shippable form.
