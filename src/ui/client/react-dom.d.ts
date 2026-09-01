/**
 * Ambient declaration for the external `react-dom` module.
 * `react-dom` is NOT installed here — the DSH shell injects it into the
 * frozen client module table at runtime (see build.mjs clientExternal), so
 * esbuild keeps it external. This declaration gives tsc the one member we
 * use without pulling in @types/react-dom.
 */
declare module 'react-dom' {
  import type { ReactNode } from 'react'
  export function createPortal(children: ReactNode, container: Element | DocumentFragment): ReactNode
}
