import type { LocaleDictionary } from '../config/localization'

const en: LocaleDictionary = {
  localeName: 'English',
  startMenu: {
    eyebrow: 'Turn-based strategy', title: 'Your Command',
    description: 'Choose the future battlefield, gather the round table, and decide whether to command a domain or watch the rulers fight.',
    chooseMap: 'Battle maps', builtInMaps: 'Built-in scenarios', myMaps: 'My maps', participants: 'Round table', participantDescription: 'Seats in the coming battle',
    humanAndNpc: 'You have a seat in the battle', botsOnly: 'Automated battle between rulers', customMap: 'Custom world', customMapDescription: 'Configure terrain, forests and starting domains.',
    openGenerator: 'Open generator', seedShort: 'seed', deleteSavedMap: 'Delete map', start: 'Choose a domain', watch: 'Watch the battle', starting: 'Calculating domains…', mapError: 'The domains could not be balanced. Choose another map or participant count.', mapUnviable: 'The domains do not leave enough room for the first buildings. Change the map or participant count.', workerError: 'The domains could not be calculated.', retry: 'Retry', mapSaveFailed: 'The map could not be saved in this browser.', mapDeleteFailed: 'The saved map could not be deleted.', mapReadFailed: 'Saved maps could not be read from browser storage.', loadGame: 'Load game',
    presets: {
      greenMarches: { name: 'Green Marches', description: 'Open plains, gentle heights and room for an economy.' },
      highlandPasses: { name: 'Highland Passes', description: 'Heights and narrow routes create natural defensive lines.' },
      woodedBorder: { name: 'Wooded Border', description: 'Dense forests divide domains and conceal lines of attack.' },
    },
  },
  opponents: {
    kicker: 'ROUND TABLE', title: 'Gather the council of rulers', description: 'Add or remove seats without choosing a separate mode. If you leave the table, the selected bots fight automatically.',
    player: 'You', playerDescription: 'Founder and commander of your domain', selected: 'Seats at the table', choose: 'Candidates', addOpponent: 'Invite ruler', removeOpponent: 'Remove participant', confirm: 'Confirm roster', close: 'Close round table', playerMark: 'YOU', mapCapacity: 'The selected map supports up to {count} participants. At least one seat must remain.', biography: 'Ruler dossier', region: 'Domain', alliance: 'Alliance', changeAlliance: 'Change alliance', regionBinding: 'Each seat number matches a domain on the map. Select an alliance crest to change sides.',
    profiles: {
      radomir: { name: 'Radomir', epithets: ['the Prudent', 'the Wise', 'the Steadfast', 'the Cunning'], role: 'Steward and field commander', strategy: 'He opens with a dependable economy, preserves his people, and commits to a direct assault only after gathering a focused force.', toolkit: 'Militia · spearmen · sustainable economy' },
      velislava: { name: 'Velislava', epithets: ['of the Frontier', 'the Vigilant', 'the Unyielding', 'the Fox'], role: 'Warden of passes and raider', strategy: 'She turns narrow approaches into defensive lines, screens her archers, and punishes domains that leave their economy exposed.', toolkit: 'Farms · archers · walls · barbicans' },
      svyatobor: { name: 'Svyatobor', epithets: ['Ironhand', 'the Unbroken', 'Warsmith', 'the Stern'], role: 'Industrial and siege strategist', strategy: 'He plans several turns ahead, develops iron production, gathers heavy forces, and methodically breaks fortified positions.', toolkit: 'Iron · knights · market · tower garrisons' },
    },
  },
  founding: {
    chooseTitle: 'Choose your domain', chooseDescription: 'Regions differ in shape and terrain but have comparable starting value.',
    placeTitle: 'Found your castle', placeDescription: 'Choose an open cell within your domain. Founding is free.',
    region: 'Domain', land: 'Land', forest: 'Forest', hills: 'Heights', selected: 'Selected', changeRegion: 'Change domain', assignedRegion: 'This domain is bound to your seat at the round table.',
    chooseSite: 'Choose a cell on the map', validSite: 'Suitable castle site', invalidSite: 'A castle cannot be founded here', confirm: 'Confirm founding',
  },
  hud: {
    state: 'Domain status', resources: 'Resources', people: 'Civilians', army: 'Recruited troops', turn: 'Turn', ordersAvailable: 'Orders available', workers: 'Employed', freePeople: 'Free', diverseDiet: 'Varied diet', thinking: 'is planning', longThinking: 'is evaluating a complex position', yourTurn: 'Your turn', spectator: 'Spectator mode',
    aiPhase: { recovery: 'is restoring the economy', survival: 'is securing supplies', expansion: 'is developing the domain', mobilization: 'is mustering troops', assault: 'is advancing', regroup: 'is regrouping', defense: 'is defending the castle' },
  },
  tabs: [
    { id: 'buildings', label: 'Buildings' }, { id: 'barracks', label: 'Barracks' }, { id: 'castle', label: 'Castle' },
  ],
  game: {
    resourceNames: { wood: 'Wood', stone: 'Stone', ore: 'Ore', iron: 'Iron', flour: 'Flour', meat: 'Meat', fruit: 'Fruit', gold: 'Gold' },
    buildingNames: { mill: 'Mill', farm: 'Farm', orchard: 'Apple orchard', huntingLodge: 'Hunting lodge', lumberMill: 'Lumber mill', quarry: 'Quarry', mine: 'Mine', smelter: 'Smelter', kitchen: 'Kitchen', house: 'House', barracks: 'Barracks', church: 'Church', market: 'Market', wall: 'Wall', tower: 'Tower', barbican: 'Barbican' },
    buildingDescriptions: {
      mill: 'Supports up to two farms within a two-cell radius.', farm: 'Produces flour at scale on open plains and requires an active mill.', orchard: 'A dependable fruit source on clear passable ground.', huntingLodge: 'A compact source of meat that needs a dense forest edge.', lumberMill: 'Produces wood from a clear passable cell beside a forest.', quarry: 'Extracts stone on a clear hill.', mine: 'Extracts ore on a clear hill cell.', smelter: 'Processes ore into iron when enough workers are assigned.', kitchen: 'Serves a growing settlement and lets housing spread beyond the castle.',
      house: 'Raises housing capacity. Must be within 5 cells of a castle or kitchen.', barracks: 'Forms squads around the full perimeter of the building.',
      church: 'Improves population growth and requires ongoing upkeep.',
      market: 'Lets you sell surpluses and buy resources you are missing. Each domain may have only one market.',
      wall: 'A durable barrier that takes reduced damage from ordinary troops.', tower: 'Holds up to 5 archers and lets the protected garrison fire from cover.',
      barbican: 'A gate for friendly squads. Enemies can breach it faster than a wall or tower.',
    },
    troopNames: { militia: 'Militia', spearmen: 'Spearmen', archers: 'Archers', knights: 'Knights' },
    troopDescriptions: { militia: 'Cheap troops with baseline damage and durability.', spearmen: 'Slightly stronger and tougher than militia, but cheaper than archers.', archers: 'Fight like militia up close but shoot up to 8 cells away.', knights: 'Spearman damage, high durability and doubled movement cost.' },
    selectCell: 'Select an object or cell on the map', emptyCell: 'Open ground', castle: 'Castle', squad: 'Squad',
    terrainPlain: 'Plain', terrainHill: 'Height', terrainForest: 'Forest', hitPoints: 'Durability', defense: 'Defense', squadHealth: 'Endurance', damage: 'Damage', movementCost: 'Step', cost: 'Cost', free: 'Free', emergencyFree: 'Your first lumber mill is free when you cannot afford its wood cost.', perTurn: 'per turn',
    quantity: 'Quantity', placementMode: 'Construction', recruitmentMode: 'Form squad', splitMode: 'Split squad', dismissMode: 'Dismiss troops', garrisonEnterMode: 'Garrison tower', garrisonExitMode: 'Leave tower', towerAttackMode: 'Tower shot',
    buildHint: 'Choose a suitable cell inside your domain.', recruitHint: 'Choose a cell next to your castle or barracks.', moveHint: 'Choose an adjacent cell or a free cell beyond your barbican. Forest doubles the cost of a step.', knightMoveHint: 'Knights double the cost of a step, and forest doubles it once more.', archerRangeHint: 'Archers shoot in a straight line up to 8 cells away.', routeUnavailable: 'There is no clear path to that cell.', routeOrdersFinished: 'No orders remain — movement has stopped.', splitHint: 'Set the composition and choose a free adjacent cell.', dismissHint: 'Choose troops to return them to the civilian population without a resource refund.', garrisonEnterHint: 'Choose an adjacent squad containing archers.', garrisonExitHint: 'Choose an adjacent empty cell.', towerAttackHint: 'Choose an enemy target aligned with the tower.', squadActionHint: 'Move / attack', splitNewSquad: 'New squad', splitRemaining: 'Remaining',
    cancel: 'Cancel', split: 'Split', dismiss: 'Dismiss', confirmDismiss: 'Confirm', garrison: 'Garrison', garrisonEnter: 'Enter', garrisonExit: 'Exit', towerAttack: 'Fire', towerRange: 'Range', towerCapacity: 'Archers', armyLimit: 'Army', endTurn: 'End turn', opponentTurn: 'Opponent turn', endTurnHint: 'Production yields resources while civilians and troops consume food.', production: 'Production', foodDemand: 'Food use', civilianFoodDemand: 'Civilian food', buildingOutput: 'Building output', populationCapacity: 'Population capacity',
    workers: 'Workers', size: 'Size', forestNeighbors: 'Adjacent forest', farmCapacity: 'Farm capacity', supportRadius: 'Support radius', requiresMill: 'Requires a mill', processing: 'Processing', foodService: 'Serves civilians', serviceRadius: 'Service radius', workerProductionFull: 'The building is fully staffed.', workerProductionReduced: 'Too few workers: production is reduced.', workerProductionStopped: 'No workers: production has stopped.', workerProductionUnsupported: 'No active mill: production has stopped.', workerSupportIdle: 'No farms are linked, so no worker is needed yet.',
    taxes: 'Tax collection', taxRates: { none: 'No taxes', moderate: 'Moderate', extortionate: 'Extortionate' }, taxFoodShort: 'Food', taxOutputShort: 'Output', upkeep: 'Upkeep', nextTurn: 'After turn', stable: 'Supply is sufficient', deficit: 'Deficit expected', foodShortage: 'Food or service capacity will not meet demand', marketTitle: 'Market', marketDescription: 'Prices react to trade volume and reset after each turn.', marketPriceChangesIn: 'Price changes in {count}', marketUnitsToStep: '{count} to next tier', marketUnavailable: 'Demand is exhausted until next turn', foodSupply: 'Food supply', turnsOfSupply: 'About {count} turns of supply remain.', buy: 'Buy', sell: 'Sell',
    victoryTitle: 'The domains are conquered', victoryDescription: 'Every hostile castle has fallen. The map remains available for inspection.', defeatTitle: 'Your castle has fallen', defeatDescription: 'The domain is lost. You may inspect the map before returning to the main menu.', spectatorVictoryTitle: 'The battle is over', spectatorVictoryDescription: 'Winning side: {winner}. The battlefield remains available for inspection.', autoBattle: 'Auto battle', continue: 'Continue viewing', turnDesertion: 'A {unit} deserted because upkeep could not be paid.', turnStarvation: 'A civilian died from starvation.', turnCapacityLoss: 'A civilian left because housing or food service capacity was insufficient.', turnStarvationTroop: 'A {unit} died from starvation.',
    previousItems: 'Previous buildings', nextItems: 'Next buildings', buildingCategories: { resources: 'Resources', food: 'Food', settlement: 'Settlement' }, previousTroops: 'Previous troops', nextTroops: 'Next troops',
    failures: {
      'game-over': 'The match has already ended.', 'not-owned': 'You do not own this object.', occupied: 'This cell is occupied.', 'invalid-terrain': 'The terrain is unsuitable for this action.',
      'outside-domain': 'You may build only inside your domain.', 'outside-food-service': 'A house must be within 5 cells of a castle or kitchen.', 'requires-support': 'A farm needs a mill with free support capacity.', 'requires-farm-site': 'There is no clear farm site near this mill.', 'building-limit': 'This domain already has that unique building.', 'not-adjacent': 'A squad acts on an adjacent cell or passes through its own barbican.', 'not-enough-orders': 'There are not enough orders left this turn.',
      'not-enough-resources': 'Not enough resources.', 'not-enough-population': 'Not enough available people.', 'requires-barracks': 'Militia recruit next to a castle or barracks; every other troop requires a barracks.',
      'squad-full': 'This squad has no room for more troops.', 'army-full': 'This domain has reached its army limit.', 'invalid-squad': 'This squad cannot be formed.', 'invalid-garrison': 'A tower can hold only the allowed number of archers.', 'requires-garrison': 'This action requires a tower garrison.', 'requires-target': 'Choose an enemy target.', 'cannot-demolish': 'The castle cannot be demolished, and a tower must be emptied first.', 'requires-market': 'You can trade only through your own market.', 'invalid-trade': 'Invalid trade parameters.', 'market-exhausted': 'Demand at the current price is exhausted until next turn.', 'ranged-shot-blocked': 'A forest, peak or another object blocks the line of fire.', 'out-of-range': 'The target is outside attack range.',
    },
  },
  interface: {
    controlPanel: 'Control panel', controlSections: 'Control sections', mapAria: 'Game world map. Drag to move and use the wheel to zoom.',
    mapHint: 'Drag the map · wheel — zoom · Shift — domains · RMB / Ctrl + click — menu', settingsHint: 'Settings',
  },
  sound: {
    title: 'Sound', description: 'The master switch controls music and interface effects', effectsVolume: 'Effects', musicTitle: 'Music', musicDescription: 'The calm theme gives way to battle music when an enemy nears the domain', musicVolume: 'Music volume', enable: 'Enable sound', disable: 'Disable sound', enabled: 'On', disabled: 'Off',
  },
  contextMenu: {
    title: 'Cell actions', cell: 'Cell', goHere: 'Move here', splitSquad: 'Split squad', mergeSquads: 'Merge squads', dismissSquad: 'Disband squad', removeObject: 'Demolish building', refund: 'Refund', refundNone: 'No resources will be refunded',
  },
  confirmation: {
    cancel: 'Cancel', deleteMapTitle: 'Delete map?', deleteMapDescription: 'The map will be removed from this browser. This cannot be undone.', deleteMapAction: 'Delete',
    leaveTitle: 'Return to the main menu?', leaveDescription: 'Changes made after the latest save will be lost.', leaveAction: 'Leave',
  },
  settings: {
    title: 'Settings', close: 'Close settings', language: 'Language', languageDescription: 'Each interface language is loaded separately', grid: 'Map grid', gridDescription: 'Show cell borders and a stronger line every ten rows', gridEnabled: 'Show', gridDisabled: 'Hide', mainMenu: 'Main menu', mainMenuDescription: 'Return to map selection', saveGame: 'Save and load', saveGameDescription: 'Create new slots and return to saved games', manageGames: 'Open games',
  },
  savedGames: {
    kicker: 'GAMES', title: 'Save and load', close: 'Close saved games', empty: 'There are no saved games yet.', saveCurrent: 'Current game', saveCurrentDescription: 'Create a separate slot on the current turn.', saveUnavailable: 'Saving will be available after the opponent turn.', save: 'Save', loadSection: 'Load game', loadSectionDescription: 'The most recent saves are shown first.', slots: 'Slots', latest: 'Latest', load: 'Load', remove: 'Delete', turn: 'Turn', updated: 'Saved', saved: 'Game saved', saveFailed: 'Could not save the game', loadFailed: 'This save is corrupted, unavailable, or belongs to an incompatible game version', readFailed: 'Could not read the saved game list', deleteFailed: 'Could not delete the saved game', loadTitle: 'Load this game?', loadDescription: 'Unsaved progress in the current game will be lost.', loadConfirm: 'Load', deleteTitle: 'Delete this save?', deleteDescription: 'This progress cannot be recovered.',
  },
  generator: {
    title: 'World generator', close: 'Close generator',
    relief: 'Relief', mapSize: 'Map size', source: 'Source', automatic: 'Fully automatic', hybrid: 'Auto + manual nodes', manual: 'Mostly manual',
    hills: 'Hills and heights', peaks: 'Impassable peaks', formScale: 'Form scale', reliefDistribution: 'Edges ← relief → center',
    vegetation: 'Vegetation', coverage: 'Coverage', vegetationDistribution: 'Edges ← greenery → center', heightPreference: 'Height preference',
    lowlands: 'Lowlands', balanced: 'Mid elevations', highlands: 'Highlands', reliefInfluence: 'Relief influence',
    brushAria: 'Relief brush', erase: 'Erase', hill: 'Hill', mountain: 'Mountain', clearNodes: 'Clear nodes', previewAria: 'Map preview and large relief form editor',
    plain: 'Plain', elevation: 'Height', forest: 'Forest', peak: 'Peak', seed: 'Generation seed',
    traversableHeights: 'Traversable heights', impassablePeaks: 'Impassable peaks', forestCoverage: 'Forest coverage', cells: 'cells',
    note: 'Paint large nodes on the preview. They spread smoothly across real cells; forests avoid impassable peaks and steep slopes.',
    participants: 'Starting domains', participantLimit: 'A {size} × {size} map supports up to {count} domains.', regionsCalculating: 'Calculating domain borders…', regionsError: 'These settings do not leave enough suitable land', regionsUnbalanced: 'The domains could not be divided fairly — change the terrain or seed', regionsUnviable: 'The domains do not have the minimum room needed for early development', workerError: 'The background domain calculation failed.', retry: 'Retry calculation', saveError: 'The browser could not store this map. Free some space or check storage access.',
    newVariant: 'New variant', mapName: 'Map name', defaultMapName: 'My map', saveMap: 'Save to my maps', apply: 'Choose a domain',
  },
}

export default en
