import { resourceIds, tradeableResources } from '../../config/rules'
import { aiPlannerConfig } from '../../config/ai'
import { gameConfig } from '../../config/game'
import { squadHealth, type DomainEconomy, type MatchState } from '../match'
import { calculateVisibility, isCellVisible, visibleObjectAt } from '../visibility'
import { areOwnersHostile } from '../scenario'
import { createAiMemory, type AiContact, type AiMemory } from './model'

const contactKey = (contact: Pick<AiContact, 'ownerId' | 'kind' | 'position'>) => `${contact.ownerId}:${contact.kind}:${contact.position.column}:${contact.position.row}`

function redactedDomain(): DomainEconomy {
  return {
    resources: Object.fromEntries(resourceIds.map((resource) => [resource, 0])) as DomainEconomy['resources'],
    population: 0,
    taxRate: 'moderate',
    diverseDiet: false,
    marketActivity: {
      bought: Object.fromEntries(tradeableResources.map((resource) => [resource, 0])) as DomainEconomy['marketActivity']['bought'],
      sold: Object.fromEntries(tradeableResources.map((resource) => [resource, 0])) as DomainEconomy['marketActivity']['sold'],
    },
  }
}

export function updateAiMemory(
  state: MatchState,
  ownerId: string,
  previous: AiMemory,
  fogEnabled: boolean = gameConfig.visibility.enabled,
): AiMemory {
  const normalized = { ...createAiMemory(), ...previous }
  if (!fogEnabled) {
    return {
      ...normalized,
      contacts: [],
      blockedCells: normalized.blockedCells.filter((entry) => entry.expiresTurn >= state.turn),
    }
  }
  const visibility = calculateVisibility(state.scenario.cells, ownerId, fogEnabled)
  const contacts = new Map(normalized.contacts
    .filter((contact) => state.turn - contact.lastSeenTurn <= aiPlannerConfig.targetMemoryTurns)
    .map((contact) => [contactKey(contact), contact]))
  const contactsByPosition = new Map<string, string[]>()
  contacts.forEach((contact, key) => {
    const position = `${contact.position.column}:${contact.position.row}`
    contactsByPosition.set(position, [...(contactsByPosition.get(position) ?? []), key])
  })
  for (let row = 0; row < state.scenario.cells.length; row += 1) {
    for (let column = 0; column < state.scenario.cells[row].length; column += 1) {
      const position = { column, row }
      if (!isCellVisible(visibility, position)) continue
      for (const key of contactsByPosition.get(`${column}:${row}`) ?? []) contacts.delete(key)
      const object = state.scenario.cells[row][column].object
      if (!object || !areOwnersHostile(state.scenario.participants, ownerId, object.ownerId)) continue
      const kind = object.type === 'squad' ? 'squad' : object.type === 'building' && object.kind === 'barracks' ? 'barracks' : null
      if (!kind) continue
      const contact: AiContact = object.type === 'squad'
        ? { ownerId: object.ownerId, kind, position, lastSeenTurn: state.turn, units: { ...object.units }, health: squadHealth(object) }
        : { ownerId: object.ownerId, kind, position, lastSeenTurn: state.turn }
      contacts.set(contactKey(contact), contact)
    }
  }
  const remembered = [...contacts.values()]
    .sort((a, b) => b.lastSeenTurn - a.lastSeenTurn || a.ownerId.localeCompare(b.ownerId) || a.position.row - b.position.row || a.position.column - b.position.column)
    .slice(0, aiPlannerConfig.maximumRememberedContacts)
    .sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.position.row - b.position.row || a.position.column - b.position.column)
  return {
    ...normalized,
    contacts: remembered,
    blockedCells: normalized.blockedCells.filter((entry) => entry.expiresTurn >= state.turn),
  }
}

export function createAiPerception(
  state: MatchState,
  ownerId: string,
  previous: AiMemory,
  fogEnabled: boolean = gameConfig.visibility.enabled,
) {
  const memory = updateAiMemory(state, ownerId, previous, fogEnabled)
  const visibility = fogEnabled ? calculateVisibility(state.scenario.cells, ownerId, true) : null
  const cells = fogEnabled && visibility
    ? state.scenario.cells.map((row, rowIndex) => row.map((cell, column) => {
        const object = visibleObjectAt(state.scenario.cells, visibility, ownerId, { column, row: rowIndex })
        return object === cell.object ? cell : { ...cell, object }
      }))
    : state.scenario.cells
  const domains = Object.fromEntries(Object.entries(state.domains).map(([participantId, domain]) => [participantId, participantId === ownerId ? domain : redactedDomain()]))
  return { state: { ...state, scenario: { ...state.scenario, cells }, domains }, memory, visibility }
}
