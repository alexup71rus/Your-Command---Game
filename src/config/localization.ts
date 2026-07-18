export const supportedLocales = ['ru', 'en'] as const
export type Locale = (typeof supportedLocales)[number]
export type TabId = 'buildings' | 'barracks' | 'castle'

export interface LocaleDictionary {
  localeName: string
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
    mapGenerator: string
    mapGeneratorDescription: string
    openGenerator: string
  }
  generator: {
    title: string
    close: string
    devLabel: string
    relief: string
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
    note: string
    vegetationOnly: string
    newVariant: string
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
