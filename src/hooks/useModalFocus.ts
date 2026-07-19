import { useLayoutEffect, useRef, type RefObject } from 'react'

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}

function isTopmostModal(root: HTMLElement) {
  const modals = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
  return modals.at(-1) === root
}

/** Keeps keyboard focus inside the topmost modal and restores it on close. */
export function useModalFocus<T extends HTMLElement>(): RefObject<T | null> {
  const modalRef = useRef<T>(null)

  useLayoutEffect(() => {
    const modal = modalRef.current
    if (!modal) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusFirst = () => {
      const preferred = modal.querySelector<HTMLElement>('[data-modal-autofocus]')
      const target = preferred ?? focusableElements(modal)[0] ?? modal
      target.focus({ preventScroll: true })
    }

    const animationFrame = window.requestAnimationFrame(focusFirst)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !isTopmostModal(modal)) return
      const focusable = focusableElements(modal)
      if (focusable.length === 0) {
        event.preventDefault()
        modal.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    const handleFocusIn = (event: FocusEvent) => {
      if (isTopmostModal(modal) && event.target instanceof Node && !modal.contains(event.target)) focusFirst()
    }

    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('focusin', handleFocusIn, true)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('focusin', handleFocusIn, true)
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true })
    }
  }, [])

  return modalRef
}
