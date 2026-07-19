import type { BuildingKind, ResourceId, TroopKind } from '../game/map'

export type ResourceAmount = Partial<Record<ResourceId, number>>

export interface BuildingRule {
  actionCost: number
  resourceCost: ResourceAmount
  production: ResourceAmount
  hitPoints: number
  populationCapacity: number
  populationGrowth?: number
  upkeep?: ResourceAmount
  placement: 'open' | 'plain' | 'forest' | 'hill'
  footprint?: { columns: number; rows: number }
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
  foodPerPerson: number
  productionAdjustment: number
}

export const resourceIds: ResourceId[] = ['wood', 'stone', 'iron', 'grain', 'meat', 'gold']
export const economyBuildingKinds: BuildingKind[] = ['farm', 'lumberMill', 'quarry', 'house', 'barracks', 'church', 'market']
export const fortificationKinds: BuildingKind[] = ['wall', 'tower', 'barbican']
export const buildingKinds: BuildingKind[] = [...economyBuildingKinds, ...fortificationKinds]
export const troopKinds: TroopKind[] = ['militia', 'spearmen', 'archers', 'knights']

export const buildingRules: Record<BuildingKind, BuildingRule> = {
  farm: {
    actionCost: 4,
    resourceCost: { wood: 24, gold: 6 },
    production: { grain: 18, meat: 2 },
    hitPoints: 10,
    populationCapacity: 0,
    placement: 'plain',
    footprint: { columns: 2, rows: 2 },
  },
  lumberMill: {
    actionCost: 4,
    resourceCost: { wood: 14, stone: 5, gold: 5 },
    production: { wood: 16 },
    hitPoints: 15,
    populationCapacity: 0,
    placement: 'forest',
  },
  quarry: {
    actionCost: 4,
    resourceCost: { wood: 20, gold: 8 },
    production: { stone: 12, iron: 2 },
    hitPoints: 18,
    populationCapacity: 0,
    placement: 'hill',
    footprint: { columns: 2, rows: 2 },
  },
  house: {
    actionCost: 4,
    resourceCost: { wood: 25, stone: 10 },
    production: {},
    hitPoints: 10,
    populationCapacity: 10,
    placement: 'open',
  },
  barracks: {
    actionCost: 6,
    resourceCost: { wood: 36, stone: 30, gold: 18 },
    production: {},
    hitPoints: 25,
    populationCapacity: 0,
    placement: 'open',
    footprint: { columns: 2, rows: 2 },
  },
  church: {
    actionCost: 6,
    resourceCost: { wood: 20, stone: 45, gold: 60 },
    production: {},
    upkeep: { gold: 4 },
    hitPoints: 30,
    populationCapacity: 0,
    populationGrowth: 1,
    placement: 'open',
    footprint: { columns: 2, rows: 2 },
  },
  market: {
    actionCost: 4,
    resourceCost: { wood: 32, stone: 18, gold: 20 },
    production: {},
    hitPoints: 18,
    populationCapacity: 0,
    placement: 'open',
  },
  wall: {
    actionCost: 2,
    resourceCost: { stone: 18, wood: 4 },
    production: {},
    hitPoints: 50,
    populationCapacity: 0,
    placement: 'open',
  },
  tower: {
    actionCost: 6,
    resourceCost: { wood: 24, stone: 42, iron: 6, gold: 10 },
    production: {},
    hitPoints: 30,
    populationCapacity: 0,
    placement: 'open',
  },
  barbican: {
    actionCost: 6,
    resourceCost: { wood: 30, stone: 60, iron: 10, gold: 20 },
    production: {},
    hitPoints: 70,
    populationCapacity: 0,
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
    resourceCost: { grain: 4, iron: 2, gold: 10 },
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
  iron: 28,
  grain: 90,
  meat: 24,
  gold: 105,
}

export const castleProduction: ResourceAmount = { grain: 8, gold: 2 }

export const defaultTaxRate: TaxRate = 'moderate'
export const taxRates: Record<TaxRate, TaxRule> = {
  none: { goldPerPerson: 0, foodPerPerson: 0, productionAdjustment: 0 },
  moderate: { goldPerPerson: 0.5, foodPerPerson: 0.08, productionAdjustment: 0 },
  extortionate: { goldPerPerson: 1, foodPerPerson: 0.2, productionAdjustment: -1 },
}

export const tradeableResources: Exclude<ResourceId, 'gold'>[] = ['wood', 'stone', 'iron', 'grain', 'meat']
export const marketPrices: Record<Exclude<ResourceId, 'gold'>, { buy: number; sell: number }> = {
  wood: { buy: 3, sell: 1 },
  stone: { buy: 4, sell: 2 },
  iron: { buy: 7, sell: 4 },
  grain: { buy: 2, sell: 1 },
  meat: { buy: 4, sell: 2 },
}
