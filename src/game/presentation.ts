import { aiParticipantDisplayName, type LocaleDictionary } from '../config/localization'
import { resourceIds, type ResourceAmount } from '../config/rules'
import type { BuildingKind } from './map'
import type { MatchState, TurnReport } from './match'
import { participantTeamId } from './scenario'

export function turnReportMessage(report: TurnReport | undefined, text: LocaleDictionary) {
  if (!report) return null
  const messages: string[] = []
  if (report.desertion) messages.push(text.game.turnDesertion.replace('{unit}', text.game.troopNames[report.desertion.kind]))
  if (report.populationReason === 'starvation') messages.push(text.game.turnStarvation)
  else if (report.populationReason === 'capacity') messages.push(text.game.turnCapacityLoss)
  if (report.starvation && report.starvation !== 'civilian')
    messages.push(text.game.turnStarvationTroop.replace('{unit}', text.game.troopNames[report.starvation.kind]))
  return messages.join(' ') || null
}

export function demolitionRefundText(refund: ResourceAmount, text: LocaleDictionary, locale: string) {
  const parts = resourceIds.flatMap((resource) => {
    const amount = refund[resource] ?? 0
    return amount > 0 ? [`${amount} ${text.game.resourceNames[resource].toLocaleLowerCase(locale)}`] : []
  })
  return parts.length > 0 ? `${text.contextMenu.refund}: ${parts.join(' · ')}` : text.contextMenu.refundNone
}

export function mapObjectDisplayName(
  object: { type: 'castle' | 'squad' } | { type: 'building'; kind: BuildingKind },
  text: LocaleDictionary,
) {
  if (object.type === 'building') return text.game.buildingNames[object.kind]
  return object.type === 'squad' ? text.game.squad : text.game.castle
}

export function spectatorWinnerName(match: MatchState, text: LocaleDictionary) {
  const livingParticipants = match.scenario.participants.filter((participant) =>
    match.scenario.cells.some((row) => row.some((cell) => cell.object?.type === 'castle' && cell.object.ownerId === participant.id)),
  )
  const winningSide = livingParticipants[0] ? participantTeamId(livingParticipants[0]) : undefined
  if (winningSide === undefined) return undefined
  return livingParticipants
    .filter((participant) => participantTeamId(participant) === winningSide)
    .map((participant) => aiParticipantDisplayName(text.opponents, match.scenario.participants, participant.id))
    .join(' · ')
}
