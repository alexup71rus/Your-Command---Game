import type { BuildingKind, ResourceId, TroopKind } from '../game/map'

export type ResourceAmount = Partial<Record<ResourceId, number>>

export interface BuildingRule {
  actionCost: number
  resourceCost: ResourceAmount
  production: ResourceAmount
  hitPoints: number
  housingCapacity?: number
  incomingDamageMultiplier?: number
  allowsFriendlyPassage?: boolean
  populationGrowth?: number
  upkeep?: ResourceAmount
  placement: 'open' | 'plain' | 'hill'
  minimumAdjacentForestCells?: number
  workersRequired?: number
  foodServiceCapacity?: number
  requiresFoodServiceAccess?: boolean
  processing?: {
    input: ResourceId
    output: ResourceId
    maximumPerTurn: number
  }
  footprint?: { columns: number; rows: number }
  garrison?: {
    troop: 'archers'
    capacity: number
    transferOrderCost: number
    attackOrderCost: number
    attackRange: number
    visibilityRadius: number
    heightDamageMultiplier: number
  }
}

export interface TroopRule {
  actionCost: number
  resourceCost: ResourceAmount
  populationCost: number
  damage: number
  durability: number
  upkeep: ResourceAmount
}

export type TaxRate = 'none' | 'moderate' | 'extortionate'

export interface TaxRule {
  goldPerPerson: number
  foodDemandMultiplier: number
  productionAdjustment: number
}

export const resourceIds: ResourceId[] = ['wood', 'stone', 'ore', 'iron', 'grain', 'meat', 'gold']
export const economyBuildingKinds: BuildingKind[] = ['farm', 'huntingLodge', 'lumberMill', 'quarry', 'mine', 'smelter', 'kitchen', 'house', 'barracks', 'church', 'market']
export const fortificationKinds: BuildingKind[] = ['wall', 'tower', 'barbican']
export const buildingKinds: BuildingKind[] = [...economyBuildingKinds, ...fortificationKinds]
export const troopKinds: TroopKind[] = ['militia', 'spearmen', 'archers', 'knights']
export const workerBuildingKinds: BuildingKind[] = ['farm', 'huntingLodge', 'kitchen', 'lumberMill', 'quarry', 'mine', 'smelter']
export const starvationTroopOrder: TroopKind[] = ['militia', 'spearmen', 'archers', 'knights']

export const buildingRules: Record<BuildingKind, BuildingRule> = {
  farm: {
    actionCost: 4,
    resourceCost: { wood: 28, stone: 8, gold: 8 },
    production: { grain: 18 },
    hitPoints: 10,
    placement: 'plain',
    workersRequired: 2,
    footprint: { columns: 2, rows: 2 },
  },
  huntingLodge: {
    actionCost: 4,
    resourceCost: { wood: 18, stone: 5, gold: 8 },
    production: { meat: 6 },
    hitPoints: 12,
    placement: 'open',
    minimumAdjacentForestCells: 2,
    workersRequired: 1,
  },
  lumberMill: {
    actionCost: 4,
    resourceCost: { wood: 14, stone: 5, gold: 5 },
    production: { wood: 16 },
    hitPoints: 15,
    placement: 'open',
    minimumAdjacentForestCells: 1,
    workersRequired: 1,
  },
  quarry: {
    actionCost: 4,
    resourceCost: { wood: 20, gold: 8 },
    production: { stone: 12 },
    hitPoints: 18,
    placement: 'hill',
    workersRequired: 2,
    footprint: { columns: 2, rows: 2 },
  },
  mine: {
    actionCost: 4,
    resourceCost: { wood: 18, stone: 8, gold: 10 },
    production: { ore: 6 },
    hitPoints: 15,
    placement: 'hill',
    workersRequired: 1,
  },
  smelter: {
    actionCost: 4,
    resourceCost: { wood: 32, stone: 28, gold: 24 },
    production: {},
    processing: { input: 'ore', output: 'iron', maximumPerTurn: 5 },
    hitPoints: 22,
    placement: 'open',
    workersRequired: 2,
    footprint: { columns: 2, rows: 2 },
  },
  kitchen: {
    actionCost: 4,
    resourceCost: { wood: 20, stone: 12, gold: 8 },
    production: {},
    hitPoints: 14,
    foodServiceCapacity: 20,
    placement: 'open',
    workersRequired: 1,
  },
  house: {
    actionCost: 4,
    resourceCost: { wood: 25, stone: 10 },
    production: {},
    hitPoints: 10,
    housingCapacity: 10,
    placement: 'open',
    requiresFoodServiceAccess: true,
  },
  barracks: {
    actionCost: 6,
    resourceCost: { wood: 36, stone: 30, gold: 18 },
    production: {},
    hitPoints: 25,
    placement: 'open',
    footprint: { columns: 2, rows: 2 },
  },
  church: {
    actionCost: 6,
    resourceCost: { wood: 20, stone: 45, gold: 60 },
    production: {},
    upkeep: { gold: 4 },
    hitPoints: 30,
    populationGrowth: 1,
    placement: 'open',
    footprint: { columns: 2, rows: 2 },
  },
  market: {
    actionCost: 4,
    resourceCost: { wood: 32, stone: 18, gold: 20 },
    production: {},
    hitPoints: 18,
    placement: 'open',
  },
  wall: {
    actionCost: 2,
    resourceCost: { stone: 18, wood: 4 },
    production: {},
    hitPoints: 50,
    incomingDamageMultiplier: 0.35,
    placement: 'open',
  },
  tower: {
    actionCost: 6,
    resourceCost: { wood: 24, stone: 42, gold: 10 },
    production: {},
    hitPoints: 30,
    placement: 'open',
    garrison: {
      troop: 'archers',
      capacity: 5,
      transferOrderCost: 2,
      attackOrderCost: 1,
      attackRange: 10,
      visibilityRadius: 12,
      heightDamageMultiplier: 1.2,
    },
  },
  barbican: {
    actionCost: 4,
    resourceCost: { wood: 16, stone: 28, iron: 2, gold: 8 },
    production: {},
    hitPoints: 20,
    allowsFriendlyPassage: true,
    placement: 'open',
  },
}

export const troopRules: Record<TroopKind, TroopRule> = {
  militia: {
    actionCost: 2,
    resourceCost: { grain: 4, gold: 8 },
    populationCost: 1,
    damage: 1,
    durability: 1,
    upkeep: { gold: 0.5 },
  },
  spearmen: {
    actionCost: 2,
    resourceCost: { grain: 4, iron: 1, gold: 10 },
    populationCost: 1,
    damage: 1.2,
    durability: 1.35,
    upkeep: { gold: 1 },
  },
  archers: {
    actionCost: 2,
    resourceCost: { wood: 4, grain: 4, gold: 16 },
    populationCost: 1,
    damage: 1,
    durability: 1,
    upkeep: { gold: 1.25 },
  },
  knights: {
    actionCost: 2,
    resourceCost: { grain: 6, meat: 2, iron: 8, gold: 24 },
    populationCost: 1,
    damage: 1.2,
    durability: 2.5,
    upkeep: { gold: 2.5 },
  },
}

export const startingResources: Record<ResourceId, number> = {
  wood: 110,
  stone: 80,
  ore: 0,
  iron: 16,
  grain: 36,
  meat: 12,
  gold: 105,
}

export const castleProduction: ResourceAmount = { grain: 4, gold: 2 }

export const defaultTaxRate: TaxRate = 'moderate'
export const taxRates: Record<TaxRate, TaxRule> = {
  none: { goldPerPerson: 0, foodDemandMultiplier: 1, productionAdjustment: 0 },
  moderate: { goldPerPerson: 1, foodDemandMultiplier: 1.5, productionAdjustment: -1 },
  extortionate: { goldPerPerson: 2, foodDemandMultiplier: 2, productionAdjustment: -3 },
}

export const tradeableResources: Exclude<ResourceId, 'gold'>[] = ['wood', 'stone', 'ore', 'iron', 'grain', 'meat']
export const marketPrices: Record<Exclude<ResourceId, 'gold'>, { buy: number; sell: number }> = {
  wood: { buy: 3, sell: 1 },
  stone: { buy: 4, sell: 2 },
  ore: { buy: 5, sell: 3 },
  iron: { buy: 10, sell: 6 },
  grain: { buy: 2, sell: 1 },
  meat: { buy: 4, sell: 2 },
}
