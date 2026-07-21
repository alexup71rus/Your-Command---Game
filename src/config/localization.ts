export const supportedLocales = ['ru', 'en'] as const
export type Locale = (typeof supportedLocales)[number]
export type TabId = 'buildings' | 'barracks' | 'castle'

export interface LocaleDictionary {
  localeName: string
  startMenu: {
    eyebrow: string
    title: string
    description: string
    chooseMap: string
    builtInMaps: string
    myMaps: string
    participants: string
    participantDescription: string
    humanAndNpc: string
    botsOnly: string
    customMap: string
    customMapDescription: string
    openGenerator: string
    seedShort: string
    deleteSavedMap: string
    start: string
    watch: string
    starting: string
    mapError: string
    mapUnviable: string
    workerError: string
    retry: string
    mapSaveFailed: string
    mapDeleteFailed: string
    mapReadFailed: string
    loadGame: string
    presets: Record<'greenMarches' | 'highlandPasses' | 'woodedBorder', { name: string; description: string }>
  }
  opponents: {
    title: string
    kicker: string
    description: string
    player: string
    playerDescription: string
    selected: string
    choose: string
    addOpponent: string
    removeOpponent: string
    confirm: string
    close: string
    playerMark: string
    mapCapacity: string
    biography: string
    region: string
    alliance: string
    changeAlliance: string
    regionBinding: string
    profiles: Record<AiProfileId, { name: string; epithets: string[]; role: string; strategy: string; toolkit: string }>
  }
  founding: {
    chooseTitle: string
    chooseDescription: string
    placeTitle: string
    placeDescription: string
    region: string
    land: string
    forest: string
    hills: string
    selected: string
    changeRegion: string
    assignedRegion: string
    chooseSite: string
    validSite: string
    invalidSite: string
    confirm: string
  }
  hud: {
    state: string
    resources: string
    people: string
    army: string
    turn: string
    ordersAvailable: string
    workers: string
    freePeople: string
    diverseDiet: string
    thinking: string
    longThinking: string
    yourTurn: string
    spectator: string
    aiPhase: Record<AiStrategicPhase, string>
  }
  tabs: Array<{ id: TabId; label: string }>
  game: {
    resourceNames: Record<ResourceId, string>
    buildingNames: Record<BuildingKind, string>
    buildingDescriptions: Record<BuildingKind, string>
    troopNames: Record<TroopKind, string>
    troopDescriptions: Record<TroopKind, string>
    selectCell: string
    emptyCell: string
    castle: string
    squad: string
    terrainPlain: string
    terrainHill: string
    terrainForest: string
    hitPoints: string
    defense: string
    squadHealth: string
    damage: string
    movementCost: string
    cost: string
    free: string
    emergencyFree: string
    perTurn: string
    quantity: string
    placementMode: string
    recruitmentMode: string
    splitMode: string
    dismissMode: string
    garrisonEnterMode: string
    garrisonExitMode: string
    towerAttackMode: string
    buildHint: string
    recruitHint: string
    moveHint: string
    knightMoveHint: string
    archerRangeHint: string
    routeUnavailable: string
    routeOrdersFinished: string
    splitHint: string
    dismissHint: string
    garrisonEnterHint: string
    garrisonExitHint: string
    towerAttackHint: string
    squadActionHint: string
    splitNewSquad: string
    splitRemaining: string
    cancel: string
    split: string
    dismiss: string
    confirmDismiss: string
    garrison: string
    garrisonEnter: string
    garrisonExit: string
    towerAttack: string
    towerRange: string
    towerCapacity: string
    armyLimit: string
    endTurn: string
    opponentTurn: string
    endTurnHint: string
    production: string
    foodDemand: string
    civilianFoodDemand: string
    buildingOutput: string
    populationCapacity: string
    workers: string
    size: string
    forestNeighbors: string
    farmCapacity: string
    supportRadius: string
    requiresMill: string
    processing: string
    foodService: string
    serviceRadius: string
    workerProductionFull: string
    workerProductionReduced: string
    workerProductionStopped: string
    workerProductionUnsupported: string
    workerSupportIdle: string
    taxes: string
    taxRates: Record<'none' | 'moderate' | 'extortionate', string>
    taxFoodShort: string
    taxOutputShort: string
    upkeep: string
    nextTurn: string
    stable: string
    deficit: string
    foodShortage: string
    marketTitle: string
    marketDescription: string
    marketPriceChangesIn: string
    marketUnitsToStep: string
    marketUnavailable: string
    foodSupply: string
    turnsOfSupply: string
    buy: string
    sell: string
    victoryTitle: string
    victoryDescription: string
    defeatTitle: string
    defeatDescription: string
    spectatorVictoryTitle: string
    spectatorVictoryDescription: string
    autoBattle: string
    continue: string
    turnDesertion: string
    turnStarvation: string
    turnCapacityLoss: string
    turnStarvationTroop: string
    previousItems: string
    nextItems: string
    buildingCategories: Record<'resources' | 'food' | 'settlement', string>
    previousTroops: string
    nextTroops: string
    failures: Record<CommandFailure, string>
  }
  interface: {
    controlPanel: string
    controlSections: string
    mapAria: string
    mapHint: string
    settingsHint: string
  }
  sound: {
    title: string
    description: string
    effectsVolume: string
    musicTitle: string
    musicDescription: string
    musicVolume: string
    enable: string
    disable: string
    enabled: string
    disabled: string
  }
  contextMenu: {
    title: string
    cell: string
    goHere: string
    splitSquad: string
    mergeSquads: string
    dismissSquad: string
    removeObject: string
    refund: string
    refundNone: string
  }
  confirmation: {
    cancel: string
    deleteMapTitle: string
    deleteMapDescription: string
    deleteMapAction: string
    leaveTitle: string
    leaveDescription: string
    leaveAction: string
  }
  settings: {
    title: string
    close: string
    language: string
    languageDescription: string
    grid: string
    gridDescription: string
    gridEnabled: string
    gridDisabled: string
    mainMenu: string
    mainMenuDescription: string
    saveGame: string
    saveGameDescription: string
    manageGames: string
  }
  savedGames: {
    kicker: string
    title: string
    close: string
    empty: string
    saveCurrent: string
    saveCurrentDescription: string
    saveUnavailable: string
    save: string
    loadSection: string
    loadSectionDescription: string
    slots: string
    latest: string
    load: string
    remove: string
    turn: string
    updated: string
    saved: string
    saveFailed: string
    loadFailed: string
    readFailed: string
    deleteFailed: string
    loadTitle: string
    loadDescription: string
    loadConfirm: string
    deleteTitle: string
    deleteDescription: string
  }
  generator: {
    title: string
    close: string
    relief: string
    mapSize: string
    source: string
    automatic: string
    hybrid: string
    manual: string
    hills: string
    peaks: string
    formScale: string
    reliefDistribution: string
    vegetation: string
    coverage: string
    vegetationDistribution: string
    heightPreference: string
    lowlands: string
    balanced: string
    highlands: string
    reliefInfluence: string
    brushAria: string
    erase: string
    hill: string
    mountain: string
    clearNodes: string
    previewAria: string
    plain: string
    elevation: string
    forest: string
    peak: string
    seed: string
    traversableHeights: string
    impassablePeaks: string
    forestCoverage: string
    cells: string
    note: string
    participants: string
    participantLimit: string
    regionsCalculating: string
    regionsError: string
    regionsUnbalanced: string
    regionsUnviable: string
    workerError: string
    retry: string
    saveError: string
    newVariant: string
    mapName: string
    defaultMapName: string
    saveMap: string
    apply: string
  }
}

const localeLoaders: Record<Locale, () => Promise<{ default: LocaleDictionary }>> = {
  ru: () => import('../locales/ru'),
  en: () => import('../locales/en'),
}

export const localeStorageKey = 'your-command:locale'
export const legacyLocaleStorageKey = 'castle-turns:locale'
export const defaultLocale: Locale = 'ru'

export function isLocale(value: string | null): value is Locale {
  return value !== null && supportedLocales.includes(value as Locale)
}

export function aiProfileDisplayName(text: LocaleDictionary['opponents'], profileId: AiProfileId, occurrence = 0) {
  const profile = text.profiles[profileId]
  const epithet = profile.epithets[occurrence % profile.epithets.length]
  return epithet ? `${profile.name} ${epithet}` : profile.name
}

export function aiParticipantDisplayName(text: LocaleDictionary['opponents'], participants: MatchParticipant[], participantId: string) {
  const participantIndex = participants.findIndex((participant) => participant.id === participantId)
  const participant = participants[participantIndex]
  if (!participant?.profileId) return participant?.kind === 'human' ? text.player : participantId
  const occurrence = participants.slice(0, participantIndex)
    .filter((candidate) => candidate.profileId === participant.profileId).length
  return aiProfileDisplayName(text, participant.profileId, occurrence)
}

export async function loadLocale(locale: Locale) {
  return (await localeLoaders[locale]()).default
}
import type { BuildingKind, ResourceId, TroopKind } from '../game/map'
import type { CommandFailure } from '../game/match'
import type { AiProfileId, MatchParticipant } from '../game/scenario'
import type { AiStrategicPhase } from '../game/ai/model'
