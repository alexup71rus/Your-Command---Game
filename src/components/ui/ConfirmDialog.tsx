import { useEffect, useId, useRef, type KeyboardEvent, type PointerEvent } from 'react'

interface ConfirmDialogProps {
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({ title, description, cancelLabel, confirmLabel, onCancel, onConfirm }: ConfirmDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { cancelRef.current?.focus() }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return
    if (event.shiftKey && document.activeElement === cancelRef.current) {
      event.preventDefault()
      confirmRef.current?.focus()
    } else if (!event.shiftKey && document.activeElement === confirmRef.current) {
      event.preventDefault()
      cancelRef.current?.focus()
    }
  }

  const handleBackdropPointer = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.target === event.currentTarget) onCancel()
  }

  return (
    <div className="confirm-backdrop" onPointerDown={handleBackdropPointer} onKeyDownCapture={handleKeyDown}>
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <div className="confirm-symbol" aria-hidden="true">!</div>
        <div className="confirm-copy"><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="confirm-cancel" onClick={onCancel}>{cancelLabel}</button>
          <button ref={confirmRef} type="button" className="confirm-danger danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  )
}
