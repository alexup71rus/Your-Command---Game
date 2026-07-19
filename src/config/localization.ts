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
    customMap: string
    customMapDescription: string
    openGenerator: string
    seedShort: string
    deleteSavedMap: string
    start: string
    starting: string
    mapError: string
    loadGame: string
    presets: Record<'greenMarches' | 'highlandPasses' | 'woodedBorder', { name: string; description: string }>
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
  }
  resources: string[]
  troops: string[]
  tabs: Array<{ id: TabId; label: string }>
  game: {
    resourceNames: Record<ResourceId, string>
    buildingNames: Record<BuildingKind, string>
    buildingDescriptions: Record<BuildingKind, string>
    troopNames: Record<TroopKind, string>
    troopDescriptions: Record<TroopKind, string>
    selectedCell: string
    selectCell: string
    emptyCell: string
    castle: string
    squad: string
    ownObject: string
    enemyObject: string
    terrainPlain: string
    terrainHill: string
    terrainForest: string
    hitPoints: string
    squadSize: string
    squadHealth: string
    orders: string
    perTurn: string
    build: string
    recruit: string
    quantity: string
    placementMode: string
    recruitmentMode: string
    splitMode: string
    buildHint: string
    recruitHint: string
    moveHint: string
    knightMoveHint: string
    archerRangeHint: string
    splitHint: string
    cancel: string
    split: string
    endTurn: string
    opponentTurn: string
    endTurnHint: string
    production: string
    foodDemand: string
    populationCapacity: string
    economyTitle: string
    economyDescription: string
    taxes: string
    taxRates: Record<'none' | 'moderate' | 'extortionate', string>
    taxIncome: string
    upkeep: string
    grainDemand: string
    nextTurn: string
    populationChange: string
    stable: string
    deficit: string
    marketTitle: string
    marketDescription: string
    buy: string
    sell: string
    victoryTitle: string
    victoryDescription: string
    continue: string
    previousItems: string
    nextItems: string
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
    enable: string
    disable: string
    enabled: string
    disabled: string
  }
  contextMenu: {
    title: string
    cell: string
    splitSquad: string
    mergeSquads: string
    removeObject: string
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
    mainMenu: string
    mainMenuDescription: string
    saveGame: string
    saveGameDescription: string
  }
  savedGames: {
    title: string
    close: string
    empty: string
    saveCurrent: string
    load: string
    remove: string
    turn: string
    updated: string
    saved: string
    saveFailed: string
    loadFailed: string
    deleteTitle: string
    deleteDescription: string
  }
  generator: {
    title: string
    close: string
    devLabel: string
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
    regionsCalculating: string
    regionsError: string
    regionsUnbalanced: string
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

export const localeStorageKey = 'castle-turns:locale'
export const defaultLocale: Locale = 'ru'

export function isLocale(value: string | null): value is Locale {
  return value !== null && supportedLocales.includes(value as Locale)
}

export async function loadLocale(locale: Locale) {
  return (await localeLoaders[locale]()).default
}
import type { BuildingKind, ResourceId, TroopKind } from '../game/map'
import type { CommandFailure } from '../game/match'
