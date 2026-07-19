import type { LocaleDictionary } from '../config/localization'

const en: LocaleDictionary = {
  localeName: 'English',
  startMenu: {
    eyebrow: 'Turn-based strategy', title: 'Your Command',
    description: 'Choose the future battlefield and the number of domains. Your castle will stand where you decide to found the settlement.',
    chooseMap: 'Battle maps', builtInMaps: 'Built-in scenarios', myMaps: 'My maps', participants: 'Participants', participantDescription: '1 player, the rest are NPCs',
    humanAndNpc: '1 player + NPCs', customMap: 'Custom world', customMapDescription: 'Configure terrain, forests and starting domains.',
    openGenerator: 'Open generator', seedShort: 'seed', deleteSavedMap: 'Delete map', start: 'Choose a domain', starting: 'Calculating domains…', mapError: 'The domains could not be balanced. Choose another map or participant count.', loadGame: 'Load game',
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
  game: {
    resourceNames: { wood: 'Wood', stone: 'Stone', iron: 'Iron', grain: 'Grain', meat: 'Meat', gold: 'Gold' },
    buildingNames: { farm: 'Farm', lumberMill: 'Lumber mill', quarry: 'Quarry', house: 'House', barracks: 'Barracks', church: 'Church', market: 'Market', wall: 'Wall', tower: 'Tower', barbican: 'Barbican' },
    buildingDescriptions: {
      farm: 'Occupies a 2 × 2 plot and produces grain and some meat on open plains.', lumberMill: 'Produces wood and must be built in a forest.', quarry: 'Occupies a 2 × 2 plot and extracts stone and iron on a clear hill.',
      house: 'Raises the population capacity by 10.', barracks: 'Occupies a 2 × 2 plot and forms squads around its perimeter.',
      church: 'Occupies a 2 × 2 plot, improves population growth and costs 4 gold per turn.',
      market: 'Lets you sell surpluses and buy resources you are missing.',
      wall: 'A durable barrier that takes reduced damage from ordinary troops.', tower: 'A fortified point for future garrisons and control of passages.',
      barbican: 'A heavy fortification protecting a key entrance to the domain.',
    },
    troopNames: { militia: 'Militia', spearmen: 'Spearmen', archers: 'Archers', knights: 'Knights' },
    troopDescriptions: { militia: 'Cheap troops with baseline damage and durability.', spearmen: 'Slightly stronger and tougher than militia, but cheaper than archers.', archers: 'Fight like militia up close but shoot up to 5 cells away.', knights: 'Spearman damage, high durability and 2 orders per step.' },
    selectedCell: 'Selected cell', selectCell: 'Select an object or cell on the map', emptyCell: 'Open ground', castle: 'Castle', squad: 'Squad', ownObject: 'Your object', enemyObject: 'Foreign object',
    terrainPlain: 'Plain', terrainHill: 'Height', terrainForest: 'Forest', hitPoints: 'Durability', squadSize: 'Troops', squadHealth: 'Endurance', orders: 'orders', perTurn: 'per turn',
    build: 'Place', recruit: 'Recruit', quantity: 'Quantity', placementMode: 'Construction', recruitmentMode: 'Form squad', splitMode: 'Split squad',
    buildHint: 'Choose a suitable cell inside your domain.', recruitHint: 'Choose a cell next to your castle or barracks.', moveHint: 'Choose an adjacent cell to move, merge or attack.', knightMoveHint: 'A squad containing knights costs 2 orders per step.', archerRangeHint: 'Archers shoot in a straight line up to 5 cells away.', routeUnavailable: 'There is no clear path to that cell.', routeOrdersFinished: 'No orders remain — movement has stopped.', splitHint: 'Choose a free adjacent cell for the new squad.',
    cancel: 'Cancel', split: 'Split', endTurn: 'End turn', opponentTurn: 'Opponent turn', endTurnHint: 'Production yields resources while the population and army consume grain.', production: 'Production', foodDemand: 'Grain demand', populationCapacity: 'Population capacity',
    economyTitle: 'Treasury and supply', economyDescription: 'Forecast for the end of the current turn', taxes: 'Tax collection', taxRates: { none: 'No taxes', moderate: 'Moderate', extortionate: 'Extortionate' }, taxIncome: 'Taxes', upkeep: 'Upkeep', grainDemand: 'Grain consumption', nextTurn: 'After turn', populationChange: 'Population', stable: 'Supply is sufficient', deficit: 'Deficit expected', marketTitle: 'Market', marketDescription: 'Trading costs no orders. Buying always costs more than selling.', buy: 'Buy', sell: 'Sell',
    victoryTitle: 'The domains are conquered', victoryDescription: 'Every foreign castle has fallen. The map remains available for inspection.', continue: 'Continue viewing',
    previousItems: 'Previous buildings', nextItems: 'Next buildings', previousTroops: 'Previous troops', nextTroops: 'Next troops',
    failures: {
      'game-over': 'The match has already ended.', 'not-owned': 'You do not own this object.', occupied: 'This cell is occupied.', 'invalid-terrain': 'The terrain is unsuitable for this action.',
      'outside-domain': 'You may build only inside your domain.', 'not-adjacent': 'A squad can act only on an adjacent cell.', 'not-enough-orders': 'There are not enough orders left this turn.',
      'not-enough-resources': 'Not enough resources.', 'not-enough-population': 'Not enough available people.', 'requires-barracks': 'Choose a cell next to a castle or barracks.',
      'squad-full': 'A cell can contain no more than 10 troops.', 'invalid-squad': 'This squad cannot be formed.', 'cannot-demolish': 'The castle cannot be demolished.', 'requires-market': 'You can trade only through your own market.', 'invalid-trade': 'Invalid trade parameters.', 'ranged-shot-blocked': 'A forest, peak or another object blocks the line of fire.', 'out-of-range': 'Archers shoot in a straight line up to 5 cells away.',
    },
  },
  interface: {
    controlPanel: 'Control panel', controlSections: 'Control sections', mapAria: 'Game world map. Drag to move and use the wheel to zoom.',
    mapHint: 'Drag the map · wheel — zoom · Shift — domains · RMB / Ctrl + click — menu', settingsHint: 'Settings',
  },
  sound: {
    title: 'Sound', description: 'Interface and map action sounds', enable: 'Enable sound', disable: 'Disable sound', enabled: 'On', disabled: 'Off',
  },
  contextMenu: {
    title: 'Cell actions', cell: 'Cell', goHere: 'Move here', splitSquad: 'Split squad', mergeSquads: 'Merge squads', removeObject: 'Remove object',
  },
  confirmation: {
    cancel: 'Cancel', deleteMapTitle: 'Delete map?', deleteMapDescription: 'The map will be removed from this browser. This cannot be undone.', deleteMapAction: 'Delete',
    leaveTitle: 'Return to the main menu?', leaveDescription: 'Changes made after the latest save will be lost.', leaveAction: 'Leave',
  },
  settings: {
    title: 'Settings', close: 'Close settings', language: 'Language', languageDescription: 'Each interface language is loaded separately', mainMenu: 'Main menu', mainMenuDescription: 'Return to map selection', saveGame: 'Save game', saveGameDescription: 'Store the current turn in a separate slot',
  },
  savedGames: {
    title: 'Saved games', close: 'Close saved games', empty: 'There are no saved games yet.', saveCurrent: 'New slot', load: 'Load', remove: 'Delete', turn: 'Turn', updated: 'Saved', saved: 'Game saved', saveFailed: 'Could not save the game', loadFailed: 'This save is corrupted or unavailable', deleteTitle: 'Delete this save?', deleteDescription: 'This progress cannot be recovered.',
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
