import { useEffect, useId, useRef, useState } from 'react'

export interface SelectOption<Value extends string> {
  value: Value
  label: string
}

interface SelectFieldProps<Value extends string> {
  label: string
  value: Value
  options: SelectOption<Value>[]
  onChange: (value: Value) => void
}

export function SelectField<Value extends string>({ label, value, options, onChange }: SelectFieldProps<Value>) {
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)))
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selected = options[selectedIndex]

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [])

  const openList = (index = selectedIndex) => {
    setHighlightedIndex(index)
    setOpen(true)
  }

  const choose = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setHighlightedIndex(index)
    setOpen(false)
    buttonRef.current?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      if (!open) openList((selectedIndex + direction + options.length) % options.length)
      else setHighlightedIndex((current) => (current + direction + options.length) % options.length)
      return
    }
    if (event.key === 'Home' && open) { event.preventDefault(); setHighlightedIndex(0); return }
    if (event.key === 'End' && open) { event.preventDefault(); setHighlightedIndex(options.length - 1); return }
    if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault()
      choose(highlightedIndex)
    }
  }

  return (
    <div className="ui-select-field" ref={rootRef} onKeyDown={handleKeyDown}>
      <span className="ui-select-label">{label}</span>
      <button
        ref={buttonRef}
        type="button"
        className={`ui-select-trigger${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => open ? setOpen(false) : openList()}
      >
        <span>{selected?.label}</span><i aria-hidden="true" />
      </button>
      {open && (
        <div className="ui-select-options" id={listboxId} role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`${option.value === value ? 'selected ' : ''}${index === highlightedIndex ? 'highlighted' : ''}`.trim()}
              key={option.value}
              onPointerEnter={() => setHighlightedIndex(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span><i aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
