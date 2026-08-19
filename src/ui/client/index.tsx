/**
 * Browser half of the knowledge base: a Cherry Studio-style sidebar entry at
 * the sidebar foot (beside Settings) plus a frame-wide floating panel. The
 * panel lives OUTSIDE settings — it opens over the workspace, exactly like
 * Cherry Studio's top-level knowledge-base page.
 * @module dsh-knowledge/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { KnowledgeApi } from './api.js'
import { KnowledgePanel, SidebarKnowledgeAction } from './KnowledgeSection.js'
import type { Translate } from './KnowledgeSection.js'
import { LocalModelsSection } from './LocalModelsSection.js'
import { en, zh } from './locales.js'
import { createKnowledgePanelStore } from './panel-store.js'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.knowledge'

interface SlotsService {
  inject(name: string, callback: () => void): void
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface LocaleService {
  register(ns: string, dict: { zh: unknown; en: unknown }): () => void
  bind(ns: string): (key: string) => string
}

/** Required services; each target slot is awaited through `slots.inject`. */
export const inject = ['slots', 'locale']

/** Register the knowledge sidebar action and its overlay panel. */
export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as SlotsService | undefined
  const locale = ctx.get('locale') as LocaleService | undefined
  if (slots === undefined || locale === undefined) return

  ctx.effect(() => locale.register(NS, { zh, en }), 'ui-knowledge: dictionaries')
  const t = locale.bind(NS) as Translate
  const store = createKnowledgePanelStore()
  const api = new KnowledgeApi()

  slots.inject('sidebar.footer.action', () => slots.register({
    name: 'sidebar.footer.action',
    id: 'knowledge',
    order: 10,
    label: () => t('nav'),
    inject: () => ({ store, t }),
  }, SidebarKnowledgeAction))

  slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'knowledge',
    order: 10,
    inject: () => ({ store, api, t }),
  }, KnowledgePanel))

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'local-models',
    order: 60,
    label: () => t('localModelsNav'),
    inject: () => ({ api, t, workspaces: ctx.get('workspaces') }),
  }, LocalModelsSection))
}
