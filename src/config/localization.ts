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
  settings: {
    title: string
    close: string
    language: string
    languageDescription: string
    mainMenu: string
    mainMenuDescription: string
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
