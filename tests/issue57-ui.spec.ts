import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/knowledge/config.js'
import { C, style } from '../src/ui/client/theme.js'

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } }
const compiled = new Map<string, string>()
beforeAll(async () => {
  await Promise.all(['rag-config', 'DirectorySyncControls', 'ModelRuntimeStatus'].map(async name => {
    const source = await readFile(new URL(`../src/ui/client/${name}.tsx`, import.meta.url), 'utf8')
    compiled.set(name, (await transform(source, { loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022' })).code)
  }))
})

/** Exercise the shipped controls and callbacks; the DSH shell supplies React. */
function renderer(name: string, exportName: string, props: Record<string, unknown>) {
  const states: unknown[] = []
  const effects: Array<() => unknown> = []
  let cursor = 0
  let mounted = false
  const react = {
    useState: (initial: unknown) => {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (next: unknown) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useEffect: (effect: () => unknown) => { if (!mounted) effects.push(effect) },
    useMemo: (factory: () => unknown) => factory(),
  }
  const jsx = (type: unknown, elementProps: Record<string, unknown>): Element => ({ type, props: elementProps })
  const module = { exports: {} as Record<string, (props: Record<string, unknown>) => Element> }
  const modules: Record<string, unknown> = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    './theme.js': { C, style }, './icons.js': { IconRefresh: () => null },
    './ModelRuntimeStatus.js': { ModelRuntimeStatus: () => null },
  }
  runInNewContext(compiled.get(name)!, { module, exports: module.exports, Date,
    require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected UI dependency ${id}`); return modules[id] },
    window: { setInterval: () => 1, clearInterval: () => {} },
  })
  return {
    render: (): Element => {
      cursor = 0
      const result = module.exports[exportName](props)
      if (!mounted) { mounted = true; for (const effect of effects) effect() }
      return result
    },
  }
}

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (value === null || typeof value !== 'object' || !('props' in value)) return []
  const element = value as Element
  return [element, ...elements(element.props.children)]
}
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(text).join('')
  return value !== null && typeof value === 'object' && 'props' in value ? text((value as Element).props.children) : ''
}
const t = (key: string) => key

describe('issue #57 management controls', () => {
  it('saves a batch preset without probing or rebuilding the model and restores the override', async () => {
    const config = { ...Config({} as Config), embeddingProvider: 'local', embeddingModel: 'test/model' }
    const api = {
      getModelSuggestions: vi.fn(async () => ({})), listLocalModels: vi.fn(async () => []),
      listOllamaModels: vi.fn(async () => ({ models: [] })),
      getLocalModelStatus: vi.fn(async () => ({ model: 'test/model', status: 'ready', progress: 100, message: '', runtimeState: 'unloaded' })),
      updateBase: vi.fn(async () => ({})), probeEmbeddingDimensions: vi.fn(),
    }
    const props = { base: { id: 'wiki', name: 'Wiki' }, globalConfig: config, api, t, busy: false, onSaved: vi.fn() }
    const ui = renderer('rag-config', 'RagConfigPanel', props)
    const first = ui.render()
    const preset = elements(first).find(element => element.type === 'button' && element.props.children === 4)!
    ;(preset.props.onClick as () => void)()
    const changed = ui.render()
    expect(elements(changed).find(element => element.props.id === 'embedding-batch-wiki')?.props.value).toBe(4)
    const save = elements(changed).find(element => element.type === 'button' && text(element).includes('save'))!
    await (save.props.onClick as () => Promise<void>)()
    expect(api.updateBase).toHaveBeenCalledExactlyOnceWith('wiki', { config: { embeddingBatchSize: 4 } })
    expect(api.probeEmbeddingDimensions).not.toHaveBeenCalled()
    const restored = renderer('rag-config', 'RagConfigPanel', { ...props, base: { ...props.base, config: { embeddingBatchSize: 4 } } }).render()
    expect(elements(restored).find(element => element.props.id === 'embedding-batch-wiki')?.props.value).toBe(4)
  })

  it('offers binding for uploaded folders and enables scheduled sync only for bound paths', () => {
    const onBind = vi.fn(), onScan = vi.fn(), onInterval = vi.fn()
    const props = { source: { sourceId: 's', kind: 'directory', text: 'published' }, busy: false, t, onBind, onScan, onInterval }
    const uploaded = renderer('DirectorySyncControls', 'DirectorySyncControls', props).render()
    expect(elements(uploaded).find(element => element.type === 'button' && text(element) === 'directoryRescan')?.props.disabled).toBe(true)
    expect(elements(uploaded).some(element => element.type === 'select')).toBe(false)
    const bind = elements(uploaded).find(element => element.type === 'button' && text(element) === 'directoryBind')!
    ;(bind.props.onClick as () => void)()
    expect(onBind).toHaveBeenCalledOnce()
    const bound = renderer('DirectorySyncControls', 'DirectorySyncControls', { ...props, source: { ...props.source, sourcePath: '/home/wiki/published', syncIntervalMinutes: 5 } }).render()
    const select = elements(bound).find(element => element.type === 'select')!
    expect(select.props.value).toBe(5)
    ;(select.props.onChange as (event: unknown) => void)({ target: { value: '15' } })
    expect(onInterval).toHaveBeenCalledExactlyOnceWith(15)
    const scan = elements(bound).find(element => element.type === 'button' && text(element) === 'directoryRescan')!
    ;(scan.props.onClick as () => void)()
    expect(onScan).toHaveBeenCalledOnce()
  })

  it('shows runtime residency independently of download readiness, with elapsed load time', () => {
    const loading = renderer('ModelRuntimeStatus', 'ModelRuntimeStatus', { model: { runtimeState: 'loading', loadStartedAt: Date.now() - 5000, message: '' }, t }).render()
    expect(text(loading)).toMatch(/modelRuntimeLoading.*5\.\ds/)
    expect(text(loading)).not.toContain('%')
    const unloaded = renderer('ModelRuntimeStatus', 'ModelRuntimeStatus', { model: { runtimeState: 'unloaded', message: '' }, t }).render()
    expect(text(unloaded)).toBe('modelRuntimeUnloaded')
    const loaded = renderer('ModelRuntimeStatus', 'ModelRuntimeStatus', { model: { runtimeState: 'loaded', loadDurationMs: 1234, message: '' }, t }).render()
    expect(text(loaded)).toBe('modelRuntimeLoaded · 1.2s')
  })
})
