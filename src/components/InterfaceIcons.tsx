interface SoundIconProps {
  muted?: boolean
}

export function SoundIcon({ muted = false }: SoundIconProps) {
  return (
    <svg className="interface-icon sound-svg" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 8h3l4-3.25v10.5L6.5 12h-3z" />
      {muted ? (
        <path d="m13 8 4 4m0-4-4 4" />
      ) : (
        <>
          <path d="M13 7.25a4 4 0 0 1 0 5.5" />
          <path d="M15.35 5a7 7 0 0 1 0 10" />
        </>
      )}
    </svg>
  )
}

export function CloseIcon() {
  return (
    <svg className="interface-icon close-svg" viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.5 5.5 9 9m0-9-9 9" />
    </svg>
  )
}
