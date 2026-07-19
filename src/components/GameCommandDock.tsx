import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { LocaleDictionary, TabId } from '../config/localization'
import { buildingRules, defaultTaxRate, economyBuildingCategories, fortificationKinds, resourceIds, taxRates, tradeableResources, troopKinds, troopRules, type EconomyBuildingCategory, type ResourceAmount, type TaxRate } from '../config/rules'
import { gameConfig } from '../config/game'
import type { PendingGameAction } from '../game/interaction'
import type { BuildingKind, GameMap, ResourceId, TroopComposition, TroopKind } from '../game/map'
import { armyCapacity, buildingAvailabilityFailure, buildingResourceCostFor, foodDemandFor, hasRecruitmentSource, humanDomain, isEmergencyBuildingFree, maxSquadHealth, objectAt, squadHealth, squadSize, totalArmySize, tradeQuoteFor, turnEconomyForecastFor, workerAssignmentAt, type MatchState } from '../game/match'
import type { CellPosition } from '../game/scenario'
import { GridCanvas } from './GridCanvas'
import { TroopIcon } from './TroopIcon'
import { FortificationIcon } from './FortificationIcon'
import { troopMovementOrderCost } from '../game/movement'

interface GameCommandDockProps {
  match: MatchState
  selectedCell: CellPosition | null
  activeTab: TabId
  pendingAction: PendingGameAction | null
  locked: boolean
  text: LocaleDictionary
  feedback: string | null
  onOrderPreview: (cost: number) => void
  onTabChange: (tab: TabId) => void
  onChooseBuild: (kind: BuildingKind) => void
  onChooseRecruit: (troop: TroopKind, quantity: number) => void
  onSplit: (source: CellPosition) => void
  onDismiss: (source: CellPosition) => void
  onCompositionChange: (units: TroopComposition) => void
  onConfirmDismiss: () => void
  onTowerAction: (kind: 'garrison-enter' | 'garrison-exit' | 'tower-attack', tower: CellPosition) => void
  onCancelAction: () => void
  onSetTaxRate: (rate: TaxRate) => void
  onTrade: (position: CellPosition, resource: Exclude<ResourceId, 'gold'>, direction: 'buy' | 'sell', quantity: number) => void
}

function troopName(text: LocaleDictionary, kind: TroopKind) {
  return text.game.troopNames[kind] || kind
}

function buildingUnavailableReason(match: MatchState, kind: BuildingKind, locked: boolean, text: LocaleDictionary) {
  if (locked) return text.game.opponentTurn
  const failure = buildingAvailabilityFailure(match, kind)
  return failure ? text.game.failures[failure] : null
}

function orderPreviewHandlers(cost: number, disabled: boolean, onPreview: (cost: number) => void) {
  return {
    onPointerEnter: () => { if (!disabled) onPreview(cost) },
    onPointerLeave: () => onPreview(0),
    onFocus: () => { if (!disabled) onPreview(cost) },
    onBlur: () => onPreview(0),
  }
}

function Cost({ cost, text, multiplier = 1, className = '' }: { cost: ResourceAmount; text: LocaleDictionary; multiplier?: number; className?: string }) {
  const entries = resourceIds.filter((resource) => cost[resource])
  return <span className={`command-cost${className ? ` ${className}` : ''}`} data-label={text.game.cost}>{entries.length > 0 ? entries.map((resource) => <small key={resource}><b>{(cost[resource] ?? 0) * multiplier}</b> {text.game.resourceNames[resource]}</small>) : <small className="free-cost"><b>{text.game.free}</b></small>}</span>
}

function BuildingStats({ kind, text }: { kind: BuildingKind; text: LocaleDictionary }) {
  const rule = buildingRules[kind]
  const footprint = rule.footprint ?? { columns: 1, rows: 1 }
  return <span className="building-stats">
    {(footprint.columns > 1 || footprint.rows > 1) && <small>{text.game.size} <b>{footprint.columns}×{footprint.rows}</b></small>}
    {resourceIds.filter((resource) => (rule.production[resource] ?? 0) > 0).map((resource) => <small key={resource}><b>+{rule.production[resource]}</b> {text.game.resourceNames[resource]}</small>)}
    {rule.processing && <small>{text.game.processing} <b>{rule.processing.maximumPerTurn} {text.game.resourceNames[rule.processing.input]} → {rule.processing.maximumPerTurn} {text.game.resourceNames[rule.processing.output]}</b></small>}
    {rule.foodServiceCapacity && <small>{text.game.foodService} <b>{rule.foodServiceCapacity}</b></small>}
    {rule.housingCapacity && <small>{text.game.populationCapacity} <b>+{rule.housingCapacity}</b></small>}
    {rule.requiresFoodServiceAccess && <small>{text.game.serviceRadius} <b>≤ {gameConfig.economy.foodServiceRadius}</b></small>}
    {rule.upkeep && resourceIds.filter((resource) => (rule.upkeep?.[resource] ?? 0) > 0).map((resource) => <small key={`upkeep-${resource}`}>{text.game.upkeep} <b>{rule.upkeep?.[resource]} {text.game.resourceNames[resource]}</b> {text.game.perTurn}</small>)}
    {rule.workersRequired && <small>{text.game.workers} <b>{rule.workersRequired}</b></small>}
    {rule.minimumAdjacentForestCells && <small>{text.game.forestNeighbors} <b>{rule.minimumAdjacentForestCells}+</b></small>}
    {rule.farmSupport && <><small>{text.game.farmCapacity} <b>{rule.farmSupport.capacity}</b></small><small>{text.game.supportRadius} <b>{rule.farmSupport.radius}</b></small></>}
    {rule.requiresMillSupport && <small>{text.game.requiresMill}</small>}
    {rule.garrison && <><small>{text.game.towerCapacity} <b>{rule.garrison.capacity}</b></small><small>{text.game.towerRange} <b>{rule.garrison.attackRange}</b></small><small>{text.game.towerSight} <b>{rule.garrison.visibilityRadius}</b></small></>}
  </span>
}

const ignorePreviewEvent = () => undefined
const previewParticipants = [{ id: 'preview', kind: 'human' as const, regionId: 'preview', color: '#d2b45f' }]
const previewCameraCommand = { kind: 'cell' as const, column: 0, row: 0, zoom: gameConfig.camera.maxZoom, key: 0 }

function BuildingMapPreview({ kind, text, cost = buildingRules[kind].resourceCost }: { kind: BuildingKind; text: LocaleDictionary; cost?: ResourceAmount }) {
  const rule = buildingRules[kind]
  const footprint = rule.footprint ?? { columns: 1, rows: 1 }
  const map = useMemo<GameMap>(() => {
    const object = {
      type: 'building' as const,
      kind,
      ownerId: 'preview',
      hitPoints: rule.hitPoints,
      maxHitPoints: rule.hitPoints,
      footprint: rule.footprint ? { originColumn: 0, originRow: 0, ...rule.footprint } : undefined,
    }
    return Array.from({ length: footprint.rows }, () => Array.from({ length: footprint.columns }, () => ({
      elevation: rule.placement === 'hill' ? .65 : .2,
      landform: rule.placement === 'hill' ? 'hill' as const : 'plain' as const,
      vegetation: false,
      object,
    })))
  }, [footprint.columns, footprint.rows, kind, rule.hitPoints, rule.placement, rule.footprint])
  return <div className="building-map-preview">
    <div className="building-preview-canvas" aria-hidden="true"><GridCanvas map={map} participants={previewParticipants} cameraCommand={previewCameraCommand} onContextRequest={ignorePreviewEvent} onMapClick={ignorePreviewEvent} onNavigate={ignorePreviewEvent} ariaLabel="" /></div>
    <div className="building-preview-details"><BuildingStats kind={kind} text={text} /><Cost cost={cost} text={text} className="placement-cost" /></div>
  </div>
}

function SquadMapPreview({ troop, quantity }: { troop: TroopKind; quantity: number }) {
  const map = useMemo<GameMap>(() => {
    const units: TroopComposition = { militia: 0, spearmen: 0, archers: 0, knights: 0, [troop]: quantity }
    return [[{ elevation: .2, landform: 'plain', vegetation: false, object: { type: 'squad', ownerId: 'preview', units } }]]
  }, [quantity, troop])
  return <div className="building-preview-canvas unit-preview-canvas" aria-hidden="true"><GridCanvas map={map} participants={previewParticipants} cameraCommand={previewCameraCommand} onContextRequest={ignorePreviewEvent} onMapClick={ignorePreviewEvent} onNavigate={ignorePreviewEvent} ariaLabel="" /></div>
}

function SelectionSummary({ match, position, text, locked, onSplit, onDismiss, onTowerAction, onOrderPreview }: { match: MatchState; position: CellPosition | null; text: LocaleDictionary; locked: boolean; onSplit: (source: CellPosition) => void; onDismiss: (source: CellPosition) => void; onTowerAction: GameCommandDockProps['onTowerAction']; onOrderPreview: (cost: number) => void }) {
  if (!position) return <aside className="selection-summary empty"><p>{text.game.selectCell}</p></aside>
  const cell = match.scenario.cells[position.row]?.[position.column]
  const object = objectAt(match, position)
  const terrain = cell?.vegetation ? text.game.terrainForest : cell?.landform === 'hill' ? text.game.terrainHill : text.game.terrainPlain
  const owned = object?.ownerId === match.playerId
  const title = !object ? text.game.emptyCell : object.type === 'castle' ? text.game.castle : object.type === 'building' ? text.game.buildingNames[object.kind] : text.game.squad
  const squadEndurance = object?.type === 'squad' ? squadHealth(object) : 0
  const maxEndurance = object?.type === 'squad' ? maxSquadHealth(object) : 0
  const movementHint = object?.type === 'squad' && (object.units.knights ?? 0) > 0 ? text.game.knightMoveHint : text.game.moveHint
  const squadHint = object?.type === 'squad' && (object.units.archers ?? 0) > 0 ? `${movementHint} ${text.game.archerRangeHint}` : movementHint
  const workerAssignment = object?.type === 'building' ? workerAssignmentAt(match, position) : null
  const workerStatus = workerAssignment
    ? workerAssignment.blockedReason === 'missing-support' ? text.game.workerProductionUnsupported
      : workerAssignment.blockedReason === 'idle-support' ? text.game.workerSupportIdle
        : workerAssignment.assigned === 0 ? text.game.workerProductionStopped
      : workerAssignment.assigned < workerAssignment.required ? text.game.workerProductionReduced
        : text.game.workerProductionFull
    : null
  const splitDisabled = locked || match.ordersRemaining < gameConfig.turn.squadReorganizationOrderCost
  const towerRule = buildingRules.tower.garrison!
  const towerGarrison = object?.type === 'building' && object.kind === 'tower' ? object.garrison : undefined
  const towerTransferDisabled = locked || match.ordersRemaining < towerRule.transferOrderCost
  const towerAttackDisabled = locked || !towerGarrison || match.ordersRemaining < towerRule.attackOrderCost
  const towerEnterDisabled = towerTransferDisabled || (towerGarrison?.archers ?? 0) >= towerRule.capacity
  const towerExitDisabled = towerTransferDisabled || !towerGarrison
  const formatEndurance = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1)
  return (
    <aside className="selection-summary">
      <h3>{title}</h3>
      {!object && <p>{terrain}</p>}
      {object?.type === 'squad' && <div className="selection-unit-line">{troopKinds.map((kind) => (object.units[kind] ?? 0) > 0 && <small key={kind}><TroopIcon kind={kind} /><span>{troopName(text, kind)}</span><b>{object.units[kind]}</b></small>)}</div>}
      {object?.type === 'squad' && <div className="selection-health squad-health"><i style={{ width: `${maxEndurance > 0 ? Math.max(0, squadEndurance / maxEndurance * 100) : 0}%` }} /><small>{text.game.squadHealth} {formatEndurance(squadEndurance)}/{formatEndurance(maxEndurance)}</small></div>}
      {(object?.type === 'building' || object?.type === 'castle') && <div className="selection-health"><i style={{ width: `${Math.max(0, object.hitPoints / object.maxHitPoints * 100)}%` }} /><small>{text.game.hitPoints} {object.hitPoints}/{object.maxHitPoints}</small></div>}
      {workerAssignment && <div className={`selection-workers${workerAssignment.assigned < workerAssignment.required ? ' understaffed' : ''}`}><span>{text.game.workers} <b>{workerAssignment.assigned}/{workerAssignment.required}</b></span><small>{workerStatus}</small></div>}
      {object?.type === 'squad' && owned && <div className="selection-squad-controls"><span className="selection-guidance" title={squadHint}><b aria-hidden="true">↗</b><span>{text.game.squadActionHint}</span></span>{squadSize(object) > 1 && <><button type="button" className="selection-action" disabled={splitDisabled} title={splitDisabled && !locked ? text.game.failures['not-enough-orders'] : text.game.split} {...orderPreviewHandlers(gameConfig.turn.squadReorganizationOrderCost, splitDisabled, onOrderPreview)} onClick={() => onSplit(position)}>{text.game.split}</button><button type="button" className="selection-action" disabled={splitDisabled} {...orderPreviewHandlers(gameConfig.turn.squadReorganizationOrderCost, splitDisabled, onOrderPreview)} onClick={() => onDismiss(position)}>{text.game.dismiss}</button></>}</div>}
      {object?.type === 'building' && object.kind === 'tower' && owned && <div className="tower-garrison-summary"><div><span>{text.game.garrison}</span><strong><TroopIcon kind="archers" />{towerGarrison?.archers ?? 0}<small>/{towerRule.capacity}</small></strong></div><div className="tower-actions"><button type="button" disabled={towerEnterDisabled} {...orderPreviewHandlers(towerRule.transferOrderCost, towerEnterDisabled, onOrderPreview)} onClick={() => onTowerAction('garrison-enter', position)}>{text.game.garrisonEnter}</button><button type="button" disabled={towerExitDisabled} {...orderPreviewHandlers(towerRule.transferOrderCost, towerExitDisabled, onOrderPreview)} onClick={() => onTowerAction('garrison-exit', position)}>{text.game.garrisonExit}</button><button type="button" disabled={towerAttackDisabled} {...orderPreviewHandlers(towerRule.attackOrderCost, towerAttackDisabled, onOrderPreview)} onClick={() => onTowerAction('tower-attack', position)}>{text.game.towerAttack}</button></div></div>}
    </aside>
  )
}

function ActionModePanel({ match, action, text, onCompositionChange, onConfirmDismiss, onCancel }: { match: MatchState; action: PendingGameAction; text: LocaleDictionary; onCompositionChange: (units: TroopComposition) => void; onConfirmDismiss: () => void; onCancel: () => void }) {
  if (action.kind === 'split' || action.kind === 'dismiss') {
    const squad = objectAt(match, action.source)
    const available = squad?.type === 'squad' ? squad.units : { militia: 0, spearmen: 0, archers: 0, knights: 0 }
    const selected = squadSize({ units: action.units })
    const total = squad?.type === 'squad' ? squadSize(squad) : 0
    const dismissing = action.kind === 'dismiss'
    return <section className="action-mode-panel split-mode-panel"><div className="split-mode-copy"><span>{dismissing ? text.game.dismissMode : text.game.splitMode}</span><div className="split-totals"><span><b>{selected}</b><small>{dismissing ? text.game.dismiss : text.game.splitNewSquad}</small></span><span><b>{Math.max(0, total - selected)}</b><small>{text.game.splitRemaining}</small></span></div><p>{dismissing ? text.game.dismissHint : text.game.splitHint}</p></div><div className="split-composition">{troopKinds.filter((kind) => (available[kind] ?? 0) > 0).map((kind) => {
      const amount = action.units[kind] ?? 0
      const name = troopName(text, kind)
      return <div key={kind}><span>{name}<small>/ {available[kind]}</small></span><button type="button" aria-label={`− ${name}`} disabled={amount <= 0} onClick={() => onCompositionChange({ ...action.units, [kind]: amount - 1 })}>−</button><b>{amount}</b><button type="button" aria-label={`+ ${name}`} disabled={amount >= (available[kind] ?? 0) || selected >= total} onClick={() => onCompositionChange({ ...action.units, [kind]: amount + 1 })}>+</button></div>
    })}</div><div className="action-mode-actions">{dismissing && <button type="button" className="confirm-command" disabled={selected < 1 || selected >= total} onClick={onConfirmDismiss}>{text.game.confirmDismiss}</button>}<button type="button" className="cancel-command" onClick={onCancel}>{text.game.cancel}</button></div></section>
  }
  if (action.kind === 'garrison-enter' || action.kind === 'garrison-exit' || action.kind === 'tower-attack') {
    const title = action.kind === 'garrison-enter' ? text.game.garrisonEnterMode : action.kind === 'garrison-exit' ? text.game.garrisonExitMode : text.game.towerAttackMode
    const hint = action.kind === 'garrison-enter' ? text.game.garrisonEnterHint : action.kind === 'garrison-exit' ? text.game.garrisonExitHint : text.game.towerAttackHint
    return <section className="action-mode-panel tower-action-mode"><div className="action-mode-copy"><span>{title}</span><strong>{text.game.buildingNames.tower}</strong><p>{hint}</p></div><BuildingMapPreview kind="tower" text={text} /><button type="button" className="cancel-command" onClick={onCancel}>{text.game.cancel}</button></section>
  }
  const title = action.kind === 'build' ? text.game.placementMode : text.game.recruitmentMode
  const name = action.kind === 'build' ? text.game.buildingNames[action.building] : `${troopName(text, action.troop)} × ${action.quantity}`
  const hint = action.kind === 'build' ? text.game.buildHint : text.game.recruitHint
  return <section className="action-mode-panel"><div className="action-mode-copy"><span>{title}</span><strong>{name}</strong><p>{hint}</p></div>{action.kind === 'build' ? <BuildingMapPreview kind={action.building} text={text} cost={buildingResourceCostFor(match, match.playerId, action.building)} /> : <SquadMapPreview troop={action.troop} quantity={action.quantity} />}<button type="button" className="cancel-command" onClick={onCancel}>{text.game.cancel}</button></section>
}

function BuildingsPanel({ match, text, locked, category, onCategoryChange, onChoose, onOrderPreview }: { match: MatchState; text: LocaleDictionary; locked: boolean; category: EconomyBuildingCategory; onCategoryChange: (category: EconomyBuildingCategory) => void; onChoose: (kind: BuildingKind) => void; onOrderPreview: (cost: number) => void }) {
  const carouselRef = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ start: true, end: false })
  const syncEdge = (element: HTMLDivElement) => setEdge({ start: element.scrollLeft <= 1, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1 })
  const scroll = (direction: -1 | 1) => {
    const carousel = carouselRef.current
    const card = carousel?.querySelector<HTMLElement>(':scope > button')
    if (!carousel || !card) return
    carousel.scrollBy({ left: direction * (card.getBoundingClientRect().width + 7), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  const changeCategory = (next: EconomyBuildingCategory) => {
    onCategoryChange(next)
    setEdge({ start: true, end: false })
    carouselRef.current?.scrollTo({ left: 0 })
    window.requestAnimationFrame(() => { if (carouselRef.current) syncEdge(carouselRef.current) })
  }
  const categories = Object.keys(economyBuildingCategories) as EconomyBuildingCategory[]
  return <section className="building-browser"><nav className="building-category-switch" aria-label={text.tabs.find((tab) => tab.id === 'buildings')?.label}>{categories.map((candidate) => <button type="button" key={candidate} className={candidate === category ? 'active' : ''} aria-pressed={candidate === category} onClick={() => changeCategory(candidate)}>{text.game.buildingCategories[candidate]}</button>)}</nav><div className="command-carousel"><button type="button" className="carousel-arrow previous" disabled={edge.start} aria-label={text.game.previousItems} onClick={() => scroll(-1)}>‹</button><div ref={carouselRef} className="command-card-grid building-command-grid" onScroll={(event) => syncEdge(event.currentTarget)}>{economyBuildingCategories[category].map((kind) => {
    const unavailable = buildingUnavailableReason(match, kind, locked, text)
    const emergencyFree = isEmergencyBuildingFree(match, match.playerId, kind)
    const description = emergencyFree ? `${text.game.buildingDescriptions[kind]} ${text.game.emergencyFree}` : text.game.buildingDescriptions[kind]
    return <button type="button" key={kind} disabled={Boolean(unavailable)} title={unavailable ?? description} {...orderPreviewHandlers(buildingRules[kind].actionCost, Boolean(unavailable), onOrderPreview)} onClick={() => onChoose(kind)}><span><strong>{text.game.buildingNames[kind]}</strong><small>{description}</small></span><BuildingStats kind={kind} text={text} /><Cost cost={buildingResourceCostFor(match, match.playerId, kind)} text={text} /></button>
  })}</div><button type="button" className="carousel-arrow next" disabled={edge.end} aria-label={text.game.nextItems} onClick={() => scroll(1)}>›</button></div></section>
}

function QuantityPicker({ quantity, setQuantity, text, locked }: { quantity: number; setQuantity: (quantity: number) => void; text: LocaleDictionary; locked: boolean }) {
  return <aside className="quantity-picker"><span>{text.game.quantity}</span><div><button type="button" aria-label={`${text.game.quantity}: −`} disabled={locked || quantity <= 1} onClick={() => setQuantity(Math.max(1, quantity - 1))}>−</button><strong>{quantity}</strong><button type="button" aria-label={`${text.game.quantity}: +`} disabled={locked || quantity >= gameConfig.turn.squadCapacity} onClick={() => setQuantity(Math.min(gameConfig.turn.squadCapacity, quantity + 1))}>+</button></div><small>1–{gameConfig.turn.squadCapacity}</small></aside>
}

function BarracksPanel({ match, text, locked, quantity, onChoose, onOrderPreview }: { match: MatchState; text: LocaleDictionary; locked: boolean; quantity: number; onChoose: (troop: TroopKind, quantity: number) => void; onOrderPreview: (cost: number) => void }) {
  const carouselRef = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ start: true, end: false })
  const domain = humanDomain(match)
  const armySpace = Math.max(0, armyCapacity - totalArmySize(match))
  const syncEdge = (element: HTMLDivElement) => setEdge({ start: element.scrollLeft <= 1, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1 })
  const scroll = (direction: -1 | 1) => {
    const carousel = carouselRef.current
    const card = carousel?.querySelector<HTMLElement>(':scope > button')
    if (!carousel || !card) return
    carousel.scrollBy({ left: direction * (card.getBoundingClientRect().width + 7), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  return <div className="command-carousel troop-command-carousel"><button type="button" className="carousel-arrow previous" disabled={edge.start} aria-label={text.game.previousTroops} onClick={() => scroll(-1)}>‹</button><div ref={carouselRef} className="command-card-grid troop-command-grid" onScroll={(event) => syncEdge(event.currentTarget)}>{troopKinds.map((troop) => {
    const rule = troopRules[troop]
    const maxByResources = resourceIds.reduce<number>((max, resource) => {
      const cost = rule.resourceCost[resource] ?? 0
      return cost > 0 ? Math.min(max, Math.floor(domain.resources[resource] / cost)) : max
    }, gameConfig.turn.squadCapacity)
    const maxByPopulation = Math.floor(domain.population / rule.populationCost)
    const unavailable = match.status !== 'playing' ? text.game.failures['game-over']
      : locked ? text.game.opponentTurn
        : !hasRecruitmentSource(match, troop) ? text.game.failures['requires-barracks']
        : match.ordersRemaining < rule.actionCost ? text.game.failures['not-enough-orders']
          : armySpace < quantity ? text.game.failures['army-full']
            : maxByPopulation < quantity ? text.game.failures['not-enough-population']
            : maxByResources < quantity ? text.game.failures['not-enough-resources']
              : null
    return <button type="button" className="troop-command-card" key={troop} disabled={Boolean(unavailable)} title={unavailable ?? text.game.troopDescriptions[troop]} {...orderPreviewHandlers(rule.actionCost, Boolean(unavailable), onOrderPreview)} onClick={() => onChoose(troop, quantity)}><span><strong>{troopName(text, troop)}</strong><small>{text.game.troopDescriptions[troop] || troop}</small></span><span className="troop-card-visual"><span className="troop-card-emblem"><TroopIcon kind={troop} /></span><span className="troop-card-stats"><span><small>{text.game.damage}</small><b>{rule.damage}</b></span><span><small>{text.game.movementCost}</small><b>{troopMovementOrderCost(troop)} <i aria-hidden="true">◆</i></b></span></span></span><Cost cost={rule.resourceCost} text={text} multiplier={quantity} /></button>
  })}</div><button type="button" className="carousel-arrow next" disabled={edge.end} aria-label={text.game.nextTroops} onClick={() => scroll(1)}>›</button></div>
}

function FortificationsPanel({ match, text, locked, onChoose, onOrderPreview }: { match: MatchState; text: LocaleDictionary; locked: boolean; onChoose: (kind: BuildingKind) => void; onOrderPreview: (cost: number) => void }) {
  return <div className="command-card-grid fortification-command-grid">{fortificationKinds.map((kind) => {
    const rule = buildingRules[kind]
    const unavailable = buildingUnavailableReason(match, kind, locked, text)
    return <button type="button" className="fortification-command-card" key={kind} disabled={Boolean(unavailable)} title={unavailable ?? text.game.buildingDescriptions[kind]} {...orderPreviewHandlers(rule.actionCost, Boolean(unavailable), onOrderPreview)} onClick={() => onChoose(kind)}><span><strong>{text.game.buildingNames[kind]}</strong><small>{text.game.buildingDescriptions[kind]}</small></span><span className="fortification-card-visual"><span className="fortification-card-emblem"><FortificationIcon kind={kind} /></span><span className="fortification-card-stats"><span><small>{text.game.hitPoints}</small><b>{rule.hitPoints}</b></span>{rule.incomingDamageMultiplier && <span><small>{text.game.defense}</small><b>{Math.round((1 - rule.incomingDamageMultiplier) * 100)}%</b></span>}{rule.garrison && <><span><small>{text.game.towerRange}</small><b>{rule.garrison.attackRange}</b></span><span><small>{text.game.towerSight}</small><b>{rule.garrison.visibilityRadius}</b></span><span><small>{text.game.towerCapacity}</small><b>{rule.garrison.capacity}</b></span></>}</span></span><Cost cost={rule.resourceCost} text={text} /></button>
  })}</div>
}

function CastleEconomyPanel({ match, text, locked, onSetTaxRate }: { match: MatchState; text: LocaleDictionary; locked: boolean; onSetTaxRate: (rate: TaxRate) => void }) {
  const domain = humanDomain(match)
  const forecast = useMemo(() => turnEconomyForecastFor(match, match.playerId), [match])
  const rate = domain.taxRate ?? defaultTaxRate
  const selectedTaxRule = taxRates[rate]
  const taxGold = forecast?.taxIncome ?? Math.floor(domain.population * selectedTaxRule.goldPerPerson)
  const foodDemand = forecast?.foodDemand ?? foodDemandFor(match, match.playerId)
  const upkeepGold = forecast?.upkeep.gold ?? 0
  const foodResources = gameConfig.economy.foodResources
  const currentFood = foodResources.reduce((total, resource) => total + domain.resources[resource], 0)
  const projectedFood = forecast ? foodResources.reduce((total, resource) => total + forecast.resources[resource], 0) : currentFood
  const producedFood = forecast ? foodResources.reduce((total, resource) => total + forecast.production[resource], 0) : 0
  const foodFlow = producedFood - foodDemand
  const goldFlow = forecast ? forecast.resources.gold - domain.resources.gold : 0
  const turnsRemaining = foodFlow < 0 ? Math.max(1, Math.ceil(currentFood / Math.abs(foodFlow))) : null
  return <section className="castle-economy-panel"><div className="economy-forecast"><div className={`economy-balance food-balance${forecast && (!forecast.food.fed || foodFlow < 0) ? ' deficit' : ''}`}><span>{text.game.foodSupply}</span><strong>{currentFood} <i>→</i> {projectedFood}</strong><small>{foodFlow >= 0 ? '+' : ''}{foodFlow} {text.game.perTurn}{turnsRemaining ? ` · ${text.game.turnsOfSupply.replace('{count}', String(turnsRemaining))}` : ''}</small></div><div className={`economy-balance${forecast && !forecast.upkeepPaid ? ' deficit' : ''}`}><span>{text.game.resourceNames.gold}</span><strong>{domain.resources.gold} <i>→</i> {forecast?.resources.gold ?? domain.resources.gold}</strong><small>{goldFlow >= 0 ? '+' : ''}{goldFlow} {text.game.perTurn}</small></div><div className={`tax-impact${forecast && (!forecast.food.fed || !forecast.upkeepPaid) ? ' deficit' : ''}`}><span>{text.game.nextTurn}</span><strong>+{taxGold} {text.game.resourceNames.gold.toLowerCase()}</strong><strong>−{foodDemand} {text.game.foodDemand.toLowerCase()}</strong><strong>−{upkeepGold} {text.game.resourceNames.gold.toLowerCase()} · {text.game.upkeep.toLowerCase()}</strong>{forecast && !forecast.food.fed && <strong>{text.game.foodShortage}</strong>}{forecast?.desertion && <strong>{text.game.turnDesertion.replace('{unit}', text.game.troopNames[forecast.desertion.kind])}</strong>}</div></div><div className="tax-control"><span>{text.game.taxes}</span><div className="tax-control-legend" aria-hidden="true"><i /><small>{text.game.taxFoodShort}</small><small>{text.game.taxOutputShort}</small></div><div>{(['none', 'moderate', 'extortionate'] as TaxRate[]).map((candidate) => {
    const rule = taxRates[candidate]
    const productionImpact = rule.productionAdjustment < 0 ? `−${Math.abs(rule.productionAdjustment)}` : '0'
    const impact = `${text.game.civilianFoodDemand} ×${rule.foodDemandMultiplier} · ${text.game.buildingOutput} ${productionImpact}`
    return <button type="button" key={candidate} title={impact} aria-label={`${text.game.taxRates[candidate]}. ${impact}`} disabled={locked} className={candidate === rate ? 'active' : ''} aria-pressed={candidate === rate} onClick={() => onSetTaxRate(candidate)}><span>{text.game.taxRates[candidate]}</span><small>×{rule.foodDemandMultiplier}</small><small>{productionImpact}</small></button>
  })}</div></div></section>
}

function MarketPanel({ match, position, text, locked, onTrade }: { match: MatchState; position: CellPosition; text: LocaleDictionary; locked: boolean; onTrade: GameCommandDockProps['onTrade'] }) {
  const [quantity, setQuantity] = useState(1)
  const domain = humanDomain(match)
  const resources = domain.resources
  return <section className="market-panel"><header><div><span>{text.game.marketTitle}</span><small>{text.game.marketDescription}</small></div><div className="market-quantity"><button type="button" aria-label={`${text.game.quantity}: −`} disabled={locked || quantity <= 1} onClick={() => setQuantity((current) => Math.max(1, current - 1))}>−</button><strong>{quantity}</strong><button type="button" aria-label={`${text.game.quantity}: +`} disabled={locked || quantity >= 10} onClick={() => setQuantity((current) => Math.min(10, current + 1))}>+</button></div></header><div className="market-resource-list">{tradeableResources.map((resource) => {
    const sellQuote = tradeQuoteFor(domain, resource, 'sell', quantity)
    const buyQuote = tradeQuoteFor(domain, resource, 'buy', quantity)
    const sellTitle = sellQuote.currentUnitPrice <= 0 ? text.game.marketUnavailable : text.game.marketPriceChangesIn.replace('{count}', String(sellQuote.unitsUntilNextPrice))
    const buyTitle = text.game.marketPriceChangesIn.replace('{count}', String(buyQuote.unitsUntilNextPrice))
    const sellStep = text.game.marketUnitsToStep.replace('{count}', String(sellQuote.unitsUntilNextPrice))
    const buyStep = text.game.marketUnitsToStep.replace('{count}', String(buyQuote.unitsUntilNextPrice))
    return <article key={resource}><span>{text.game.resourceNames[resource]} <b>{resources[resource]}</b><small>↓ {sellQuote.currentUnitPrice} · {sellStep} / ↑ {buyQuote.currentUnitPrice} · {buyStep}</small></span><button type="button" title={sellTitle} disabled={locked || resources[resource] < quantity || sellQuote.includesUnavailableUnits} onClick={() => onTrade(position, resource, 'sell', quantity)}>{text.game.sell} <b>+{sellQuote.total}</b></button><button type="button" title={buyTitle} disabled={locked || resources.gold < buyQuote.total} onClick={() => onTrade(position, resource, 'buy', quantity)}>{text.game.buy} <b>−{buyQuote.total}</b></button></article>
  })}</div></section>
}

export function GameCommandDock(props: GameCommandDockProps) {
  const [recruitQuantity, setRecruitQuantity] = useState(1)
  const [buildingCategory, setBuildingCategory] = useState<EconomyBuildingCategory>('resources')
  const dockId = useId()
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({})
  const selectedObject = props.selectedCell ? objectAt(props.match, props.selectedCell) : null
  const ownedCastle = selectedObject?.type === 'castle' && selectedObject.ownerId === props.match.playerId
  const ownedMarket = selectedObject?.type === 'building' && selectedObject.kind === 'market' && selectedObject.ownerId === props.match.playerId
  const commandsLocked = props.locked || props.match.status !== 'playing'
  const showRecruitQuantity = !props.pendingAction && !ownedCastle && !ownedMarket && props.activeTab === 'barracks'
  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, current: TabId) => {
    const tabs = props.text.tabs.map((tab) => tab.id)
    const currentIndex = tabs.indexOf(current)
    const nextIndex = event.key === 'ArrowRight' ? (currentIndex + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (currentIndex - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : null
    if (nextIndex === null) return
    event.preventDefault()
    const next = tabs[nextIndex]
    props.onTabChange(next)
    window.requestAnimationFrame(() => tabRefs.current[next]?.focus())
  }
  return (
    <section className={`command-dock${commandsLocked ? ' locked' : ''}`} aria-label={props.text.interface.controlPanel} aria-busy={props.locked}>
      <div className="command-panel">
        {showRecruitQuantity ? <QuantityPicker quantity={recruitQuantity} setQuantity={setRecruitQuantity} text={props.text} locked={commandsLocked} /> : <SelectionSummary match={props.match} position={props.selectedCell} text={props.text} locked={commandsLocked} onSplit={props.onSplit} onDismiss={props.onDismiss} onTowerAction={props.onTowerAction} onOrderPreview={props.onOrderPreview} />}
        <div className="command-panel-main" id={`${dockId}-panel`} role="tabpanel" aria-labelledby={`${dockId}-tab-${props.activeTab}`}>
          {props.feedback && <div className="command-feedback" role="status">{props.feedback}</div>}
          {props.pendingAction ? <ActionModePanel match={props.match} action={props.pendingAction} text={props.text} onCompositionChange={props.onCompositionChange} onConfirmDismiss={props.onConfirmDismiss} onCancel={props.onCancelAction} /> : ownedCastle ? <CastleEconomyPanel match={props.match} text={props.text} locked={commandsLocked} onSetTaxRate={props.onSetTaxRate} /> : ownedMarket && props.selectedCell ? <MarketPanel match={props.match} position={props.selectedCell} text={props.text} locked={commandsLocked} onTrade={props.onTrade} /> : props.activeTab === 'buildings' ? <BuildingsPanel match={props.match} text={props.text} locked={commandsLocked} category={buildingCategory} onCategoryChange={setBuildingCategory} onChoose={props.onChooseBuild} onOrderPreview={props.onOrderPreview} /> : props.activeTab === 'barracks' ? <BarracksPanel match={props.match} text={props.text} locked={commandsLocked} quantity={recruitQuantity} onChoose={props.onChooseRecruit} onOrderPreview={props.onOrderPreview} /> : <FortificationsPanel match={props.match} text={props.text} locked={commandsLocked} onChoose={props.onChooseBuild} onOrderPreview={props.onOrderPreview} />}
        </div>
      </div>
      <nav className="tabs" role="tablist" aria-label={props.text.interface.controlSections}>{props.text.tabs.map((tab) => <button ref={(element) => { tabRefs.current[tab.id] = element }} key={tab.id} id={`${dockId}-tab-${tab.id}`} type="button" className={tab.id === props.activeTab ? 'tab active' : 'tab'} aria-controls={`${dockId}-panel`} aria-selected={tab.id === props.activeTab} role="tab" tabIndex={tab.id === props.activeTab ? 0 : -1} onKeyDown={(event) => moveTabFocus(event, tab.id)} onClick={() => props.onTabChange(tab.id)}><span className="tab-glyph" aria-hidden="true" />{tab.label}</button>)}</nav>
    </section>
  )
}
