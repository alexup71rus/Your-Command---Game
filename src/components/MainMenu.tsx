import type { ReactNode } from 'react'
import type { LocaleDictionary } from '../config/localization'

type MainMenuScreen = 'welcome' | 'modes'
type ModeId = keyof LocaleDictionary['mainMenu']['modes']

interface MainMenuProps {
  screen: MainMenuScreen
  text: LocaleDictionary['mainMenu']
  utilityControls: ReactNode
  onContinue: () => void
  onBack: () => void
  onSelectBattle: () => void
}

function MenuBackdrop({ eager = false }: { eager?: boolean }) {
  return (
    <>
      <img className="main-menu-hero" src={`${import.meta.env.BASE_URL}assets/start-menu-hero.webp`} alt="" aria-hidden="true" fetchPriority={eager ? 'high' : 'auto'} />
      <div className="main-menu-atmosphere" aria-hidden="true" />
    </>
  )
}

function ModeEmblem({ mode }: { mode: ModeId }) {
  if (mode === 'story') {
    return <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M13 14c8-2 14 0 19 5v32c-5-5-11-7-19-5V14Z" /><path d="M51 14c-8-2-14 0-19 5v32c5-5 11-7 19-5V14Z" /><path d="M19 23h7M19 30h7M38 23h7M38 30h7" /></svg>
  }
  if (mode === 'economy') {
    return <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M15 50h34M20 50V28h24v22M25 28V17h14v11M29 17v-5h6v5" /><path d="M27 50V38h10v12M17 39h7M40 39h7" /><circle cx="46" cy="18" r="8" /><path d="M43 18h6M46 15v6" /></svg>
  }
  if (mode === 'siege') {
    return <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 12h28v19c0 11-6 18-14 22-8-4-14-11-14-22V12Z" /><path d="m25 39 14-14M29 21l10 4-4 10M22 42l6-2-4-4-2 6Z" /></svg>
  }
  return <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 51h20V25l-5-5-5 5-5-5-5 5v26ZM36 51h20V25l-5-5-5 5-5-5-5 5v26Z" /><path d="M15 51V38h7v13M43 51V38h7v13M27 33h10M32 28v10" /></svg>
}

export function MainMenu({ screen, text, utilityControls, onContinue, onBack, onSelectBattle }: MainMenuProps) {
  if (screen === 'welcome') {
    return (
      <main className="welcome-screen">
        <MenuBackdrop eager />
        <button type="button" className="welcome-entry" onClick={onContinue} aria-label={text.continue}>
          <span className="welcome-crest" aria-hidden="true"><ModeEmblem mode="battle" /></span>
          <span className="welcome-eyebrow">{text.eyebrow}</span>
          <strong>{text.title}</strong>
          <span className="welcome-tagline">{text.tagline}</span>
          <span className="welcome-prompt"><i aria-hidden="true" />{text.continue}<i aria-hidden="true" /></span>
          <small>{text.continueHint}</small>
        </button>
      </main>
    )
  }

  const modes = (Object.keys(text.modes) as ModeId[]).map((id) => ({ id, copy: text.modes[id], available: id === 'battle' }))

  return (
    <main className="mode-screen">
      <MenuBackdrop />
      <section className="mode-menu" aria-labelledby="mode-menu-title">
        <header className="mode-menu-header">
          <button type="button" className="menu-back-button" onClick={onBack}><span aria-hidden="true">←</span>{text.back}</button>
          <div><span>{text.modeEyebrow}</span><h1 id="mode-menu-title">{text.modeTitle}</h1><p>{text.modeDescription}</p></div>
          <div className="mode-utility-slot">{utilityControls}</div>
        </header>

        <div className="mode-grid">
          {modes.map(({ id, copy, available }, index) => (
            <button key={id} type="button" className={`mode-card mode-${id}${available ? ' available' : ''}`} disabled={!available} onClick={available ? onSelectBattle : undefined}>
              <span className="mode-number" aria-hidden="true">0{index + 1}</span>
              <span className="mode-emblem"><ModeEmblem mode={id} /></span>
              <span className="mode-card-copy"><span className="mode-status">{available ? text.available : text.comingSoon}</span><strong>{copy.title}</strong><small>{copy.description}</small></span>
              <span className="mode-card-action" aria-hidden="true">{available ? text.select : text.inDevelopment}<b>{available ? '→' : '·'}</b></span>
            </button>
          ))}
        </div>
      </section>
    </main>
  )
}
