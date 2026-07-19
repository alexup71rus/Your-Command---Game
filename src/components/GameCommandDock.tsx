import { useRef, useState } from 'react'
import type { LocaleDictionary, TabId } from '../config/localization'
import { buildingRules, defaultTaxRate, economyBuildingKinds, fortificationKinds, marketPrices, resourceIds, tradeableResources, troopKinds, troopRules, type TaxRate } from '../config/rules'
import { gameConfig } from '../config/game'
import type { PendingGameAction } from '../game/interaction'
import type { BuildingKind, ResourceId, TroopComposition, TroopKind } from '../game/map'
import { endTurn, foodDemandFor, humanDomain, maxSquadHealth, objectAt, squadHealth, squadSize, taxIncomeFor, turnResourceDeltaFor, upkeepFor, type MatchState } from '../game/match'
import type { CellPosition } from '../game/scenario'

interface GameCommandDockProps {
  match: MatchState
  selectedCell: CellPosition | null
  activeTab: TabId
  pendingAction: PendingGameAction | null
  locked: boolean
  text: LocaleDictionary
  feedback: string | null
  onTabChange: (tab: TabId) => void
  onChooseBuild: (kind: BuildingKind) => void
  onChooseRecruit: (troop: TroopKind, quantity: number) => void
  onSplit: (source: CellPosition) => void
  onSplitChange: (units: TroopComposition) => void
  onCancelAction: () => void
  onSetTaxRate: (rate: TaxRate) => void
  onTrade: (position: CellPosition, resource: Exclude<ResourceId, 'gold'>, direction: 'buy' | 'sell', quantity: number) => void
}

function Cost({ cost, text, multiplier = 1 }: { cost: Partial<Record<ResourceId, number>>; text: LocaleDictionary; multiplier?: number }) {
  return <span className="command-cost">{resourceIds.filter((resource) => cost[resource]).map((resource) => <small key={resource}><b>{(cost[resource] ?? 0) * multiplier}</b> {text.game.resourceNames[resource]}</small>)}</span>
}

function SelectionSummary({ match, position, text, locked, onSplit }: { match: MatchState; position: CellPosition | null; text: LocaleDictionary; locked: boolean; onSplit: (source: CellPosition) => void }) {
  if (!position) return <aside className="selection-summary empty"><span>{text.game.selectedCell}</span><p>{text.game.selectCell}</p></aside>
  const cell = match.scenario.cells[position.row]?.[position.column]
  const object = objectAt(match, position)
  const terrain = cell?.vegetation ? text.game.terrainForest : cell?.landform === 'hill' ? text.game.terrainHill : text.game.terrainPlain
  const owned = object?.ownerId === match.playerId
  const title = !object ? text.game.emptyCell : object.type === 'castle' ? text.game.castle : object.type === 'building' ? text.game.buildingNames[object.kind] : text.game.squad
  const squadEndurance = object?.type === 'squad' ? squadHealth(object) : 0
  const maxEndurance = object?.type === 'squad' ? maxSquadHealth(object) : 0
  const formatEndurance = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1)
  return (
    <aside className="selection-summary">
      <span>{text.game.selectedCell} · {position.column + 1}:{position.row + 1}</span>
      <h3>{title}</h3>
      <p>{terrain}{object ? ` · ${owned ? text.game.ownObject : text.game.enemyObject}` : ''}</p>
      {object?.type === 'squad' && <div className="selection-unit-line">{troopKinds.map((kind) => (object.units[kind] ?? 0) > 0 && <small key={kind}>{text.game.troopNames[kind]} <b>{object.units[kind]}</b></small>)}</div>}
      {object?.type === 'squad' && <div className="selection-health squad-health"><i style={{ width: `${maxEndurance > 0 ? Math.max(0, squadEndurance / maxEndurance * 100) : 0}%` }} /><small>{text.game.squadHealth} {formatEndurance(squadEndurance)}/{formatEndurance(maxEndurance)}</small></div>}
      {(object?.type === 'building' || object?.type === 'castle') && <div className="selection-health"><i style={{ width: `${Math.max(0, object.hitPoints / object.maxHitPoints * 100)}%` }} /><small>{text.game.hitPoints} {object.hitPoints}/{object.maxHitPoints}</small></div>}
      {object?.type === 'squad' && owned && !locked && <p className={`selection-guidance${squadSize(object) > 1 ? ' with-action' : ''}`}><b aria-hidden="true">↗</b>{(object.units.archers ?? 0) > 0 ? text.game.archerRangeHint : (object.units.knights ?? 0) > 0 ? text.game.knightMoveHint : text.game.moveHint}</p>}
      {object?.type === 'squad' && owned && squadSize(object) > 1 && <button type="button" className="selection-action" disabled={locked} onClick={() => onSplit(position)}>{text.game.split} · {gameConfig.turn.squadReorganizationOrderCost} ◆</button>}
    </aside>
  )
}

function ActionModePanel({ match, action, text, onSplitChange, onCancel }: { match: MatchState; action: PendingGameAction; text: LocaleDictionary; onSplitChange: (units: TroopComposition) => void; onCancel: () => void }) {
  if (action.kind === 'split') {
    const squad = objectAt(match, action.source)
    const available = squad?.type === 'squad' ? squad.units : { militia: 0, spearmen: 0, archers: 0, knights: 0 }
    const selected = squadSize({ units: action.units })
    return <section className="action-mode-panel"><div className="action-mode-copy"><span>{text.game.splitMode}</span><strong>{selected} / {squad?.type === 'squad' ? squadSize(squad) : 0}</strong><p>{text.game.splitHint}</p></div><div className="split-composition">{troopKinds.map((kind) => <div key={kind}><span>{text.game.troopNames[kind]}</span><button type="button" onClick={() => onSplitChange({ ...action.units, [kind]: Math.max(0, (action.units[kind] ?? 0) - 1) })}>−</button><b>{action.units[kind] ?? 0}</b><button type="button" onClick={() => onSplitChange({ ...action.units, [kind]: Math.min(available[kind] ?? 0, (action.units[kind] ?? 0) + 1) })}>+</button></div>)}</div><button type="button" className="cancel-command" onClick={onCancel}>{text.game.cancel}</button></section>
  }
  const title = action.kind === 'build' ? text.game.placementMode : text.game.recruitmentMode
  const name = action.kind === 'build' ? text.game.buildingNames[action.building] : `${text.game.troopNames[action.troop]} × ${action.quantity}`
  const hint = action.kind === 'build' ? text.game.buildHint : text.game.recruitHint
  return <section className="action-mode-panel"><div className="action-mode-copy"><span>{title}</span><strong>{name}</strong><p>{hint}</p></div><div className="placement-mark" aria-hidden="true">◆</div><button type="button" className="cancel-command" onClick={onCancel}>{text.game.cancel}</button></section>
}

function BuildingsPanel({ match, text, locked, onChoose }: { match: MatchState; text: LocaleDictionary; locked: boolean; onChoose: (kind: BuildingKind) => void }) {
  const carouselRef = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ start: true, end: false })
  const domain = humanDomain(match)
  const canAfford = (kind: BuildingKind) => !locked && resourceIds.every((resource) => domain.resources[resource] >= (buildingRules[kind].resourceCost[resource] ?? 0)) && match.ordersRemaining >= buildingRules[kind].actionCost
  const syncEdge = (element: HTMLDivElement) => setEdge({ start: element.scrollLeft <= 1, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1 })
  const scroll = (direction: -1 | 1) => {
    const carousel = carouselRef.current
    const card = carousel?.querySelector<HTMLElement>(':scope > button')
    if (!carousel || !card) return
    carousel.scrollBy({ left: direction * (card.getBoundingClientRect().width + 7), behavior: 'smooth' })
  }
  return <div className="command-carousel"><button type="button" className="carousel-arrow previous" disabled={edge.start} aria-label={text.game.previousItems} onClick={() => scroll(-1)}>‹</button><div ref={carouselRef} className="command-card-grid building-command-grid" onScroll={(event) => syncEdge(event.currentTarget)}>{economyBuildingKinds.map((kind) => <button type="button" key={kind} disabled={!canAfford(kind)} onClick={() => onChoose(kind)}><span><strong>{text.game.buildingNames[kind]}</strong><small>{text.game.buildingDescriptions[kind]}</small></span><Cost cost={buildingRules[kind].resourceCost} text={text} /><em>{buildingRules[kind].actionCost} ◆</em></button>)}</div><button type="button" className="carousel-arrow next" disabled={edge.end} aria-label={text.game.nextItems} onClick={() => scroll(1)}>›</button></div>
}

function BarracksPanel({ match, text, locked, onChoose }: { match: MatchState; text: LocaleDictionary; locked: boolean; onChoose: (troop: TroopKind, quantity: number) => void }) {
  const [quantity, setQuantity] = useState(1)
  const carouselRef = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ start: true, end: false })
  const domain = humanDomain(match)
  const syncEdge = (element: HTMLDivElement) => setEdge({ start: element.scrollLeft <= 1, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1 })
  const scroll = (direction: -1 | 1) => {
    const carousel = carouselRef.current
    const card = carousel?.querySelector<HTMLElement>(':scope > button')
    if (!carousel || !card) return
    carousel.scrollBy({ left: direction * (card.getBoundingClientRect().width + 7), behavior: 'smooth' })
  }
  return <div className="troop-recruit-layout"><div className="quantity-picker"><span>{text.game.quantity}</span><div><button type="button" onClick={() => setQuantity((current) => Math.max(1, current - 1))}>−</button><strong>{quantity}</strong><button type="button" onClick={() => setQuantity((current) => Math.min(gameConfig.turn.squadCapacity, current + 1))}>+</button></div><small>1–{gameConfig.turn.squadCapacity}</small></div><div className="command-carousel troop-command-carousel"><button type="button" className="carousel-arrow previous" disabled={edge.start} aria-label={text.game.previousTroops} onClick={() => scroll(-1)}>‹</button><div ref={carouselRef} className="command-card-grid troop-command-grid" onScroll={(event) => syncEdge(event.currentTarget)}>{troopKinds.map((troop) => {
    const rule = troopRules[troop]
    const maxByResources = resourceIds.reduce((max, resource) => {
      const cost = rule.resourceCost[resource] ?? 0
      return cost > 0 ? Math.min(max, Math.floor(domain.resources[resource] / cost)) : max
    }, Math.min(gameConfig.turn.squadCapacity, domain.population))
    return <button type="button" key={troop} disabled={locked || maxByResources < quantity || match.ordersRemaining < rule.actionCost} onClick={() => onChoose(troop, quantity)}><span><strong>{text.game.troopNames[troop]} <i>×{quantity}</i></strong><small>{text.game.troopDescriptions[troop]}</small></span><Cost cost={rule.resourceCost} text={text} multiplier={quantity} /><em>{rule.actionCost} ◆</em></button>
  })}</div><button type="button" className="carousel-arrow next" disabled={edge.end} aria-label={text.game.nextTroops} onClick={() => scroll(1)}>›</button></div></div>
}

function FortificationsPanel({ match, text, locked, onChoose }: { match: MatchState; text: LocaleDictionary; locked: boolean; onChoose: (kind: BuildingKind) => void }) {
  const domain = humanDomain(match)
  const canAfford = (kind: BuildingKind) => !locked && resourceIds.every((resource) => domain.resources[resource] >= (buildingRules[kind].resourceCost[resource] ?? 0)) && match.ordersRemaining >= buildingRules[kind].actionCost
  return <div className="command-card-grid fortification-command-grid">{fortificationKinds.map((kind) => <button type="button" key={kind} disabled={!canAfford(kind)} onClick={() => onChoose(kind)}><span><strong>{text.game.buildingNames[kind]}</strong><small>{text.game.buildingDescriptions[kind]}</small></span><Cost cost={buildingRules[kind].resourceCost} text={text} /><em>{buildingRules[kind].actionCost} ◆</em></button>)}</div>
}

function CastleEconomyPanel({ match, text, locked, onSetTaxRate }: { match: MatchState; text: LocaleDictionary; locked: boolean; onSetTaxRate: (rate: TaxRate) => void }) {
  const domain = humanDomain(match)
  const delta = turnResourceDeltaFor(match, match.playerId)
  const upkeep = upkeepFor(match, match.playerId)
  const taxes = taxIncomeFor(match, match.playerId)
  const food = foodDemandFor(match, match.playerId)
  const next = endTurn(match)
  const nextPopulation = next.ok ? next.state.domains[match.playerId].population : domain.population
  const rate = domain.taxRate ?? defaultTaxRate
  const resourceForecast = (resource: 'grain' | 'gold') => {
    const projected = domain.resources[resource] + delta[resource]
    return <div className={`economy-balance${projected < 0 ? ' deficit' : ''}`}><span>{text.game.resourceNames[resource]}</span><strong>{domain.resources[resource]} <i>→</i> {Math.max(0, projected)}</strong><small>{projected < 0 ? text.game.deficit : text.game.stable}</small></div>
  }
  return <section className="castle-economy-panel"><header><span>{text.game.economyTitle}</span><small>{text.game.economyDescription}</small></header><div className="economy-forecast">{resourceForecast('grain')}{resourceForecast('gold')}<dl><div><dt>{text.game.taxIncome}</dt><dd>+{taxes}</dd></div><div><dt>{text.game.upkeep}</dt><dd>−{upkeep.gold}</dd></div><div><dt>{text.game.grainDemand}</dt><dd>−{food}</dd></div><div><dt>{text.game.populationChange}</dt><dd>{domain.population} → {nextPopulation}/{domain.populationCapacity}</dd></div></dl></div><div className="tax-control"><span>{text.game.taxes}</span><div>{(['none', 'moderate', 'extortionate'] as TaxRate[]).map((candidate) => <button type="button" key={candidate} disabled={locked} className={candidate === rate ? 'active' : ''} aria-pressed={candidate === rate} onClick={() => onSetTaxRate(candidate)}>{text.game.taxRates[candidate]}</button>)}</div></div></section>
}

function MarketPanel({ match, position, text, locked, onTrade }: { match: MatchState; position: CellPosition; text: LocaleDictionary; locked: boolean; onTrade: GameCommandDockProps['onTrade'] }) {
  const [quantity, setQuantity] = useState(1)
  const resources = humanDomain(match).resources
  return <section className="market-panel"><header><div><span>{text.game.marketTitle}</span><small>{text.game.marketDescription}</small></div><div className="market-quantity"><button type="button" onClick={() => setQuantity((current) => Math.max(1, current - 1))}>−</button><strong>{quantity}</strong><button type="button" onClick={() => setQuantity((current) => Math.min(10, current + 1))}>+</button></div></header><div className="market-resource-list">{tradeableResources.map((resource) => {
    const prices = marketPrices[resource]
    return <article key={resource}><span>{text.game.resourceNames[resource]} <b>{resources[resource]}</b></span><button type="button" disabled={locked || resources[resource] < quantity} onClick={() => onTrade(position, resource, 'sell', quantity)}>{text.game.sell} <b>+{prices.sell * quantity}</b></button><button type="button" disabled={locked || resources.gold < prices.buy * quantity} onClick={() => onTrade(position, resource, 'buy', quantity)}>{text.game.buy} <b>−{prices.buy * quantity}</b></button></article>
  })}</div></section>
}

export function GameCommandDock(props: GameCommandDockProps) {
  const activeTabLabel = props.text.tabs.find((tab) => tab.id === props.activeTab)?.label ?? props.text.tabs[0].label
  const selectedObject = props.selectedCell ? objectAt(props.match, props.selectedCell) : null
  const ownedCastle = selectedObject?.type === 'castle' && selectedObject.ownerId === props.match.playerId
  const ownedMarket = selectedObject?.type === 'building' && selectedObject.kind === 'market' && selectedObject.ownerId === props.match.playerId
  return (
    <section className={`command-dock${props.locked ? ' locked' : ''}`} aria-label={props.text.interface.controlPanel} aria-busy={props.locked}>
      <div className="command-panel">
        <SelectionSummary match={props.match} position={props.selectedCell} text={props.text} locked={props.locked} onSplit={props.onSplit} />
        <div className="command-panel-main" role="tabpanel" aria-label={activeTabLabel}>
          {props.feedback && <div className="command-feedback" role="status">{props.feedback}</div>}
          {props.pendingAction ? <ActionModePanel match={props.match} action={props.pendingAction} text={props.text} onSplitChange={props.onSplitChange} onCancel={props.onCancelAction} /> : ownedCastle ? <CastleEconomyPanel match={props.match} text={props.text} locked={props.locked} onSetTaxRate={props.onSetTaxRate} /> : ownedMarket && props.selectedCell ? <MarketPanel match={props.match} position={props.selectedCell} text={props.text} locked={props.locked} onTrade={props.onTrade} /> : props.activeTab === 'buildings' ? <BuildingsPanel match={props.match} text={props.text} locked={props.locked} onChoose={props.onChooseBuild} /> : props.activeTab === 'barracks' ? <BarracksPanel match={props.match} text={props.text} locked={props.locked} onChoose={props.onChooseRecruit} /> : <FortificationsPanel match={props.match} text={props.text} locked={props.locked} onChoose={props.onChooseBuild} />}
        </div>
      </div>
      <nav className="tabs" aria-label={props.text.interface.controlSections}>{props.text.tabs.map((tab) => <button key={tab.id} type="button" className={tab.id === props.activeTab ? 'tab active' : 'tab'} aria-selected={tab.id === props.activeTab} role="tab" onClick={() => props.onTabChange(tab.id)}><span className="tab-glyph" aria-hidden="true" />{tab.label}</button>)}</nav>
    </section>
  )
}
