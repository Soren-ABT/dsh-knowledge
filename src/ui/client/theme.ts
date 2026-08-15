/**
 * Shared theme tokens (DSH tokens with Cherry-Studio-like fallbacks) and the
 * panel's inline style vocabulary, used by the panel and every dialog.
 * @module dsh-knowledge/client/theme
 */

import type { CSSProperties } from 'react'

export const C = {
  bg: 'var(--dsw-alias-bg-base, #f6f7f9)',
  surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  surface2: 'var(--dsw-alias-bg-layer-2, #f1f2f5)',
  overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
  border: 'var(--dsw-alias-border-l1, #e3e5e9)',
  borderStrong: 'var(--dsw-alias-border-l2, #c7ccd4)',
  text: 'var(--dsw-alias-label-primary, #1f2329)',
  muted: 'var(--dsw-alias-label-secondary, #8a919c)',
  accent: 'var(--dsw-alias-brand-primary, #3b6ef6)',
  danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
  success: 'var(--dsw-alias-state-success-primary, #30a46c)',
  warn: 'var(--dsw-alias-state-warn-primary, #f5a623)',
} as const

export const accentSoft = 'color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6ef6) 10%, transparent)'

/** One-off hover/animation CSS injected once by the panel. */
export const PANEL_CSS = `
@keyframes kb-spin { to { transform: rotate(360deg) } }
@keyframes kb-fade-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
.kb-spinner { animation: kb-spin 0.9s linear infinite }
.kb-panel-in { animation: kb-fade-in 0.18s ease-out }
.kb-row { transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease }
.kb-row:hover { background: var(--dsw-alias-bg-layer-2, #f1f2f5) }
.kb-card { transition: border-color 0.15s ease, background 0.15s ease }
.kb-card:hover { border-color: var(--dsw-alias-border-l2, #c7ccd4) }
.kb-iconbtn { transition: color 0.15s ease, background 0.15s ease }
.kb-iconbtn:hover { color: var(--dsw-alias-brand-primary, #3b6ef6); background: ${accentSoft} }
.kb-sidebar-action:hover { background: var(--dsw-alias-interactive-bg-hover) }
.kb-dangerbtn:hover { color: var(--dsw-alias-state-error-primary, #e5484d); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 10%, transparent) }
.kb-scroll::-webkit-scrollbar { width: 8px; height: 8px }
.kb-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2, #c7ccd4); border-radius: 999px }
.kb-scroll::-webkit-scrollbar-track { background: transparent }
`

export const style = {
  panel: {
    position: 'fixed', inset: 0, zIndex: 300, display: 'flex', flexDirection: 'column',
    background: C.bg, color: C.text, pointerEvents: 'auto',
  } as CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    height: 52, padding: '0 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0,
  } as CSSProperties,
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10 } as CSSProperties,
  headerTitle: { fontSize: 15, fontWeight: 600 } as CSSProperties,
  headerActions: { display: 'flex', alignItems: 'center', gap: 6 } as CSSProperties,
  iconButton: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 12px',
    background: C.surface, color: C.text, cursor: 'pointer', fontSize: 13,
  } as CSSProperties,
  closeButton: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 30, height: 30, border: 'none', borderRadius: 8, background: 'transparent',
    color: C.muted, cursor: 'pointer', fontSize: 16,
  } as CSSProperties,
  body: { flex: 1, display: 'flex', minHeight: 0 } as CSSProperties,
  sidebar: {
    width: 272, flexShrink: 0, borderRight: `1px solid ${C.border}`, background: C.surface,
    padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8,
  } as CSSProperties,
  newBaseButton: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    border: `1px dashed ${C.borderStrong}`, borderRadius: 10, padding: '10px 12px',
    background: 'transparent', color: C.accent, cursor: 'pointer', fontSize: 13, fontWeight: 600, flexShrink: 0,
  } as CSSProperties,
  baseCard: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10,
    cursor: 'pointer', border: '1px solid transparent', background: 'transparent',
  } as CSSProperties,
  baseCardActive: { background: accentSoft, border: `1px solid ${C.accent}33` } as CSSProperties,
  baseAvatar: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34,
    borderRadius: 9, color: '#fff', flexShrink: 0, fontSize: 15, fontWeight: 700,
  } as CSSProperties,
  baseName: { fontSize: 13, fontWeight: 600 } as CSSProperties,
  baseMeta: { fontSize: 11, color: C.muted, marginTop: 2 } as CSSProperties,
  main: { flex: 1, minWidth: 0, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 } as CSSProperties,
  card: { border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, padding: 14 } as CSSProperties,
  cardTitle: { fontSize: 13, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' } as CSSProperties,
  button: {
    display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${C.border}`,
    borderRadius: 8, padding: '6px 12px', background: C.surface, color: C.text, cursor: 'pointer', fontSize: 13,
  } as CSSProperties,
  primary: {
    display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid transparent',
    borderRadius: 8, padding: '6px 14px', background: C.accent, color: '#fff', cursor: 'pointer',
    fontSize: 13, fontWeight: 600,
  } as CSSProperties,
  primaryDanger: {
    display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid transparent',
    borderRadius: 8, padding: '6px 14px', background: C.danger, color: '#fff', cursor: 'pointer',
    fontSize: 13, fontWeight: 600,
  } as CSSProperties,
  danger: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none',
    borderRadius: 6, padding: '3px 8px', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 12,
  } as CSSProperties,
  input: {
    border: `1px solid ${C.border}`, borderRadius: 8, padding: '7px 10px', fontSize: 13,
    background: C.surface, color: C.text, width: '100%', boxSizing: 'border-box', outline: 'none',
  } as CSSProperties,
  textarea: {
    border: `1px solid ${C.border}`, borderRadius: 8, padding: 9, fontSize: 13,
    background: C.surface, color: C.text, width: '100%', minHeight: 84, boxSizing: 'border-box',
    resize: 'vertical', outline: 'none', fontFamily: 'inherit',
  } as CSSProperties,
  dropzone: {
    border: `1px dashed ${C.borderStrong}`, borderRadius: 10, padding: 14, marginTop: 10,
    textAlign: 'center', color: C.muted, fontSize: 12,
  } as CSSProperties,
  dropzoneActive: { border: `1px dashed ${C.accent}`, background: accentSoft, color: C.accent } as CSSProperties,
  actionsRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as CSSProperties,
  statsRow: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 } as CSSProperties,
  statChip: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
    background: C.surface2, borderRadius: 10, padding: '7px 14px', minWidth: 62,
  } as CSSProperties,
  statValue: { fontSize: 15, fontWeight: 700, color: C.text } as CSSProperties,
  statLabel: { fontSize: 11, color: C.muted } as CSSProperties,
  docRow: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 10,
    cursor: 'pointer', border: '1px solid transparent', marginBottom: 2,
  } as CSSProperties,
  docIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
    borderRadius: 8, background: C.surface2, flexShrink: 0,
  } as CSSProperties,
  docTitle: { fontSize: 13, fontWeight: 600 } as CSSProperties,
  docMeta: { fontSize: 11, color: C.muted, marginTop: 1 } as CSSProperties,
  docActions: { display: 'flex', marginLeft: 'auto' } as CSSProperties,
  chunk: {
    border: `1px solid ${C.border}`, borderRadius: 8, padding: 8, marginBottom: 6,
    fontSize: 12, background: C.surface2,
  } as CSSProperties,
  hit: { border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, marginBottom: 8, fontSize: 12, background: C.surface } as CSSProperties,
  scorePill: {
    display: 'inline-block', borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 700,
    color: '#fff', marginRight: 8,
  } as CSSProperties,
  mark: { background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a623) 35%, transparent)', borderRadius: 2, padding: '0 1px' } as CSSProperties,
  label: { fontSize: 12, fontWeight: 600, marginBottom: 5, display: 'block' } as CSSProperties,
  field: { marginBottom: 12 } as CSSProperties,
  hint: { fontSize: 11, color: C.muted, marginTop: 4 } as CSSProperties,
  empty: { color: C.muted, fontSize: 13, padding: 24, textAlign: 'center' } as CSSProperties,
  error: { color: C.danger, fontSize: 12, background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 8%, transparent)', borderRadius: 8, padding: '8px 12px' } as CSSProperties,
  modalBackdrop: {
    position: 'absolute', inset: 0, zIndex: 20, background: 'rgba(0,0,0,0.32)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  } as CSSProperties,
  modal: {
    width: 520, maxWidth: '92vw', maxHeight: '86vh', overflowY: 'auto',
    background: C.overlay, borderRadius: 14, padding: 18,
    border: `1px solid ${C.border}`, boxShadow: '0 18px 50px rgba(0,0,0,0.2)',
  } as CSSProperties,
  modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 } as CSSProperties,
  sidebarAction: {
    // Geometry mirrors the shell's Settings trigger (ui-settings-general
    // SettingsRoot.module.css) so the two footer rows read as one.
    flex: 'none', display: 'flex', alignItems: 'center', gap: 8,
    width: 'calc(100% + 8px)', height: 34,
    margin: '4px -4px 4px', padding: '6px 2px 6px 10px',
    boxSizing: 'border-box', border: 'none', borderRadius: 12,
    background: 'transparent', cursor: 'pointer', overflow: 'hidden',
    color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit',
    fontSize: 14, lineHeight: 22,
  } as CSSProperties,
  sidebarActionRail: {
    width: 36, height: 36, margin: '8px 0 10px',
    justifyContent: 'center', gap: 0, padding: 0, borderRadius: '50%',
  } as CSSProperties,
  sidebarActionActive: { color: C.accent, background: accentSoft } as CSSProperties,
  tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 14 } as CSSProperties,
  tab: {
    display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent',
    padding: '8px 14px', cursor: 'pointer', fontSize: 13, color: C.muted,
    borderBottom: '2px solid transparent', marginBottom: -1, fontWeight: 600,
  } as CSSProperties,
  tabActive: { color: C.accent, borderBottom: `2px solid ${C.accent}` } as CSSProperties,
  toastStack: {
    position: 'absolute', top: 62, left: '50%', transform: 'translateX(-50%)', zIndex: 40,
    display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
  } as CSSProperties,
  toast: {
    display: 'flex', alignItems: 'center', gap: 8, borderRadius: 999, padding: '8px 16px',
    fontSize: 13, fontWeight: 600, background: C.overlay, border: `1px solid ${C.border}`,
    boxShadow: '0 8px 24px rgba(0,0,0,0.14)', color: C.text,
  } as CSSProperties,
  fileRow: {
    display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${C.border}`,
    borderRadius: 8, padding: '7px 10px', marginBottom: 6, fontSize: 12,
  } as CSSProperties,
  spinner: { display: 'inline-block', width: 14, height: 14, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent' } as CSSProperties,
  menu: {
    position: 'absolute', zIndex: 30, minWidth: 180, borderRadius: 10, padding: 4,
    background: C.overlay, border: `1px solid ${C.border}`, boxShadow: '0 10px 32px rgba(0,0,0,0.18)',
  } as CSSProperties,
  menuItem: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', background: 'transparent',
    borderRadius: 7, padding: '7px 10px', fontSize: 13, color: C.text, cursor: 'pointer', textAlign: 'left',
  } as CSSProperties,
  menuItemDanger: { color: C.danger } as CSSProperties,
  menuSeparator: { height: 1, background: C.border, margin: '4px 8px' } as CSSProperties,
  sectionTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 2px' } as CSSProperties,
  sectionHint: { fontSize: 11, color: C.muted, margin: '0 0 10px', lineHeight: 1.5 } as CSSProperties,
  sliderRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 } as CSSProperties,
  sliderValue: { fontSize: 12, color: C.muted, fontVariantNumeric: 'tabular-nums' } as CSSProperties,
  sliderBounds: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.muted, marginTop: 2 } as CSSProperties,
  switch: {
    width: 36, height: 20, borderRadius: 999, border: 'none', cursor: 'pointer', position: 'relative',
    background: C.borderStrong, transition: 'background 0.15s', flexShrink: 0,
  } as CSSProperties,
  switchOn: { background: C.accent } as CSSProperties,
  switchKnob: {
    position: 'absolute', top: 2, left: 2, width: 16, height: 16, borderRadius: '50%', background: '#fff',
    transition: 'transform 0.15s',
  } as CSSProperties,
  accordionHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
    border: 'none', background: 'transparent', padding: '8px 0', cursor: 'pointer',
    fontSize: 13, fontWeight: 600, color: C.text,
  } as CSSProperties,
  warningHint: {
    fontSize: 11, color: C.warn, background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a623) 10%, transparent)',
    borderRadius: 8, padding: '8px 10px', lineHeight: 1.5,
  } as CSSProperties,
  ghostButton: {
    display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', borderRadius: 8,
    padding: '5px 10px', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 13,
  } as CSSProperties,
  iconOnlyButton: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26,
    border: 'none', borderRadius: 7, background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 14,
  } as CSSProperties,
  tableHeadRow: {
    display: 'grid', gridTemplateColumns: '32px minmax(0,1fr) 92px 120px 96px 32px',
    alignItems: 'center', gap: 8, padding: '0 10px 8px', borderBottom: `1px solid ${C.border}`,
    fontSize: 11, color: C.muted, fontWeight: 600,
  } as CSSProperties,
  tableRow: {
    display: 'grid', gridTemplateColumns: '32px minmax(0,1fr) 92px 120px 96px 32px',
    alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
  } as CSSProperties,
  checkbox: {
    width: 16, height: 16, borderRadius: 4, border: `1px solid ${C.borderStrong}`, background: C.surface,
    cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', padding: 0, flexShrink: 0, fontSize: 11, lineHeight: 1,
  } as CSSProperties,
  checkboxOn: { background: C.accent, borderColor: C.accent } as CSSProperties,
  sidePanelScrim: {
    position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.28)',
    display: 'flex', justifyContent: 'flex-end',
  } as CSSProperties,
  sidePanel: {
    width: 460, maxWidth: '92vw', height: '100%', background: C.surface, borderLeft: `1px solid ${C.border}`,
    boxShadow: '-16px 0 40px rgba(0,0,0,0.16)', display: 'flex', flexDirection: 'column',
    animation: 'kb-fade-in 0.18s ease-out',
  } as CSSProperties,
  sidePanelHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
    padding: '12px 16px', borderBottom: `1px solid ${C.border}`,
  } as CSSProperties,
  sidePanelBody: { flex: 1, minHeight: 0, padding: 16, overflowY: 'auto' } as CSSProperties,
} as const

/** Palette for auto-colored base avatars (hash → color). */
export const AVATAR_COLORS = [
  '#3b6ef6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#6366f1',
] as const

export function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

/** Human-readable size from a character count (≈ bytes). */
export function formatSize(charCount: number): string {
  if (charCount < 1024) return `${charCount} B`
  if (charCount < 1024 * 1024) return `${(charCount / 1024).toFixed(1)} KB`
  return `${(charCount / (1024 * 1024)).toFixed(2)} MB`
}

/** Compact relative time, Cherry Studio style (刚刚 / N 分钟前 / N 小时前…). */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - timestamp)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString()
}
