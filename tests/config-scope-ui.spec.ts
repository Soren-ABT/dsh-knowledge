/**
 * Issue #59 config-scope UI. The panel must let a user see/edit the global
 * retrieval defaults next to a base's overrides, expose the search mode, and
 * keep the vector similarity threshold visible even when reranking is off.
 */
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/knowledge/config.js'
import { accentSoft, C, style } from '../src/ui/client/theme.js'

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } }
const compiled = new Map<string, string>()

beforeAll(async () => {
  const source = await readFile(new URL('../src/ui/client/rag-config.tsx', import.meta.url), 'utf8')
  compiled.set('rag-config', (await transform(source, { loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022' })).code)
})

/** Same lightweight React stand-in the issue #57 UI spec uses: callbacks and
 *  rendered elements are inspected without pulling the DSH shell into tests. */
function renderer(exportName: string, props: Record<string, unknown>) {
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
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    './api.js': { KnowledgeApi: class {} },
    './theme.js': { accentSoft, C, style },
    './icons.js': { IconRefresh: () => null },
    './ModelRuntimeStatus.js': { ModelRuntimeStatus: () => null },
  }
  runInNewContext(compiled.get('rag-config')!, {
    module,
    exports: module.exports,
    Date,
    require: (id: string) => {
      if (!(id in modules)) throw new Error(`Unexpected UI dependency ${id}`)
      return modules[id]
    },
    window: { setInterval: () => 1, clearInterval: () => {} },
  })
  return {
    render: (): Element => {
      cursor = 0
      const result = module.exports[exportName](props)
      if (!mounted) {
        mounted = true
        for (const effect of effects) effect()
      }
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

function makeApi() {
  return {
    getModelSuggestions: vi.fn(async () => ({ embedding: [], local: [], rerank: [], ollamaEmbedding: [], ollamaVision: [] })),
    listLocalModels: vi.fn(async () => []),
    listOllamaModels: vi.fn(async () => ({ models: [] })),
    getLocalModelStatus: vi.fn(async () => ({ model: '', status: 'ready', progress: 100, message: '', runtimeState: 'unloaded' })),
    updateBase: vi.fn(async () => ({})),
    setConfig: vi.fn(async () => config()),
    probeEmbeddingDimensions: vi.fn(async () => 3),
    checkProcessor: vi.fn(async () => ({ version: 'test', tiers: [] })),
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return { ...Config({} as Config), ...overrides }
}

function baseProps(baseConfig: Record<string, unknown> = {}, api = makeApi(), globalOverrides: Record<string, unknown> = {}) {
  return {
    base: { id: 'wiki', name: 'Wiki', documentCount: 2, config: baseConfig },
    globalConfig: config(globalOverrides),
    api,
    t,
    busy: false,
    onSaved: vi.fn(),
  }
}

const sectionTitles = (tree: Element): string[] => elements(tree)
  .map(element => element.props.title)
  .filter((title): title is string => typeof title === 'string')

describe('issue #59 config scope UI', () => {
  it('keeps the similarity threshold visible for vector search with reranking off', () => {
    const vector = renderer('RagConfigPanel', baseProps({ searchMode: 'vector', rerankModel: '', similarityThreshold: 0.5 })).render()
    expect(sectionTitles(vector)).toContain('threshold')

    const lexical = renderer('RagConfigPanel', baseProps({ searchMode: 'lexical', rerankModel: '' })).render()
    expect(sectionTitles(lexical)).not.toContain('threshold')
  })

  it('switches to global defaults and saves only the changed field through setConfig', async () => {
    const api = makeApi()
    const ui = renderer('RagConfigPanel', baseProps({ searchMode: 'vector', similarityThreshold: 0.5 }, api))
    ui.render()

    const globalTab = elements(ui.render()).find(element => element.type === 'button' && text(element) === 'scopeGlobal')!
    expect(globalTab).toBeDefined()
    ;(globalTab.props.onClick as () => void)()

    const scoped = ui.render()
    expect(text(scoped)).toContain('scopeGlobalHint')
    expect(text(scoped)).not.toContain('scopeBaseHint')

    const modeSelect = elements(scoped).find(element => element.type === 'select'
      && elements(element).some(child => child.type === 'option' && child.props.value === 'vector'))!
    expect(modeSelect).toBeDefined()
    ;(modeSelect.props.onChange as (event: unknown) => void)({ target: { value: 'vector' } })

    const changed = ui.render()
    const save = elements(changed).find(element => element.type === 'button' && text(element) === 'save')!
    await (save.props.onClick as () => Promise<void>)()

    expect(api.setConfig).toHaveBeenCalledExactlyOnceWith({ searchMode: 'vector' })
    expect(api.updateBase).not.toHaveBeenCalled()
  })

  it('keeps the base scope save path intact and shows the effective values', async () => {
    const api = makeApi()
    const ui = renderer('RagConfigPanel', baseProps({}, api, { embeddingProvider: 'local', embeddingModel: 'test/model' }))
    const tree = ui.render()
    expect(text(tree)).toContain('effectiveConfig')
    expect(text(tree)).toContain('scopeBaseHint')

    const token = elements(tree).find(element => element.type === 'button' && text(element) === '4')!
    expect(token).toBeDefined()
    ;(token.props.onClick as () => void)()
    const changed = ui.render()
    const save = elements(changed).find(element => element.type === 'button' && text(element) === 'save')!
    await (save.props.onClick as () => Promise<void>)()

    expect(api.updateBase).toHaveBeenCalledExactlyOnceWith('wiki', { config: { embeddingBatchSize: 4 } })
    expect(api.setConfig).not.toHaveBeenCalled()
  })

  it('keeps the effective summary on saved values until the parent refreshes', async () => {
    const api = makeApi()
    const props = baseProps({ searchMode: 'vector', similarityThreshold: 0.5 }, api)
    const ui = renderer('RagConfigPanel', props)
    const tree = ui.render()
    const modeSelect = elements(tree).find(element => element.type === 'select'
      && elements(element).some(child => child.type === 'option' && child.props.value === 'vector'))!
    ;(modeSelect.props.onChange as (event: unknown) => void)({ target: { value: 'lexical' } })

    const effectiveText = () => text(elements(ui.render()).find(element => element.type === 'div'
      && text(element).startsWith('effectiveConfig:')))
    expect(effectiveText()).toContain('modeVector')
    expect(api.updateBase).not.toHaveBeenCalled()
    const save = elements(ui.render()).find(element => element.type === 'button' && text(element) === 'save')!
    await (save.props.onClick as () => Promise<void>)()
    expect(effectiveText()).toContain('modeVector')
    props.base.config = { searchMode: 'lexical', similarityThreshold: 0.5 }
    expect(effectiveText()).toContain('modeLexical')
  })

  it('shows a rejected global model save without reporting success', async () => {
    const api = makeApi()
    api.setConfig.mockRejectedValueOnce(new Error('已有知识库需要重建'))
    const props = baseProps({}, api, { embeddingProvider: 'openai', embeddingModel: 'old-model' })
    const ui = renderer('RagConfigPanel', props)
    const globalTab = elements(ui.render()).find(element => element.type === 'button' && text(element) === 'scopeGlobal')!
    ;(globalTab.props.onClick as () => void)()
    const modelInput = elements(ui.render()).find(element => element.type === 'input' && element.props.value === 'old-model')!
    ;(modelInput.props.onChange as (event: unknown) => void)({ target: { value: 'new-model' } })
    const save = elements(ui.render()).find(element => element.type === 'button' && text(element) === 'save')!
    await (save.props.onClick as () => Promise<void>)()
    expect(api.probeEmbeddingDimensions).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(text(ui.render())).toContain('已有知识库需要重建'))
    expect(api.setConfig).toHaveBeenCalledExactlyOnceWith({ embeddingModel: 'new-model' })
    expect(props.onSaved).not.toHaveBeenCalled()
  })
})
