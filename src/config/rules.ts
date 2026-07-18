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
  placement: 'open' | 'forest' | 'hill'
}

export interface TroopRule {
  actionCost: number
  resourceCost: ResourceAmount
  populationCost: number
  strength: number
}

export const resourceIds: ResourceId[] = ['wood', 'stone', 'iron', 'grain', 'meat', 'gold']
export const economyBuildingKinds: BuildingKind[] = ['farm', 'lumberMill', 'quarry', 'house', 'barracks', 'church']
export const fortificationKinds: BuildingKind[] = ['wall', 'tower', 'barbican']
export const buildingKinds: BuildingKind[] = [...economyBuildingKinds, ...fortificationKinds]
export const troopKinds: TroopKind[] = ['militia', 'spearmen', 'archers']

export const buildingRules: Record<BuildingKind, BuildingRule> = {
  farm: {
    actionCost: 2,
    resourceCost: { wood: 24, gold: 6 },
    production: { grain: 18, meat: 2 },
    hitPoints: 10,
    populationCapacity: 0,
    placement: 'open',
  },
  lumberMill: {
    actionCost: 2,
    resourceCost: { wood: 14, stone: 5, gold: 5 },
    production: { wood: 16 },
    hitPoints: 15,
    populationCapacity: 0,
    placement: 'forest',
  },
  quarry: {
    actionCost: 2,
    resourceCost: { wood: 20, gold: 8 },
    production: { stone: 12, iron: 2 },
    hitPoints: 18,
    populationCapacity: 0,
    placement: 'hill',
  },
  house: {
    actionCost: 2,
    resourceCost: { wood: 25, stone: 10 },
    production: {},
    hitPoints: 10,
    populationCapacity: 10,
    placement: 'open',
  },
  barracks: {
    actionCost: 3,
    resourceCost: { wood: 36, stone: 30, gold: 18 },
    production: {},
    hitPoints: 25,
    populationCapacity: 0,
    placement: 'open',
  },
  church: {
    actionCost: 3,
    resourceCost: { wood: 20, stone: 45, gold: 60 },
    production: {},
    upkeep: { gold: 4 },
    hitPoints: 30,
    populationCapacity: 0,
    populationGrowth: 1,
    placement: 'open',
  },
  wall: {
    actionCost: 1,
    resourceCost: { stone: 18, wood: 4 },
    production: {},
    hitPoints: 50,
    populationCapacity: 0,
    placement: 'open',
  },
  tower: {
    actionCost: 3,
    resourceCost: { wood: 24, stone: 42, iron: 6, gold: 10 },
    production: {},
    hitPoints: 30,
    populationCapacity: 0,
    placement: 'open',
  },
  barbican: {
    actionCost: 3,
    resourceCost: { wood: 30, stone: 60, iron: 10, gold: 20 },
    production: {},
    hitPoints: 70,
    populationCapacity: 0,
    placement: 'open',
  },
}

export const troopRules: Record<TroopKind, TroopRule> = {
  militia: {
    actionCost: 1,
    resourceCost: { grain: 4, gold: 8 },
    populationCost: 1,
    strength: 1,
  },
  spearmen: {
    actionCost: 1,
    resourceCost: { grain: 4, iron: 3, gold: 12 },
    populationCost: 1,
    strength: 1.45,
  },
  archers: {
    actionCost: 1,
    resourceCost: { wood: 4, grain: 4, gold: 14 },
    populationCost: 1,
    strength: 1.3,
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

export const castleProduction: ResourceAmount = { grain: 8, gold: 10 }
