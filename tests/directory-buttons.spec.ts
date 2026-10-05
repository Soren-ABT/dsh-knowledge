import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createDirectoryActions, type DirectoryActions } from '../src/ui/client/directory-actions.js'
import { C, accentSoft, style } from '../src/ui/client/theme.js'

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } }
type Component = (props: Record<string, unknown>) => Element
const compiled = new Map<string, string>()
const translate = (key: string) => key
const mineruPlaceholder: Component = () => ({ type: 'mineru-placeholder', props: {} })

beforeAll(async () => {
  await Promise.all(['LocalModelsSection.tsx', 'MineruDeploymentSection.tsx', 'index.tsx'].map(async file => {
    const source = await readFile(new URL(`../src/ui/client/${file}`, import.meta.url), 'utf8')
    compiled.set(file, (await transform(source, { loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022' })).code)
  }))
})

function load(file: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}): Record<string, unknown> {
  const module = { exports: {} }
  runInNewContext(compiled.get(file)!, {
    module,
    exports: module.exports,
    Error,
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected test module: ${name}`)
      return modules[name]
    },
    ...globals,
  }, { filename: file })
  return module.exports
}

/** Execute the production component and its actual JSX callbacks without adding
 * React/DOM dependencies. The shell supplies React in production; this harness
 * stores hook state and runs mount effects once, but does not emulate DOM layout
 * or React's lifecycle scheduling. Poll timers deliberately never fire. */
function renderer(file: string, props: Record<string, unknown>) {
  const states: unknown[] = []
  const refs: Array<{ current: unknown }> = []
  const effects: Array<() => unknown> = []
  let stateCursor = 0
  let refCursor = 0
  let mounting = true
  const react = {
    useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] {
      const index = stateCursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [states[index] as T, value => {
        states[index] = typeof value === 'function' ? (value as (previous: T) => T)(states[index] as T) : value
      }]
    },
    useRef(initial: unknown) {
      const index = refCursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    useEffect(effect: () => unknown) { if (mounting) effects.push(effect) },
    useCallback<T>(callback: T) { return callback },
    useId: () => 'directory-test',
  }
  const jsx = (type: unknown, elementProps: Element['props']): Element => ({ type, props: elementProps })
  const storage = new Map<string, string>()
  const window = {
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  }
  const exported = load(file, {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    './theme.js': { C, accentSoft, style },
    './icons.js': new Proxy({}, { get: () => () => null }),
    './MineruDeploymentSection.js': { MineruDeploymentSection: mineruPlaceholder },
  }, { window, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout })
  const component = exported[file.replace('.tsx', '')] as Component
  const render = (): Element => {
    stateCursor = 0
    refCursor = 0
    const tree = component(props)
    if (mounting) {
      mounting = false
      for (const effect of effects) effect()
    }
    return tree
  }
  return { render, storage }
}

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (typeof value !== 'object' || value === null || !('props' in value)) return []
  const element = value as Element
  return [element, ...elements(element.props.children)]
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(text).join('')
  if (typeof value === 'object' && value !== null && 'props' in value) return text((value as Element).props.children)
  return ''
}

function button(tree: Element, label: string, index = 0): Element {
  const found = elements(tree).filter(element => element.type === 'button' && text(element).includes(label))[index]
  expect(found, `button ${label} #${index}`).toBeDefined()
  return found
}

function input(tree: Element, predicate: (element: Element) => boolean): Element {
  const found = elements(tree).find(element => element.type === 'input' && predicate(element))
  expect(found, 'input field').toBeDefined()
  return found!
}

const cacheInput = (tree: Element) => input(tree, element => String(element.props.placeholder).includes('local-models'))
function change(element: Element, value: string): void {
  (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } })
}
async function settle(): Promise<void> { for (let count = 0; count < 10; count++) await Promise.resolve() }
async function click(element: Element): Promise<void> {
  expect(element.props.disabled).not.toBe(true)
  ;(element.props.onClick as () => void)()
  await settle()
}

function apiFixture(cacheDir = 'C:\\old-cache') {
  return {
    listLocalModels: vi.fn(async () => []),
    getOcrStatus: vi.fn(async () => ({ status: 'idle', progress: 0, message: '' })),
    getConfig: vi.fn(async () => ({ hfEndpoint: '', localModelCacheDir: cacheDir, localWorkerIdleTimeoutMs: 60_000, mineruPythonIndexUrl: 'https://pypi.org/simple' })),
    getModelSuggestions: vi.fn(async () => ({ ollamaEmbedding: [], ollamaVision: [] })),
    listOllamaModels: vi.fn(async () => ({ models: [] })),
    listActiveOllamaPulls: vi.fn(async () => ({ pulls: [] })),
    mineruDeploymentStatus: vi.fn(async () => ({ active: false, phase: 'absent', service: 'stopped' })),
    prepareLocalModelCacheDirectory: vi.fn(async () => ({ path: 'C:\\resolved-cache' })),
    setConfig: vi.fn(async () => ({})),
    migrateLocalModels: vi.fn(),
  }
}

async function localFixture(directoryActions?: DirectoryActions, api = apiFixture()) {
  const panel = renderer('LocalModelsSection.tsx', { api, t: translate, close: () => {}, directoryActions })
  panel.render()
  await settle()
  return { panel, api }
}

describe('directory button callbacks (#42)', () => {
  it('picks a cache path through the DSH 0.2 service without saving or migrating files', async () => {
    const picker = vi.fn(async () => 'D:\\new-cache')
    const actions = createDirectoryActions({ uiWorkspace: { pickDirectory: picker }, workspaces: {} })
    const { panel, api } = await localFixture(actions)

    await click(button(panel.render(), 'cacheDirBrowse'))
    expect(cacheInput(panel.render()).props.value).toBe('D:\\new-cache')
    expect(api.setConfig).not.toHaveBeenCalled()
    expect(api.migrateLocalModels).not.toHaveBeenCalled()
    expect(api.prepareLocalModelCacheDirectory).not.toHaveBeenCalled()
    const mineru = elements(panel.render()).find(element => element.type === mineruPlaceholder)
    await expect((mineru?.props.pickDirectory as () => Promise<string | null>)()).resolves.toBe('D:\\new-cache')
    expect(picker).toHaveBeenCalledTimes(2)
  })

  it('retains the cache path after picker cancellation and displays picker errors', async () => {
    const pickDirectory = vi.fn(async (): Promise<string | null> => null)
    const { panel } = await localFixture({ pickDirectory })
    await click(button(panel.render(), 'cacheDirBrowse'))
    expect(cacheInput(panel.render()).props.value).toBe('C:\\old-cache')

    pickDirectory.mockRejectedValueOnce(new Error('dialog permission denied'))
    await click(button(panel.render(), 'cacheDirBrowse'))
    expect(text(panel.render())).toContain('dialog permission denied')
    expect(cacheInput(panel.render()).props.value).toBe('C:\\old-cache')
  })

  it('prepares the resolved cache directory before opening it without persisting the draft', async () => {
    const openPath = vi.fn(async () => {})
    const canOpenPath = vi.fn(async () => true)
    const { panel, api } = await localFixture({ openPath, canOpenPath }, apiFixture(''))
    await click(button(panel.render(), 'cacheDirOpen'))

    expect(api.prepareLocalModelCacheDirectory).toHaveBeenCalledExactlyOnceWith('')
    expect(openPath).toHaveBeenCalledExactlyOnceWith('C:\\resolved-cache')
    expect(api.prepareLocalModelCacheDirectory.mock.invocationCallOrder[0]).toBeLessThan(openPath.mock.invocationCallOrder[0])
    expect(cacheInput(panel.render()).props.value).toBe('')
    expect(api.setConfig).not.toHaveBeenCalled()
    expect(api.migrateLocalModels).not.toHaveBeenCalled()

    change(cacheInput(panel.render()), '  D:\\draft-cache  ')
    await click(button(panel.render(), 'cacheDirOpen'))
    expect(api.prepareLocalModelCacheDirectory).toHaveBeenLastCalledWith('D:\\draft-cache')
    expect(canOpenPath).toHaveBeenCalledTimes(2)
  })

  it('reports independent missing capabilities while keeping manual cache entry available', async () => {
    const { panel, api } = await localFixture(createDirectoryActions({ workspaces: {} }))
    await click(button(panel.render(), 'cacheDirBrowse'))
    expect(text(panel.render())).toContain('cacheDirPickUnavailable')
    await click(button(panel.render(), 'cacheDirOpen'))
    expect(text(panel.render())).toContain('cacheDirOpenUnavailable')
    change(cacheInput(panel.render()), 'D:\\manual')
    expect(cacheInput(panel.render()).props.value).toBe('D:\\manual')
    expect(api.prepareLocalModelCacheDirectory).not.toHaveBeenCalled()
    const mineru = elements(panel.render()).find(element => element.type === mineruPlaceholder)
    expect(mineru?.props.pickDirectory).toBeUndefined()
  })

  it('does not prepare or open a cache directory when the host cannot open paths', async () => {
    const openPath = vi.fn(async () => {})
    const { panel, api } = await localFixture({ openPath, canOpenPath: async () => false })
    await click(button(panel.render(), 'cacheDirOpen'))
    expect(text(panel.render())).toContain('cacheDirOpenUnavailable')
    expect(openPath).not.toHaveBeenCalled()
    expect(api.prepareLocalModelCacheDirectory).not.toHaveBeenCalled()
  })

  it('displays preparation and opener errors in the panel', async () => {
    const openPath = vi.fn(async () => {})
    const { panel, api } = await localFixture({ openPath })
    api.prepareLocalModelCacheDirectory.mockRejectedValueOnce(new Error('directory cannot be created'))
    await click(button(panel.render(), 'cacheDirOpen'))
    expect(text(panel.render())).toContain('directory cannot be created')
    expect(openPath).not.toHaveBeenCalled()

    openPath.mockRejectedValueOnce(new Error('shell refused directory'))
    await click(button(panel.render(), 'cacheDirOpen'))
    expect(text(panel.render())).toContain('shell refused directory')
  })

  it('uses the shared picker for both MinerU paths, preserves cancellation, and reports failures', async () => {
    const pickDirectory = vi.fn(async (): Promise<string | null> => 'D:\\mineru-install')
    const panel = renderer('MineruDeploymentSection.tsx', { api: apiFixture(), t: translate, pickDirectory })
    panel.render()
    await settle()
    await click(button(panel.render(), 'mineruDeployBrowse', 0))
    expect(input(panel.render(), element => String(element.props.id).endsWith('-root')).props.value).toBe('D:\\mineru-install')

    pickDirectory.mockResolvedValueOnce('D:\\existing-models')
    await click(button(panel.render(), 'mineruDeployBrowse', 1))
    expect(input(panel.render(), element => element.props['aria-label'] === 'mineruDeployExisting').props.value).toBe('D:\\existing-models')

    pickDirectory.mockResolvedValueOnce(null)
    await click(button(panel.render(), 'mineruDeployBrowse', 0))
    expect(input(panel.render(), element => String(element.props.id).endsWith('-root')).props.value).toBe('D:\\mineru-install')
    pickDirectory.mockRejectedValueOnce(new Error('MinerU picker failed'))
    await click(button(panel.render(), 'mineruDeployBrowse', 1))
    expect(elements(panel.render()).some(element => element.props.role === 'alert' && text(element).includes('MinerU picker failed'))).toBe(true)
  })

  it('keeps both MinerU paths editable without exposing an unavailable picker', async () => {
    const panel = renderer('MineruDeploymentSection.tsx', { api: apiFixture(), t: translate })
    panel.render()
    await settle()
    expect(elements(panel.render()).filter(element => element.type === 'button' && text(element).includes('mineruDeployBrowse'))).toHaveLength(0)
    change(input(panel.render(), element => String(element.props.id).endsWith('-root')), 'D:\\manual-install')
    change(input(panel.render(), element => element.props['aria-label'] === 'mineruDeployExisting'), 'D:\\manual-models')
    expect(input(panel.render(), element => String(element.props.id).endsWith('-root')).props.value).toBe('D:\\manual-install')
    expect(input(panel.render(), element => element.props['aria-label'] === 'mineruDeployExisting').props.value).toBe('D:\\manual-models')
  })
})

describe('directory action injection (#42)', () => {
  it('resolves current host services when the settings slot injects its props', async () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const nativePicker = { pick: vi.fn(async () => 'C:\\native') }
    const uiWorkspace = { pickDirectory: vi.fn(async () => 'C:\\ui') }
    const session = { openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })), canOpenWorkspacePath: vi.fn(async () => ({ ok: true, value: true })) }
    const services: Record<string, unknown> = {
      slots: { inject: (_name: string, callback: () => void) => callback(), register: (options: Record<string, unknown>, component: unknown) => registrations.push({ options, component }) },
      locale: { register: () => () => {}, bind: () => translate },
      workspaces: {},
    }
    const get = vi.fn((name: string) => services[name])
    const entry = load('index.tsx', {
      './api.js': { KnowledgeApi: class {} },
      './KnowledgeSection.js': { KnowledgePanel: () => null, SidebarKnowledgeAction: () => null },
      './LocalModelsSection.js': { LocalModelsSection: mineruPlaceholder },
      './locales.js': { en: {}, zh: {} },
      './panel-store.js': { createKnowledgePanelStore: () => ({}) },
      './directory-actions.js': { createDirectoryActions },
    }, { __DSH_DIRECTORY_PICKER__: nativePicker })
    ;(entry.apply as (ctx: unknown) => void)({ get, effect: (effect: () => unknown) => effect() })

    // Optional host services may appear after registration, before the user
    // enters the settings section. Injection must resolve them at that point.
    services.uiWorkspace = uiWorkspace
    services.remote = { session }
    const registration = registrations.find(item => item.options.id === 'local-models')!
    const props = (registration.options.inject as () => { directoryActions: DirectoryActions })()
    expect(registration.component).toBe(mineruPlaceholder)
    await expect(props.directoryActions.pickDirectory?.()).resolves.toBe('C:\\native')
    await expect(props.directoryActions.canOpenPath?.()).resolves.toBe(true)
    await props.directoryActions.openPath?.('C:\\absolute-cache')
    expect(session.openWorkspacePath).toHaveBeenCalledExactlyOnceWith({ path: 'C:\\absolute-cache' })
    expect(get).toHaveBeenCalledWith('uiWorkspace')
    expect(get).toHaveBeenCalledWith('remote')
    expect(uiWorkspace.pickDirectory).not.toHaveBeenCalled()
  })
})
