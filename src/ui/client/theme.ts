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
  text: 'var(--dsw-alias-label-primary, #1f2329)',
  // DSH's label-secondary is extremely faint in the light theme (#cfd3d6 on
  // white ≈ 1.4:1), which makes hint/secondary text visually merge with the
  // surface. Derive a readable "muted" from the primary label color instead
  // (≈72% of near-black in light, ≈72% of near-white in dark), so it stays
  // legible in both DSH themes while still reading as secondary.
  muted: 'color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 72%, transparent)',
  // DSH's border-l1 is ~6% black / 9% white — too faint to separate panels.
  // Use the stronger border-l2 / border-l3 tiers for card and control edges.
  border: 'var(--dsw-alias-border-l2, #c7ccd4)',
  borderStrong: 'var(--dsw-alias-border-l3, #9aa1ab)',
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
/* Theme-adaptive interaction fills. DSH's own layer tokens are pure white in
   the light theme and its interactive-bg-hover is only ~6% alpha, so hovers
   built on them are nearly invisible. Derive hover/active fills from the
   inverted label-primary token instead: ~9% black-on-white in light, ~9%
   white-on-dark in dark — clearly visible in both base themes. Declared on
   body (portal menus and the sidebar action render outside the panel) and
   re-scoped to the panel root. */
body, .kb-panel-in {
  --kb-hover: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 9%, transparent);
  --kb-active: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 16%, transparent);
}
.kb-row { transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease }
.kb-row:hover { background: var(--kb-hover) }
/* Menu items fill on hover/active; the fill rides a CSS variable referenced from
   the inline background so the class can override the inline style. */
.kb-menuitem { transition: background 0.15s ease }
.kb-menuitem:hover { --kb-mibg: var(--kb-hover) }
.kb-menuitem:active { --kb-mibg: var(--kb-active) }
.kb-card { transition: border-color 0.15s ease, background 0.15s ease }
.kb-card:hover { border-color: var(--dsw-alias-border-l2, #c7ccd4) }
.kb-iconbtn { transition: color 0.15s ease, background 0.15s ease }
.kb-iconbtn:hover { color: var(--dsw-alias-brand-primary, #3b6ef6); background: ${accentSoft} }
/* Buttons styled with style.button get a hover tint like the shell's own
   buttons. The tint rides a CSS variable referenced from the inline
   background, because inline styles outrank plain class rules: on hover the
   variable flips and the inline background follows it. The .kb-panel-in rule
   covers every panel button even without the kb-btn class (the class is only
   required for the settings section, which lives outside the panel). */
.kb-btn { transition: background 0.15s ease, border-color 0.15s ease }
.kb-btn:hover { --kb-btn-bg: var(--kb-hover) }
.kb-btn:disabled:hover { --kb-btn-bg: var(--dsw-alias-bg-layer-1, #ffffff) }
.kb-panel-in button:hover { --kb-btn-bg: var(--kb-hover) }
.kb-panel-in button:disabled:hover { --kb-btn-bg: var(--dsw-alias-bg-layer-1, #ffffff) }
/* Backgrounds live in classes (not inline) so :hover can override them, the
   same way the shell's Settings trigger styles itself. */
.kb-sidebar-action { background: transparent }
.kb-sidebar-action:hover { background: var(--kb-hover) }
.kb-sidebar-action:active { background: var(--kb-active) }
.kb-dangerbtn:hover { color: var(--dsw-alias-state-error-primary, #e5484d); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 10%, transparent) }
/* Primary (accent-filled) buttons: DSH's brand-primary inverts between themes
   (near-black in light, near-white in dark) and ships a dedicated hover token,
   so the hover fill follows that token and stays visible in both. */
.kb-primary { transition: background 0.15s ease, filter 0.15s ease }
.kb-primary:hover:not(:disabled) { --kb-primary-bg: var(--dsw-alias-button-primary-hover, #43454a) }
.kb-primary:active:not(:disabled) { filter: brightness(0.94) }
.kb-primary:disabled { opacity: 0.5; cursor: not-allowed }
.kb-danger-primary { transition: background 0.15s ease, filter 0.15s ease }
.kb-danger-primary:hover:not(:disabled) { --kb-danger-bg: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 78%, #000) }
.kb-danger-primary:active:not(:disabled) { filter: brightness(0.94) }
.kb-danger-primary:disabled { opacity: 0.5; cursor: not-allowed }
/* Disabled feedback for every panel button. */
.kb-panel-in button:disabled { opacity: 0.5; cursor: not-allowed }
/* Visible focus indicators (DSH's business-primary is a blue that reads in
   both themes, unlike the inverted brand-primary). */
.kb-panel-in button:focus-visible, .kb-menuitem:focus-visible, .kb-sidebar-action:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6); outline-offset: 2px }
.kb-panel-in input:focus, .kb-panel-in select:focus, .kb-panel-in textarea:focus { box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 35%, transparent) }
/* Resize sash: an 8px grab strip whose 2px grip lights up on hover so the
   draggable edge is discoverable (a 5px transparent sliver was impossible to
   find/click). z-index keeps it above adjacent scrollbars. */
.kb-sash { position: relative; z-index: 6 }
.kb-sash::before { content: ''; position: absolute; top: 0; bottom: 0; left: 50%; transform: translateX(-50%); width: 2px; background: transparent; transition: background 0.15s ease }
.kb-sash:hover::before { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6ef6) 45%, transparent) }
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
  baseSourceRow: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 14px',
    marginTop: 6, padding: '5px 10px', borderRadius: 8,
    background: 'color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 6%, transparent)',
    fontSize: 11, color: C.muted,
  } as CSSProperties,
  baseSourceItem: { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 } as CSSProperties,
  baseSourceGlyph: {
    display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: C.accent,
  } as CSSProperties,
  baseSourceText: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Consolas, monospace",
  } as CSSProperties,
  baseSourceEdit: { flexShrink: 0 } as CSSProperties,
  main: { flex: 1, minWidth: 0, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 } as CSSProperties,
  card: { border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, padding: 14, position: 'relative' } as CSSProperties,
  cardTitle: { fontSize: 13, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' } as CSSProperties,
  button: {
    display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${C.border}`,
    borderRadius: 8, padding: '6px 12px', background: `var(--kb-btn-bg, ${C.surface})`, color: C.text, cursor: 'pointer', fontSize: 13,
  } as CSSProperties,
  primary: {
    display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid transparent',
    borderRadius: 8, padding: '6px 14px', background: `var(--kb-primary-bg, ${C.accent})`,
    // DSH's brand-primary is near-BLACK in light but near-WHITE in dark; the
    // foreground token inverts with the theme so the label stays readable on
    // the accent fill in both modes (white text on white would vanish in dark).
    color: 'var(--dsw-alias-label-primary-foreground, #fff)', cursor: 'pointer',
    fontSize: 13, fontWeight: 600,
  } as CSSProperties,
  primaryDanger: {
    display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid transparent',
    borderRadius: 8, padding: '6px 14px', background: `var(--kb-danger-bg, ${C.danger})`, color: 'var(--dsw-alias-label-primary-foreground, #fff)', cursor: 'pointer',
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
    position: 'absolute', inset: 0, zIndex: 20, // Less transparent so dialog content stays clearly behind the modal.
    background: 'rgba(0,0,0,0.58)',
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
    // SettingsRoot.module.css) so the two footer rows read as one. Background
    // is set by the .kb-sidebar-action class (hover must be able to override).
    flex: 'none', display: 'flex', alignItems: 'center', gap: 8,
    width: 'calc(100% + 8px)', height: 34,
    margin: '4px -4px 4px', padding: '6px 2px 6px 10px',
    boxSizing: 'border-box', border: 'none', borderRadius: 12,
    cursor: 'pointer', overflow: 'hidden',
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
    display: 'flex', alignItems: 'center', gap: 8, borderRadius: 12, padding: '8px 14px',
    fontSize: 13, fontWeight: 600, background: C.overlay, border: `1px solid ${C.border}`,
    boxShadow: '0 8px 24px rgba(0,0,0,0.14)', color: C.text, maxWidth: 'min(90vw, 560px)',
  } as CSSProperties,
  toastClose: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    width: 20, height: 20, border: 'none', borderRadius: 999, background: 'transparent',
    color: C.muted, cursor: 'pointer', padding: 0, marginLeft: 2,
  } as CSSProperties,
  fileRow: {
    display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${C.border}`,
    borderRadius: 8, padding: '7px 10px', marginBottom: 6, fontSize: 12,
  } as CSSProperties,
  spinner: { display: 'inline-block', width: 14, height: 14, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent' } as CSSProperties,
  menu: {
    position: 'absolute', zIndex: 30, minWidth: 180, borderRadius: 10, padding: 4,
    // Opaque overlay surface (never translucent) with the stronger border tier
    // so the popover separates from the panel in both themes.
    background: C.overlay, border: `1px solid ${C.borderStrong}`, boxShadow: '0 10px 32px rgba(0,0,0,0.22)',
    color: C.text,
  } as CSSProperties,
  menuItem: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', background: 'var(--kb-mibg, transparent)',
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
    position: 'absolute', top: 2, left: 2, width: 16, height: 16, borderRadius: '50%',
    // Contrasts with the accent track in both themes (near-black knob on the
    // near-white accent in dark mode, near-white knob on dark accent in light).
    background: 'var(--dsw-alias-label-primary-foreground, #fff)',
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
  checkboxOn: {
    background: C.accent, borderColor: C.accent,
    color: 'var(--dsw-alias-label-primary-foreground, #fff)',
  } as CSSProperties,
  sidePanelScrim: {
    // Less transparent scrim so the drawer clearly separates from the
    // panel behind it (nothing reads through).
    position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.58)',
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

/**
 * Compact relative time, locale-aware via the bound translate (the old
 * implementation hardcoded Chinese “刚刚 / N 分钟前…” which leaked into the
 * English UI). now is only overridable for tests.
 */
export function formatRelativeTime(
  timestamp: number,
  // Optional so the previous one-arg call keeps compiling on `main` until
  // KnowledgeSection adopts the locale-aware signature in the feature branch.
  // Narrow key union keeps it callable with the bound Translate
  // ((key: KnowledgeKey) => string) while staying decoupled from locales.
  t?: (key: 'timeJustNow' | 'timeMinutes' | 'timeHours' | 'timeDays') => string,
  now: number = Date.now(),
): string {
  const diff = Math.max(0, now - timestamp)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t !== undefined ? t('timeJustNow') : '刚刚'
  if (minutes < 60) return t !== undefined ? t('timeMinutes').replace('{n}', String(minutes)) : `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t !== undefined ? t('timeHours').replace('{n}', String(hours)) : `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return t !== undefined ? t('timeDays').replace('{n}', String(days)) : `${days} 天前`
  return new Date(timestamp).toLocaleDateString()
}
