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
  onModeHover: () => void
}

function MenuBackdrop({ eager = false }: { eager?: boolean }) {
  return (
    <>
      <img className="main-menu-hero" src={`${import.meta.env.BASE_URL}assets/start-menu-hero.webp`} alt="" aria-hidden="true" fetchPriority={eager ? 'high' : 'auto'} />
      <div className="main-menu-atmosphere" aria-hidden="true" />
    </>
  )
}

export function MainMenu({ screen, text, utilityControls, onContinue, onBack, onSelectBattle, onModeHover }: MainMenuProps) {
  if (screen === 'welcome') {
    return (
      <main className="welcome-screen">
        <MenuBackdrop eager />
        <button type="button" className="welcome-entry" onClick={onContinue} aria-label={text.continue}>
          <span className="welcome-brand">
            <span className="welcome-crest" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}favicon.png`} alt="" /></span>
            <span className="welcome-wordmark"><span className="welcome-eyebrow">{text.eyebrow}</span><strong>{text.title}</strong></span>
          </span>
          <span className="welcome-tagline">{text.tagline}</span>
          <span className="welcome-prompt"><i aria-hidden="true" />{text.continue}<i aria-hidden="true" /></span>
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
          <div><h1 id="mode-menu-title">{text.modeTitle}</h1><p>{text.modeDescription}</p></div>
        </header>

        <div className="mode-grid">
          {modes.map(({ id, copy, available }) => (
            <div key={id} className="mode-card-slot" onPointerEnter={onModeHover}>
              <button type="button" className={`mode-card mode-${id}${available ? ' available' : ''}`} disabled={!available} onClick={available ? onSelectBattle : undefined}>
                <span className="mode-artwork" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}assets/modes/${id}.webp`} alt="" decoding="async" /></span>
                <span className="mode-card-copy"><strong>{copy.title}</strong><small>{copy.description}</small></span>
                <span className="mode-card-action" aria-hidden="true">{available ? text.select : text.inDevelopment}<b>{available ? '→' : '·'}</b></span>
              </button>
            </div>
          ))}
        </div>
        <div className="mode-utility-slot">{utilityControls}</div>
      </section>
    </main>
  )
}
