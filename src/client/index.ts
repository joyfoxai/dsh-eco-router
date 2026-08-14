/**
 * dsh-eco-router — browser half: the settings card (Settings → Plugins) and the
 * bottom-right `auto`/`manual` mode switch beside the model selector.
 * @module @joyfoxai/dsh-eco-router/client
 */
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
// Type-only merges: ctx.slots (ui-slots), ctx.settingsScope (ui-settings),
// the 'settings.plugin.item' SlotMap entry (ui-settings-plugins),
// the 'conversation.input.right' SlotMap entry (ui-conversation),
// and the ctx.connection / ctx.remote merges.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

export const inject = ['slots', 'settingsScope', 'connection', 'remote']

const NS = 'dsh-eco-router'

interface Settings {
  tiers: string[]
  autoRoute: boolean
  mode: 'auto' | 'manual'
  modelCatalog: { provider: string; id: string; name: string }[]
}

export function apply(ctx: ClientContext): void {
  // Bind the settings scope ONCE at apply time (not inside the slot render
  // functions), so every render shares one stable scope and one subscription.
  const settingsScope = ctx.settingsScope.bind<Settings>({ namespace: NS })

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', id: 'dsh-eco-router', order: 100, label: 'dsh-eco-router' },
    () => createElement(EcoRouterCard, { scope: settingsScope }),
  ))

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
    { name: 'conversation.input.right', id: 'dsh-eco-router-mode', order: 100, label: 'dsh-eco-router' },
    () => createElement(EcoModeSwitch, { scope: settingsScope }),
  ))
}

function setMode(scope: SettingsScope<Settings>, mode: 'auto' | 'manual'): void {
  scope.set('mode', mode).catch((error) => {
    console.error('[dsh-eco-router] set mode failed:', error)
  })
}

function EcoModeSwitch({ scope }: { scope: SettingsScope<Settings> }) {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  const mode = snapshot.value?.mode ?? 'manual'
  const auto = mode === 'auto'
  const status = snapshot.status

  return createElement('button', {
    type: 'button',
    onClick: () => { setMode(scope, auto ? 'manual' : 'auto') },
    title: `mode=${mode} status=${status}`,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      borderRadius: 999,
      border: '1px solid',
      borderColor: auto ? '#2f7d4f' : '#5a5f66',
      background: auto ? '#16301f' : 'transparent',
      color: auto ? '#7ee2a0' : '#9aa0a6',
      fontSize: 12,
      cursor: 'pointer',
    },
  }, auto ? 'eco · auto' : 'eco · manual')
}

function EcoRouterCard({ scope }: { scope: SettingsScope<Settings> }) {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  const value = snapshot.value
  const autoRoute = value?.autoRoute ?? false
  const mode = value?.mode ?? 'manual'
  const tiers = value?.tiers ?? []
  const catalog = value?.modelCatalog ?? []

  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('input', {
        type: 'checkbox',
        checked: mode === 'auto',
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          setMode(scope, event.target.checked ? 'auto' : 'manual')
        },
      }),
      'auto 档（自动路由到最便宜的成功模型）',
    ),
    createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('input', {
        type: 'checkbox',
        checked: autoRoute,
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          scope.set('autoRoute', event.target.checked).catch((error) => {
            console.error('[dsh-eco-router] set autoRoute failed:', error)
          })
        },
      }),
      'autoRoute（旧版：在 agent/request 直接覆盖模型）',
    ),
    createElement('div', null,
      createElement('div', { style: { marginBottom: 4 } }, 'tiers（从上到下 = 从便宜到贵）'),
      createElement('select', {
        multiple: true,
        value: tiers,
        size: Math.max(catalog.length, 3),
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          const selected: string[] = []
          for (const option of event.target.selectedOptions) selected.push(option.value)
          scope.set('tiers', selected).catch((error) => {
            console.error('[dsh-eco-router] set tiers failed:', error)
          })
        },
        style: { width: '100%' },
      },
        catalog.map(model => createElement('option', { key: model.id, value: model.id }, `${model.id} (${model.name})`)),
      ),
    ),
  )
}
