import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The pinned DSH checkout supplies the renderer's React and its test DOM.
// Bundle the actual panel so portals, refs, effects and focus run together.
const host = createRequire(new URL('../../dsh/package.json', import.meta.url))
const { JSDOM } = host('jsdom')
let fixture
let page
let doc

beforeAll(async () => {
  const result = await build({
    stdin: {
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      contents: `
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { KnowledgePanel, SidebarKnowledgeAction } from './src/ui/client/KnowledgeSection'
        import { createKnowledgePanelStore } from './src/ui/client/panel-store'
        const store = createKnowledgePanelStore()
        const t = key => key
        const api = {
          listBases: async () => [{id: 'b', name: 'Handbook', documentCount: 0, charCount: 0}],
          getConfig: async () => ({}), listGroups: async () => [],
          listLocalModels: async () => [],
          getKnowledgeToggle: async () => ({enabled: true, enabledBaseIds: []}),
        }
        window.panelApi = api
        const root = createRoot(document.getElementById('root'))
        flushSync(() => root.render(<>
          <SidebarKnowledgeAction store={store} wide t={t} />
          <div data-shell-overlay=""><KnowledgePanel store={store} api={api} t={t} /></div>
        </>))
        window.unmount = () => root.unmount()
      `,
    },
    nodePaths: [fileURLToPath(new URL('../../dsh/packages/client/web/node_modules/', import.meta.url))],
    bundle: true, write: false, jsx: 'automatic', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  fixture = result.outputFiles[0].text
})

describe('bound directory rescan (#84)', () => {
  it('reconnects after a lost acknowledgement and reattaches after the panel is closed', async () => {
    const source = { sourceId: 'root-doc', kind: 'directory', text: 'Manuals', sourcePath: '/manuals' }
    const totals = {documentCount: 1, storedDocCount: 1, charCount: 42, tokenCount: 10, chunkCount: 1}
    const base = {id: 'b', name: 'Handbook', sourceInfo: [source], updatedAt: 1, ...totals}
    const directory = {id: source.sourceId, baseId: base.id, title: source.text, sourcePath: source.sourcePath,
      sourceType: 'directory', status: 'completed', createdAt: 1, updatedAt: 1, ...totals}
    let active
    let last
    let starts = 0
    let reads = 0
    let legacyCalls = 0
    const api = page.window.panelApi
    Object.assign(api, {
      listBases: async () => [base], listDocuments: async () => [{...directory, directoryScan: active}],
      stats: async () => totals, getIndexingStatus: async () => [],
      startDirectoryRescan: async (id, runId) => {
        starts++
        active = {sourceId: id, runId, title: source.text, processed: 17, lastPath: 'part17.md'}
        throw new Error('connection closed after server accepted request')
      },
      getDirectoryRescan: async () => {
        if (++reads <= 2) throw new Error('temporarily offline')
        return {active, last}
      },
      reindexDocument: async () => { legacyCalls++ },
    })
    const close = () => doc.querySelector('.kb-panel-header button[aria-label="close"]').click()
    const reopenBase = async () => {
      await vi.waitFor(() => expect(doc.querySelector('.kb-panel-in')).toBeNull())
      doc.querySelector('.kb-sidebar-action').click()
      await vi.waitFor(() => expect(doc.querySelector('.kb-card')).toBeTruthy())
      doc.querySelector('.kb-card').click()
      await vi.waitFor(() => expect(Array.from(doc.querySelectorAll('button'))
        .find(button => button.textContent === 'directoryRescan')).toBeTruthy())
    }
    close()
    await reopenBase()
    const scanButton = Array.from(doc.querySelectorAll('button')).find(button => button.textContent === 'directoryRescan')
    await vi.waitFor(() => expect(scanButton.disabled).toBe(false))
    scanButton.click()
    await vi.waitFor(() => expect(doc.body.textContent).toContain('directoryScanReconnecting'))
    close()
    await reopenBase()
    await vi.waitFor(() => expect(doc.body.textContent).toContain('directoryScanProgress 17 · part17.md'))
    last = {runId: active.runId, status: 'partial', created: 17, updated: 0, deleted: 0, unchanged: 0, failed: 1,
      startedAt: 1, finishedAt: 2, error: 'part18.md: read error'}
    active = undefined
    await vi.waitFor(() => expect(doc.body.textContent).toContain('part18.md: read error'), {timeout: 3000})
    expect(doc.body.textContent).not.toContain('directoryScanProgress')
    expect(starts).toBe(1)
    expect(legacyCalls).toBe(0)
  })

  it('sends a selected directory once and keeps ordinary files on the batch path', async () => {
    const totals = {documentCount: 3, storedDocCount: 2, charCount: 48, tokenCount: 12, chunkCount: 2}
    const common = {baseId: 'b', status: 'completed', createdAt: 1, updatedAt: 1, ...totals}
    const docs = [
      {...common, id: 'root', title: 'Manuals', sourceType: 'directory', sourcePath: '/manuals'},
      {...common, id: 'child', title: 'Nested', sourceType: 'text', parentDirectoryId: 'root'},
      {...common, id: 'other', title: 'Independent', sourceType: 'text'},
    ]
    const starts = []
    const batches = []
    let active
    Object.assign(page.window.panelApi, {
      listDocuments: async () => docs, stats: async () => totals, getIndexingStatus: async () => [],
      startDirectoryRescan: async (sourceId, runId) => {
        starts.push(sourceId)
        active = {sourceId, runId, title: 'Manuals', processed: 1}
        return {active}
      },
      getDirectoryRescan: async () => ({active}),
      reindexDocuments: async ids => { batches.push([...ids]); return {reindexed: ids.length, items: []} },
    })
    doc.querySelector('.kb-card').click()
    await vi.waitFor(() => expect(doc.querySelector('[aria-label="selectAll"]')).toBeTruthy())
    doc.querySelector('[aria-label="selectAll"]').click()
    const bulk = () => Array.from(doc.querySelectorAll('button')).find(button => button.textContent === 'bulkReindex')
    await vi.waitFor(() => expect(bulk()?.disabled).toBe(false))
    bulk().click()
    await vi.waitFor(() => expect(batches).toEqual([['other']]))
    expect(starts).toEqual(['root'])
  })
})

beforeEach(async () => {
  page = new JSDOM('<!doctype html><html data-platform="darwin"><body><div id="root"></div></body></html>', {
    runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true,
  })
  doc = page.window.document
  page.window.eval(fixture)
  const opener = doc.querySelector('.kb-sidebar-action')
  opener.focus()
  opener.click()
  await vi.waitFor(() => expect(doc.querySelector('.kb-card')).toBeTruthy())
})

afterEach(() => {
  page.window.unmount()
  page.window.close()
})

function escape(options = {}) {
  const event = new page.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true, ...options})
  doc.activeElement.dispatchEvent(event)
  return event
}

describe('desktop knowledge panel (#83)', () => {
  it('owns a body layer after the host frame and returns focus on dismissal', async () => {
    const panel = doc.querySelector('.kb-panel-in')
    expect(panel.parentElement).toBe(doc.body)
    expect(panel.querySelector('[data-window-drag]')).toBe(panel.firstElementChild)
    expect(panel.querySelector('.kb-panel-header').contains(panel.querySelector('button[aria-label="close"]'))).toBe(true)
    expect(panel.querySelector('button[aria-label="close"]').closest('[data-window-drag]')).toBeNull()
    expect(doc.activeElement).toBe(panel)
    expect(escape().defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(panel.isConnected).toBe(false))
    expect(doc.activeElement).toBe(doc.querySelector('.kb-sidebar-action'))
    expect(escape().defaultPrevented).toBe(false)
  })

  it('dismisses a portaled menu and an edit dialog without closing the panel underneath', async () => {
    const panel = doc.querySelector('.kb-panel-in')
    panel.querySelector('.kb-card .kb-iconbtn').click()
    await vi.waitFor(() => expect(doc.querySelector('.kb-menuitem')).toBeTruthy())
    expect(escape().defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(doc.querySelector('.kb-menuitem')).toBeNull())
    const newGroup = [...panel.querySelectorAll('button')].find(button => button.textContent === 'newGroup')
    newGroup.click()
    await vi.waitFor(() => expect(doc.activeElement).toBe(panel.querySelector('[role="dialog"][aria-label="newGroup"] input')))
    expect(escape().defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(panel.querySelector('[role="dialog"]')).toBeNull())
    expect(panel.isConnected).toBe(true)
  })

  it('yields Escape to IME composition and host dialogs, and ignores a held key', () => {
    const panel = doc.querySelector('.kb-panel-in')
    expect(escape({isComposing: true}).defaultPrevented).toBe(false)
    expect(escape({repeat: true}).defaultPrevented).toBe(true)
    const foreign = doc.createElement('div')
    foreign.setAttribute('role', 'dialog')
    foreign.setAttribute('aria-modal', 'true')
    doc.body.append(foreign)
    expect(escape().defaultPrevented).toBe(false)
    expect(panel.isConnected).toBe(true)
  })

  it('returns to the host when later menus are hidden or inert', async () => {
    const panel = doc.querySelector('.kb-panel-in')
    for (const attribute of ['hidden', 'inert', 'aria-hidden']) {
      const wrapper = doc.createElement('div')
      wrapper.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '')
      wrapper.innerHTML = '<div role="menu"></div>'
      doc.body.append(wrapper)
    }
    expect(escape().defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(panel.isConnected).toBe(false))
  })
})
