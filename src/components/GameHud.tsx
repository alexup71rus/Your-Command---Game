import { useMemo } from 'react'
import { resourceIds, troopKinds } from '../config/rules'
import { aiParticipantDisplayName, type LocaleDictionary } from '../config/localization'
import { gameConfig } from '../config/game'
import { armyCapacity, civilianPopulationCapacityFor, totalArmySize, troopTotals, turnEconomyForecastFor, type MatchState } from '../game/match'
import { aiAvatarPaths } from '../config/ai'

interface GameHudProps {
  match: MatchState
  text: LocaleDictionary
  opponentTurn: boolean
  aiBusy: boolean
  aiSlow: boolean
  spectator: boolean
  spectatorParticipantId?: string | null
  previewOrderCost: number
  onEndTurn: () => void
}

export function GameHud({ match, text, opponentTurn, aiBusy, aiSlow, spectator, spectatorParticipantId, previewOrderCost, onEndTurn }: GameHudProps) {
  const domainId = spectator ? spectatorParticipantId ?? match.activeParticipantId : match.playerId
  const domain = match.domains[domainId]
  const forecast = useMemo(() => turnEconomyForecastFor(match, domainId), [domainId, match])
  const turnDelta = Object.fromEntries(resourceIds.map((resource) => [resource, (forecast?.resources[resource] ?? domain.resources[resource]) - domain.resources[resource]])) as Record<(typeof resourceIds)[number], number>
  const troops = troopTotals(match, domainId)
  const workforce = forecast?.workforce ?? { population: domain.population, employed: 0, free: domain.population, assignments: [] }
  const populationCapacity = civilianPopulationCapacityFor(match, domainId)
  const gameOver = match.status !== 'playing'
  const previewedOrders = Math.min(match.ordersRemaining, Math.max(0, previewOrderCost))
  const previewStart = match.ordersRemaining - previewedOrders
  const activeParticipant = match.scenario.participants.find((participant) => participant.id === match.activeParticipantId)
  const activeProfileId = activeParticipant?.kind === 'ai' ? activeParticipant.profileId : undefined
  const activeParticipantName = activeParticipant?.kind === 'ai'
    ? aiParticipantDisplayName(text.opponents, match.scenario.participants, activeParticipant.id)
    : undefined
  const activeAiPhase = activeParticipant?.kind === 'ai' ? match.aiMemory[activeParticipant.id]?.phase : undefined
  const viewedParticipant = spectator ? match.scenario.participants.find((participant) => participant.id === domainId) : undefined
  const viewedProfileId = viewedParticipant?.kind === 'ai' ? viewedParticipant.profileId : undefined
  const viewedParticipantName = viewedParticipant?.kind === 'ai'
    ? aiParticipantDisplayName(text.opponents, match.scenario.participants, viewedParticipant.id)
    : undefined
  const activeAiStatus = aiSlow
    ? text.hud.longThinking
    : activeAiPhase
      ? text.hud.aiPhase[activeAiPhase]
      : aiBusy ? text.hud.thinking : text.game.opponentTurn
  return (
    <>
      {(!spectator || spectatorParticipantId) && <header className="hud" aria-label={text.hud.state}>
        <section className="hud-panel resource-panel" aria-label={viewedParticipantName ? `${text.hud.resources}: ${viewedParticipantName}` : text.hud.resources}>
          <div className="resource-panel-content">
            {viewedParticipant && viewedProfileId && viewedParticipantName && <div className="hud-ruler" title={viewedParticipantName}><img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[viewedProfileId]}`} alt="" style={{ borderColor: viewedParticipant.color }} /><span><small>{text.hud.viewingRuler}</small><strong>{viewedParticipantName}</strong></span></div>}
            <dl className="compact-status-list">
              {resourceIds.map((resource) => <div key={resource}><dt>{text.game.resourceNames[resource]}</dt><dd>{domain.resources[resource]}</dd>{turnDelta[resource] !== 0 && <small className={turnDelta[resource] < 0 ? 'negative' : ''}>{turnDelta[resource] > 0 ? '+' : ''}{turnDelta[resource]}</small>}</div>)}
            </dl>
            <div className={`population-summary${domain.diverseDiet ? ' diverse' : ''}`} title={domain.diverseDiet ? text.hud.diverseDiet : undefined}><div><span>{text.hud.people}</span><strong>{domain.population}<small>/{populationCapacity}</small></strong></div><small>{text.hud.workers} {workforce.employed} · {text.hud.freePeople} {workforce.free}</small></div>
          </div>
        </section>
        <section className="hud-panel army-panel" aria-label={text.hud.army}>
          <dl className="compact-status-list troop-list">
            {troopKinds.map((troop) => <div key={troop}><dt>{text.game.troopNames[troop]}</dt><dd>{troops[troop]}</dd></div>)}
            <div className="army-total"><dt>{text.game.armyLimit}</dt><dd>{totalArmySize(match, domainId)}/{armyCapacity}</dd></div>
          </dl>
        </section>
      </header>}
      <section className={`hud-panel turn-panel${opponentTurn ? ' opponent-turn' : ''}`} aria-label={text.hud.turn} aria-busy={opponentTurn}>
        {activeProfileId && <div className="active-opponent"><img src={`${import.meta.env.BASE_URL}${aiAvatarPaths[activeProfileId]}`} alt="" /><span><strong>{activeParticipantName}</strong><small>{activeAiStatus}</small></span></div>}
        <div className="current-turn"><span>{text.hud.turn}</span><strong>{match.turn}</strong></div>
        <div className="order-status">
          <div className="order-markers" aria-label={`${text.hud.ordersAvailable}: ${match.ordersRemaining}${previewedOrders ? `. ${text.game.cost}: ${previewedOrders}` : ''}`}>
            {Array.from({ length: gameConfig.turn.maxOrders }, (_, index) => {
              const spent = index >= match.ordersRemaining
              const previewed = !spent && index >= previewStart
              return <span key={index} className={`order-marker${spent ? ' spent' : previewed ? ' preview' : ''}`} aria-hidden="true" />
            })}
          </div>
        </div>
        {spectator
          ? <div className="turn-end-button spectator-status" aria-label={text.hud.spectator}><span>{text.game.autoBattle}</span><b aria-hidden="true">…</b></div>
          : <button type="button" className={`turn-end-button${match.ordersRemaining > 0 ? ' unfinished' : ''}`} disabled={opponentTurn || gameOver} onClick={onEndTurn} title={opponentTurn || gameOver ? undefined : text.game.endTurnHint}><span>{opponentTurn ? text.game.opponentTurn : text.game.endTurn}</span><b aria-hidden="true">{opponentTurn ? '…' : '→'}</b></button>}
      </section>
    </>
  )
}
