import { useState } from 'react'
import { aiAvatarPaths, aiProfiles } from '../config/ai'
import type { LocaleDictionary } from '../config/localization'
import { aiProfileIds } from '../game/ai/model'
import type { AiProfileId } from '../game/scenario'
import { useModalFocus } from '../hooks/useModalFocus'

interface OpponentSetupModalProps {
  text: LocaleDictionary['opponents']
  selected: AiProfileId[]
  onClose: () => void
  onConfirm: (profiles: AiProfileId[]) => void
  maxOpponents: number
}

export function OpponentSetupModal({ text, selected, onClose, onConfirm, maxOpponents }: OpponentSetupModalProps) {
  const modalRef = useModalFocus<HTMLElement>()
  const [draft, setDraft] = useState<AiProfileId[]>(selected.slice(0, maxOpponents))
  const add = (profileId: AiProfileId) => {
    if (draft.includes(profileId) || draft.length >= maxOpponents) return
    setDraft((current) => [...current, profileId])
  }
  const remove = (profileId: AiProfileId) => {
    if (draft.length <= 1) return
    setDraft((current) => current.filter((candidate) => candidate !== profileId))
  }
  return (
    <div className="modal-backdrop opponent-setup-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={modalRef} tabIndex={-1} className="opponent-setup-modal" role="dialog" aria-modal="true" aria-labelledby="opponent-setup-title">
        <button type="button" className="modal-close" aria-label={text.close} onClick={onClose}>×</button>
        <header><span>{text.kicker}</span><h2 id="opponent-setup-title">{text.title}</h2><p>{text.description}</p></header>
        <div className="round-table-layout" aria-label={text.selected}>
          <div className="round-table" aria-hidden="true"><span /></div>
          <article className="round-table-seat player-seat"><div className="player-seat-mark">{text.playerMark}</div><strong>{text.player}</strong><small>{text.playerDescription}</small></article>
          {draft.map((profileId, index) => {
            const profile = aiProfiles[profileId]
            const copy = text.profiles[profileId]
            return <article key={profileId} className={`round-table-seat opponent-seat seat-${index + 1}`}><img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[profileId]}`} alt="" /><span><strong>{copy.name}</strong><small>{text.arsenal[profile.arsenalTier]}</small></span><button type="button" disabled={draft.length <= 1} aria-label={`${text.removeOpponent}: ${copy.name}`} onClick={() => remove(profileId)}>×</button></article>
          })}
        </div>
        <div className="opponent-roster"><h3>{text.choose}</h3><p className="opponent-map-capacity">{text.mapCapacity.replace('{count}', String(maxOpponents))}</p><div className="opponent-roster-grid">
          {aiProfileIds.map((profileId) => {
            const profile = aiProfiles[profileId]
            const copy = text.profiles[profileId]
            const active = draft.includes(profileId)
            return <button type="button" key={profileId} className={`opponent-card${active ? ' selected' : ''}`} aria-pressed={active} disabled={!active && draft.length >= maxOpponents} onClick={() => active ? remove(profileId) : add(profileId)}>
              <img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[profileId]}`} alt="" />
              <span className="opponent-card-copy"><i>{text.arsenal[profile.arsenalTier]}</i><strong>{copy.name}</strong><small>{copy.strategy}</small><em>{copy.toolkit}</em></span>
            </button>
          })}
        </div></div>
        <footer><span>{draft.length} / {maxOpponents}</span><button type="button" className="primary" data-modal-autofocus onClick={() => onConfirm(draft)}>{text.confirm}<b aria-hidden="true">→</b></button></footer>
      </section>
    </div>
  )
}
