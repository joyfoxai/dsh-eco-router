/**
 * dsh-eco-router — browser half: the `settings.plugin.item` card
 * (autoRoute toggle + tiers multi-select, sourced from the host `modelCatalog`).
 * @module @joyfoxai/dsh-eco-router/client
 */
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
// Type-only merges: ctx.slots (ui-slots), ctx.settingsScope (ui-settings),
// and the 'settings.plugin.item' SlotMap entry (ui-settings-plugins).
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

export const inject = ['slots', 'settingsScope']

const NS = 'dsh-eco-router'

interface Settings {
  tiers: string[]
  autoRoute: boolean
  modelCatalog: { provider: string; id: string; name: string }[]
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', id: 'dsh-eco-router', order: 100, label: 'dsh-eco-router' },
    () => createElement(EcoRouterCard, { scope: ctx.settingsScope.bind<Settings>({ namespace: NS }) }),
  ))
}

function EcoRouterCard({ scope }: { scope: SettingsScope<Settings> }) {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  const value = snapshot.value
  const autoRoute = value?.autoRoute ?? false
  const tiers = value?.tiers ?? []
  const catalog = value?.modelCatalog ?? []

  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('input', {
        type: 'checkbox',
        checked: autoRoute,
        onChange: () => { void scope.set('autoRoute', !autoRoute) },
      }),
      'autoRoute',
    ),
    createElement('div', null,
      createElement('div', { style: { marginBottom: 4 } }, 'tiers (top = cheapest)'),
      createElement('select', {
        multiple: true,
        value: tiers,
        size: Math.max(catalog.length, 3),
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          const selected: string[] = []
          for (const option of event.target.selectedOptions) selected.push(option.value)
          void scope.set('tiers', selected)
        },
        style: { width: '100%' },
      },
        catalog.map(model => createElement('option', { key: model.id, value: model.id }, `${model.id} (${model.name})`)),
      ),
    ),
  )
}
