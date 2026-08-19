/**
 * Inline SVG icons for the knowledge panel (no icon dependency). A file-type
 * helper picks the icon and brand color by extension, Cherry Studio style.
 * @module dsh-knowledge/client/icons
 */

import type { CSSProperties } from 'react'

interface IconProps {
  size?: number
  color?: string
}

function svgProps(size: number, color: string | undefined) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color ?? 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
}

export function IconBook(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 18, props.color)}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

export function IconDoc(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 16, props.color)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  )
}

export function IconPdf(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 16, props.color)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M8 13h1.5a1.5 1.5 0 0 1 0 3H8m0-3v3m3.5-3h2a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-2" />
    </svg>
  )
}

export function IconWord(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 16, props.color)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M7.5 12 10 17l2.5-5M12 17l1.5-5h3" />
    </svg>
  )
}

export function IconMarkdown(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 16, props.color)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M8 17v-6l2.5 3 2.5-3v6M15 13h3" />
    </svg>
  )
}

export function IconText(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 16, props.color)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </svg>
  )
}

export function IconGlobe(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 16, props.color)}>
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" />
    </svg>
  )
}

export function IconPlus(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 14, props.color)} strokeWidth={2.2}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function IconUpload(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 14, props.color)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

export function IconLink(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 14, props.color)}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

export function IconGear(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 15, props.color)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export function IconSearch(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 14, props.color)}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

export function IconPencil(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 12, props.color)}>
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  )
}

export function IconTrash(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 12, props.color)}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function IconCheck(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 14, props.color)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export function IconX(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 12, props.color)}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

export function IconRefresh(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 14, props.color)}>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}

export function IconFlask(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 14, props.color)}>
      <path d="M10 2v7.5L4.5 19a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9.5V2" />
      <line x1="8.5" y1="2" x2="15.5" y2="2" />
      <path d="M7 16h10" />
    </svg>
  )
}

export function IconSliders(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 14, props.color)}>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  )
}

export function IconMore(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 16, props.color)}>
      <circle cx="12" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconEye(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 14, props.color)}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function IconDownload(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 14, props.color)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

export function IconBox(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 18, props.color)}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  )
}

/** File-type icon and color by extension, Cherry Studio style. */
export function fileVisual(name: string): { color: string; icon: (props: IconProps) => JSX.Element } {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'pdf') return { color: '#e5484d', icon: IconPdf }
  if (ext === 'docx' || ext === 'doc') return { color: '#3b6ef6', icon: IconWord }
  if (ext === 'md' || ext === 'markdown') return { color: '#8b5cf6', icon: IconMarkdown }
  if (ext === 'txt' || ext === 'text' || ext === 'log' || ext === 'json' || ext === 'csv') {
    return { color: '#8a919c', icon: IconText }
  }
  return { color: '#10b981', icon: IconGlobe }
}

/** Document-row icon style wrapper. */
export function docIconStyle(color: string): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
    borderRadius: 8, flexShrink: 0, color,
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
  }
}

// ── lucide icons (ISC license, paths from lucide-static v1.32.0) ─────────────

export function IconFolder(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 18, props.color)}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

export function IconFolderInput(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 18, props.color)}>
      <path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" />
      <path d="M2 13h10" />
      <path d="m9 16 3-3-3-3" />
    </svg>
  )
}

export function IconFolderOpen(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 18, props.color)}>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function IconFolderSearch(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 18, props.color)}>
      <path d="M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1" />
      <path d="m21 21-1.9-1.9" />
      <circle cx="17" cy="17" r="3" />
    </svg>
  )
}

export function IconScanText(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 18, props.color)}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 8h8" />
      <path d="M7 12h10" />
      <path d="M7 16h6" />
    </svg>
  )
}

export function IconBot(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size ?? 18, props.color)}>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  )
}
