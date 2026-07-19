import { useId, type KeyboardEvent, type PointerEvent } from 'react'
import { useModalFocus } from '../../hooks/useModalFocus'

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
  const modalRef = useModalFocus<HTMLElement>()

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
  }

  const handleBackdropPointer = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.target === event.currentTarget) onCancel()
  }

  return (
    <div className="confirm-backdrop" onPointerDown={handleBackdropPointer} onKeyDownCapture={handleKeyDown}>
      <section ref={modalRef} tabIndex={-1} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <div className="confirm-symbol" aria-hidden="true">!</div>
        <div className="confirm-copy"><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div>
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel} data-modal-autofocus>{cancelLabel}</button>
          <button type="button" className="confirm-danger danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  )
}
