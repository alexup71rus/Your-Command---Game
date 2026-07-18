import type { LocaleDictionary } from '../config/localization'

const en: LocaleDictionary = {
  localeName: 'English',
  hud: {
    state: 'Domain status', resources: 'Resources', people: 'People', army: 'Recruited troops', turn: 'Current turn', ordersAvailable: 'Orders available',
  },
  resources: ['Wood', 'Stone', 'Iron', 'Grain', 'Meat', 'Gold'],
  troops: ['Militia', 'Spearmen', 'Archers', 'Swordsmen', 'Cavalry'],
  tabs: [
    { id: 'buildings', label: 'Buildings' }, { id: 'barracks', label: 'Barracks' }, { id: 'castle', label: 'Castle' },
  ],
  interface: {
    controlPanel: 'Control panel', controlSections: 'Control sections', mapAria: 'Game world map. Drag to move and use the wheel to zoom.',
    mapHint: 'Drag the map · wheel — zoom · RMB — menu', settingsHint: 'Settings',
  },
  sound: {
    title: 'Sound', description: 'Interface and map action sounds', enable: 'Enable sound', disable: 'Disable sound', enabled: 'On', disabled: 'Off',
  },
  contextMenu: {
    title: 'Cell actions', cell: 'Cell', splitSquad: 'Split squad', mergeSquads: 'Merge squads', removeObject: 'Remove object',
  },
  settings: {
    title: 'Settings', close: 'Close settings', language: 'Language', languageDescription: 'Each interface language is loaded separately',
    mapGenerator: 'Map generator', mapGeneratorDescription: 'Relief, impassable heights and vegetation', openGenerator: 'Open generator',
  },
  generator: {
    title: 'World generator', close: 'Close generator', devLabel: 'DEV · SETTINGS',
    relief: 'Relief', source: 'Source', automatic: 'Fully automatic', hybrid: 'Auto + manual nodes', manual: 'Mostly manual',
    hills: 'Hills and heights', peaks: 'Impassable peaks', formScale: 'Form scale', reliefDistribution: 'Edges ← relief → center',
    vegetation: 'Vegetation', coverage: 'Coverage', vegetationDistribution: 'Edges ← greenery → center', heightPreference: 'Height preference',
    lowlands: 'Lowlands', balanced: 'Mid elevations', highlands: 'Highlands', reliefInfluence: 'Relief influence',
    brushAria: 'Relief brush', erase: 'Erase', hill: 'Hill', mountain: 'Mountain', clearNodes: 'Clear nodes', previewAria: 'Map preview and large relief form editor',
    plain: 'Plain', elevation: 'Height', forest: 'Forest', peak: 'Peak', seed: 'Seed',
    note: 'Paint large nodes on the preview. They spread smoothly across real cells; forests avoid impassable peaks and steep slopes.',
    vegetationOnly: 'Regenerate greenery only', newVariant: 'New variant', apply: 'Apply map',
  },
}

export default en
