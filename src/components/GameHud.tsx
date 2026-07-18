import { resourceIds, troopKinds } from '../config/rules'
import type { LocaleDictionary } from '../config/localization'
import { gameConfig } from '../config/game'
import { humanDomain, troopTotals, turnResourceDeltaFor, type MatchState } from '../game/match'

interface GameHudProps {
  match: MatchState
  text: LocaleDictionary
  opponentTurn: boolean
  onEndTurn: () => void
}

export function GameHud({ match, text, opponentTurn, onEndTurn }: GameHudProps) {
  const domain = humanDomain(match)
  const turnDelta = turnResourceDeltaFor(match, match.playerId)
  const troops = troopTotals(match, match.playerId)
  return (
    <>
      <header className="hud" aria-label={text.hud.state}>
        <section className="hud-panel resource-panel" aria-label={text.hud.resources}>
          <h2>{text.hud.resources}</h2>
          <div className="resource-panel-content">
            <dl className="compact-status-list">
              {resourceIds.map((resource) => <div key={resource}><dt>{text.game.resourceNames[resource]}</dt><dd>{domain.resources[resource]}</dd>{turnDelta[resource] !== 0 && <small className={turnDelta[resource] < 0 ? 'negative' : ''}>{turnDelta[resource] > 0 ? '+' : ''}{turnDelta[resource]}</small>}</div>)}
            </dl>
            <div className="population-summary"><span>{text.hud.people}</span><strong>{domain.population}<small>/{domain.populationCapacity}</small></strong></div>
          </div>
        </section>
        <section className="hud-panel army-panel" aria-label={text.hud.army}>
          <h2>{text.hud.army}</h2>
          <dl className="compact-status-list troop-list">
            {troopKinds.map((troop) => <div key={troop}><dt>{text.game.troopNames[troop]}</dt><dd>{troops[troop]}</dd></div>)}
          </dl>
        </section>
      </header>
      <section className={`hud-panel turn-panel${opponentTurn ? ' opponent-turn' : ''}`} aria-label={text.hud.turn} aria-busy={opponentTurn}>
        <div className="current-turn"><span>{text.hud.turn}</span><strong>{match.turn}</strong></div>
        <div className="order-status">
          <div className="order-markers" aria-label={`${text.hud.ordersAvailable}: ${match.ordersRemaining}`}>
            {Array.from({ length: gameConfig.turn.maxOrders }, (_, index) => <span key={index} className={`order-marker${index >= match.ordersRemaining ? ' spent' : ''}`} aria-hidden="true" />)}
          </div>
        </div>
        <button type="button" className={`turn-end-button${match.ordersRemaining > 0 ? ' unfinished' : ''}`} disabled={opponentTurn} onClick={onEndTurn} title={opponentTurn ? undefined : text.game.endTurnHint}><span>{opponentTurn ? text.game.opponentTurn : text.game.endTurn}</span><b aria-hidden="true">{opponentTurn ? '…' : '→'}</b></button>
      </section>
    </>
  )
}
