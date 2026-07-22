import type { ButtonHTMLAttributes } from 'react'
import { CloseIcon } from '../InterfaceIcons'

interface ModalCloseButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  label: string
}

export function ModalCloseButton({ label, className = '', ...props }: ModalCloseButtonProps) {
  return (
    <button
      type="button"
      className={`modal-close-button${className ? ` ${className}` : ''}`}
      aria-label={label}
      {...props}
    >
      <CloseIcon />
    </button>
  )
}
