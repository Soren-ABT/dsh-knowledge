/**
 * Model-facing knowledge tools. The tools consume the host `knowledge`
 * service and publish nothing themselves, so this row sits as an ordinary
 * tool plugin beside the service it reaches (the same split the goal and
 * interconnect tools use against their host services).
 * @module dsh-knowledge/tool-knowledge
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerToolAccess } from './tool-access.js'
import { registerAutoRetrieve } from './auto-retrieve.js'
import { registerSearchTool } from './search-tool.js'
import { registerLibraryTools } from './library-tools.js'
import { registerDocumentTools } from './document-tools.js'

export { knowledgeDestructiveApprovalReason } from './tool-access.js'
export { autoRetrieveBackground, buildAutoRetrieveMessage, foldBackground, userTextOf, type AutoRetrieveBackground } from './auto-retrieve.js'
export {
  clipAroundQuery, renderKnowledgeDocumentPage, renderKnowledgeEvidence,
  renderKnowledgeReadResult, renderKnowledgeSearchResult, SEARCH_RENDER_MAX_TOKENS,
} from './render.js'

/** Services required before the tools can register. */
export const inject = ['knowledge', 'tools', 'systemPrompt']

export function apply(ctx: Context): void {
  registerToolAccess(ctx)
  registerSearchTool(ctx)
  registerLibraryTools(ctx)
  registerDocumentTools(ctx)
  registerAutoRetrieve(ctx)
}
