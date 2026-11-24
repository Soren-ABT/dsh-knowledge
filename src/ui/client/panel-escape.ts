/** DSH orders dialogs and body-portaled menus by document order. Include the
 * panel's smaller popups so one key press dismisses only the foreground layer. */
const layers = '[aria-modal="true"]:is([role="dialog"], [role="alertdialog"]), [role="menu"], [data-kb-popup]'

export function listenForEscape(layer: HTMLElement | null, dismiss: () => void): (() => void) | undefined {
  if (layer === null) return
  const doc = layer.ownerDocument
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229
        || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    // A native modal occupies the browser's top layer regardless of DOM order.
    if (doc.querySelector('dialog:modal')) return
    const foreground = Array.from(doc.querySelectorAll<HTMLElement>(layers)).reverse().find(element =>
      !element.closest('[hidden], [inert], [aria-hidden="true"]')
      && element.checkVisibility?.({ visibilityProperty: true }) !== false)
    if (foreground !== layer) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) dismiss()
  }
  doc.addEventListener('keydown', onKey)
  return () => doc.removeEventListener('keydown', onKey)
}
