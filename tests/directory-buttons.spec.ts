import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
import { Context, Service } from '@deepseek-ai/cordis'
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
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

function clientEntry(globals: Record<string, unknown> = {}) {
  return load('index.tsx', {
    './api.js': { KnowledgeApi: class {} },
    './KnowledgeSection.js': { KnowledgePanel: () => null, SidebarKnowledgeAction: () => null },
    './LocalModelsSection.js': { LocalModelsSection: mineruPlaceholder },
    './locales.js': { en: {}, zh: {} },
    './panel-store.js': { createKnowledgePanelStore: () => ({}) },
    './directory-actions.js': { createDirectoryActions },
  }, globals)
}

class RemoteRoot extends Service {
  constructor(ctx: Context) { super(ctx, 'remote') }
}

class DirectorySession extends Service {
  readonly requests: Array<{ path: string }> = []
  readonly callers: string[] = []

  constructor(ctx: Context) { super(ctx, 'remote.session') }

  async canOpenWorkspacePath() {
    this.callers.push(this.ctx.fiber.name)
    return { ok: true, value: true }
  }

  async openWorkspacePath(request: { path: string }) {
    this.callers.push(this.ctx.fiber.name)
    this.requests.push(request)
    return { ok: true, value: { opened: true } }
  }
}

/** Use the installed Cordis runtime for dependency resolution and its real
 * traced Service proxy. Slot/locale rendering stays outside this harness. */
async function cordisClientFixture(globals: Record<string, unknown> = {}, prepare?: (ctx: Context) => void | Promise<void>) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
  ctx.provide('slots', {
    inject: (_name: string, callback: () => void) => callback(),
    register: (options: Record<string, unknown>, component: unknown) => { registrations.push({ options, component }) },
  })
  ctx.provide('locale', { register: () => () => {}, bind: () => translate })
  new RemoteRoot(ctx)
  await prepare?.(ctx)
  const entry = clientEntry(globals)
  const plugin = await ctx.plugin({
    name: 'knowledge-directory-client-test',
    inject: entry.inject as string[],
    apply: entry.apply as (ctx: Context) => void,
  })
  const props = () => {
    const registration = registrations.find(item => item.options.id === 'local-models')!
    return (registration.options.inject as () => { directoryActions: DirectoryActions })()
  }
  return { ctx, plugin, registrations, props }
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
    // The scoped namespace is looked up directly (`remote.session`): reading
    // `.session` off the `remote` service object is inject-gated and crashed
    // the settings slot (issue #47).
    services['remote.session'] = session
    const registration = registrations.find(item => item.options.id === 'local-models')!
    const props = (registration.options.inject as () => { directoryActions: DirectoryActions })()
    expect(registration.component).toBe(mineruPlaceholder)
    await expect(props.directoryActions.pickDirectory?.()).resolves.toBe('C:\\native')
    await expect(props.directoryActions.canOpenPath?.()).resolves.toBe(true)
    await props.directoryActions.openPath?.('C:\\absolute-cache')
    expect(session.openWorkspacePath).toHaveBeenCalledExactlyOnceWith({ path: 'C:\\absolute-cache' })
    expect(get).toHaveBeenCalledWith('uiWorkspace')
    expect(get).toHaveBeenCalledWith('remote.session')
    expect(get).not.toHaveBeenCalledWith('remote')
    expect(uiWorkspace.pickDirectory).not.toHaveBeenCalled()
  })
})

describe('Cordis directory service integration (#47)', () => {
  it('opens through a real scoped service even when the Remote property is inject-gated', async () => {
    let session!: DirectorySession
    const fixture = await cordisClientFixture({}, async ctx => {
      // api-gateway creates each remote namespace in a separate provider
      // fiber. A root-provided mock would grant every descendant access and
      // never exercise the missing-inject failure.
      await ctx.plugin({
        name: 'directory-session-provider',
        apply: (provider: Context) => { session = new DirectorySession(provider) },
      })
    })

    // Reproduce the actual Cordis associate proxy path. The plugin only
    // injects slots/locale; ctx.get('remote') does not authorize .session.
    expect(() => fixture.plugin.ctx.get('remote').session)
      .toThrow('cannot get property "remote.session" without inject')
    expect(fixture.plugin.ctx.get('remote.session')).toBeDefined()

    const { directoryActions } = fixture.props()
    await expect(directoryActions.canOpenPath?.()).resolves.toBe(true)
    await expect(directoryActions.openPath?.('E:\\cache with spaces')).resolves.toBeUndefined()
    expect(session.requests).toEqual([{ path: 'E:\\cache with spaces' }])
    // Cordis tracing must retain the calling plugin context, not rebind to
    // the namespace provider's root context when the adapter binds methods.
    expect(session.callers).toEqual(['knowledge-directory-client-test', 'knowledge-directory-client-test'])
  })

  it('discovers later legacy and uiWorkspace services at props injection without requiring remote.session', async () => {
    const fixture = await cordisClientFixture()
    const { directoryActions } = fixture.props()
    expect(fixture.plugin.ctx.get('remote.session')).toBeUndefined()
    expect(directoryActions.pickDirectory).toBeUndefined()
    expect(directoryActions.openPath).toBeUndefined()
    expect(directoryActions.canOpenPath).toBeUndefined()

    const workspaces = {
      selected: 'C:\\legacy',
      opened: [] as string[],
      async pickDirectory(this: { selected: string }) { return this.selected },
      async openPath(this: { opened: string[] }, path: string) { this.opened.push(path) },
    }
    fixture.ctx.provide('workspaces', workspaces)
    await expect(directoryActions.pickDirectory?.()).resolves.toBe('C:\\legacy')
    await expect(directoryActions.canOpenPath?.()).resolves.toBe(true)
    await directoryActions.openPath?.('D:\\legacy-cache')
    expect(workspaces.opened).toEqual(['D:\\legacy-cache'])

    const uiWorkspace = { pickDirectory: vi.fn(async () => 'C:\\ui') }
    fixture.ctx.provide('uiWorkspace', uiWorkspace)
    await expect(directoryActions.pickDirectory?.()).resolves.toBe('C:\\ui')
    expect(uiWorkspace.pickDirectory).toHaveBeenCalledOnce()
    expect(fixture.registrations.map(item => item.options.id)).toEqual(['knowledge', 'knowledge', 'local-models'])
  })

  it('keeps the native picker usable on a host without a session namespace or workspace picker', async () => {
    const nativePicker = {
      selected: 'D:\\native-models',
      async pick(this: { selected: string }) { return this.selected },
    }
    const fixture = await cordisClientFixture({ __DSH_DIRECTORY_PICKER__: nativePicker })
    const { directoryActions } = fixture.props()
    await expect(directoryActions.pickDirectory?.()).resolves.toBe('D:\\native-models')
    expect(directoryActions.openPath).toBeUndefined()
    expect(directoryActions.canOpenPath).toBeUndefined()
  })

  it('keeps the picker already passed to MinerU current when the host service is replaced', async () => {
    const fixture = await cordisClientFixture()
    const firstPicker = vi.fn(async () => 'C:\\first-mineru')
    const dispose = fixture.ctx.provide('uiWorkspace', { pickDirectory: firstPicker })
    const { panel } = await localFixture(fixture.props().directoryActions)
    const mineru = elements(panel.render()).find(element => element.type === mineruPlaceholder)!
    const retainedPicker = mineru.props.pickDirectory as () => Promise<string | null>
    await expect(retainedPicker()).resolves.toBe('C:\\first-mineru')

    await dispose()
    const replacement = vi.fn(async () => 'D:\\replacement-mineru')
    fixture.ctx.provide('uiWorkspace', { pickDirectory: replacement })
    await expect(retainedPicker()).resolves.toBe('D:\\replacement-mineru')
    expect(firstPicker).toHaveBeenCalledOnce()
    expect(replacement).toHaveBeenCalledOnce()
  })

  it('keeps cached slot props current across namespace registration, withdrawal and replacement', async () => {
    const fixture = await cordisClientFixture()
    const { directoryActions } = fixture.props()
    expect(directoryActions.openPath).toBeUndefined()

    let first!: DirectorySession
    const provider = await fixture.ctx.plugin({
      name: 'first-directory-session',
      apply: (ctx: Context) => { first = new DirectorySession(ctx) },
    })
    const retainedOpen = directoryActions.openPath!
    await retainedOpen('C:\\first-cache')
    expect(first.requests).toEqual([{ path: 'C:\\first-cache' }])

    await provider.dispose()
    expect(fixture.plugin.ctx.get('remote.session')).toBeUndefined()
    expect(directoryActions.openPath).toBeUndefined()

    let replacement!: DirectorySession
    await fixture.ctx.plugin({
      name: 'replacement-directory-session',
      apply: (ctx: Context) => { replacement = new DirectorySession(ctx) },
    })
    expect(directoryActions.openPath).toBe(retainedOpen)
    await retainedOpen('C:\\replacement-cache')
    expect(replacement.requests).toEqual([{ path: 'C:\\replacement-cache' }])
    expect(first.requests).toHaveLength(1)
    expect(fixture.registrations).toHaveLength(3)
  })
})
