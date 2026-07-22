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

export function MainMenu({ screen, text, utilityControls, onContinue, onBack, onSelectBattle }: MainMenuProps) {
  const modes = (Object.keys(text.modes) as ModeId[]).map((id) => ({ id, copy: text.modes[id], available: id === 'battle' }))

  return (
    <main className={`main-menu-stage screen-${screen}`}>
      <MenuBackdrop eager />

      <section className={`welcome-screen menu-panel${screen === 'welcome' ? ' active' : ''}`} aria-hidden={screen !== 'welcome'} inert={screen !== 'welcome'}>
        <button type="button" className="welcome-entry" onClick={onContinue} aria-label={text.continue}>
          <span className="welcome-brand">
            <span className="welcome-crest" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}favicon.png`} alt="" /></span>
            <span className="welcome-wordmark"><span className="welcome-eyebrow">{text.eyebrow}</span><strong>{text.title}</strong></span>
          </span>
          <span className="welcome-tagline">{text.tagline}</span>
          <span className="welcome-prompt"><i aria-hidden="true" />{text.continue}<i aria-hidden="true" /></span>
        </button>
      </section>

      <section className={`mode-screen menu-panel${screen === 'modes' ? ' active' : ''}`} aria-hidden={screen !== 'modes'} inert={screen !== 'modes'}>
        <div className="mode-menu" aria-labelledby="mode-menu-title">
        <header className="mode-menu-header">
          <button type="button" className="menu-back-button" onClick={onBack}><span aria-hidden="true">←</span>{text.back}</button>
          <h1 id="mode-menu-title">{text.modeTitle}</h1>
        </header>

        <nav className="mode-selector" aria-label={text.modeTitle}>
          {modes.map(({ id, copy, available }) => (
            <button
              key={id}
              type="button"
              className={`mode-option mode-${id}${available ? ' available' : ' unavailable'}`}
              aria-disabled={!available}
              onClick={available ? onSelectBattle : undefined}
            >
              <span className="mode-scene" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}assets/modes/${id}.webp`} alt="" decoding="async" /></span>
              <span className="mode-sigil" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}assets/mode-icons/${id}.webp`} alt="" decoding="async" /></span>
              <span className="mode-option-copy"><strong>{copy.title}</strong><small>{copy.description}</small></span>
              <span className="mode-option-action" aria-hidden="true"><span>{available ? text.select : text.inDevelopment}</span>{available && <b>→</b>}</span>
            </button>
          ))}
        </nav>
        <div className="mode-utility-slot">{utilityControls}</div>
        </div>
      </section>
    </main>
  )
}
