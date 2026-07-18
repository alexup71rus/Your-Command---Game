import type { LocaleDictionary } from '../config/localization'

const en: LocaleDictionary = {
  localeName: 'English',
  startMenu: {
    eyebrow: 'Turn-based strategy', title: 'Your Command',
    description: 'Choose the future battlefield and the number of domains. Your castle will stand where you decide to found the settlement.',
    chooseMap: 'Battle maps', builtInMaps: 'Built-in scenarios', myMaps: 'My maps', participants: 'Participants', participantDescription: '1 player, the rest are NPCs',
    humanAndNpc: '1 player + NPCs', customMap: 'Custom world', customMapDescription: 'Configure terrain, forests and starting domains.',
    openGenerator: 'Open generator', seedShort: 'seed', deleteSavedMap: 'Delete map', start: 'Choose a domain', starting: 'Calculating domains…', mapError: 'The domains could not be balanced. Choose another map or participant count.',
    presets: {
      greenMarches: { name: 'Green Marches', description: 'Open plains, gentle heights and room for an economy.' },
      highlandPasses: { name: 'Highland Passes', description: 'Heights and narrow routes create natural defensive lines.' },
      woodedBorder: { name: 'Wooded Border', description: 'Dense forests divide domains and conceal lines of attack.' },
    },
  },
  founding: {
    chooseTitle: 'Choose your domain', chooseDescription: 'Regions differ in shape and terrain but have comparable starting value.',
    placeTitle: 'Found your castle', placeDescription: 'Choose an open cell within your domain. Founding is free.',
    region: 'Domain', land: 'Land', forest: 'Forest', hills: 'Heights', selected: 'Selected', changeRegion: 'Change domain',
    chooseSite: 'Choose a cell on the map', validSite: 'Suitable castle site', invalidSite: 'A castle cannot be founded here', confirm: 'Confirm founding',
  },
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
    mapHint: 'Drag the map · wheel — zoom · Shift — domains · RMB / Ctrl + click — menu', settingsHint: 'Settings',
  },
  sound: {
    title: 'Sound', description: 'Interface and map action sounds', enable: 'Enable sound', disable: 'Disable sound', enabled: 'On', disabled: 'Off',
  },
  contextMenu: {
    title: 'Cell actions', cell: 'Cell', splitSquad: 'Split squad', mergeSquads: 'Merge squads', removeObject: 'Remove object',
  },
  settings: {
    title: 'Settings', close: 'Close settings', language: 'Language', languageDescription: 'Each interface language is loaded separately', mainMenu: 'Main menu', mainMenuDescription: 'The current match is not saved yet',
  },
  generator: {
    title: 'World generator', close: 'Close generator', devLabel: 'DEV · SETTINGS',
    relief: 'Relief', mapSize: 'Map size', source: 'Source', automatic: 'Fully automatic', hybrid: 'Auto + manual nodes', manual: 'Mostly manual',
    hills: 'Hills and heights', peaks: 'Impassable peaks', formScale: 'Form scale', reliefDistribution: 'Edges ← relief → center',
    vegetation: 'Vegetation', coverage: 'Coverage', vegetationDistribution: 'Edges ← greenery → center', heightPreference: 'Height preference',
    lowlands: 'Lowlands', balanced: 'Mid elevations', highlands: 'Highlands', reliefInfluence: 'Relief influence',
    brushAria: 'Relief brush', erase: 'Erase', hill: 'Hill', mountain: 'Mountain', clearNodes: 'Clear nodes', previewAria: 'Map preview and large relief form editor',
    plain: 'Plain', elevation: 'Height', forest: 'Forest', peak: 'Peak', seed: 'Generation seed',
    traversableHeights: 'Traversable heights', impassablePeaks: 'Impassable peaks', forestCoverage: 'Forest coverage', cells: 'cells',
    note: 'Paint large nodes on the preview. They spread smoothly across real cells; forests avoid impassable peaks and steep slopes.',
    participants: 'Starting domains', regionsCalculating: 'Calculating domain borders…', regionsError: 'These settings do not leave enough suitable land', regionsUnbalanced: 'The domains could not be divided fairly — change the terrain or seed',
    newVariant: 'New variant', mapName: 'Map name', defaultMapName: 'My map', saveMap: 'Save to my maps', apply: 'Choose a domain',
  },
}

export default en
