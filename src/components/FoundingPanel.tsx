import type { CSSProperties } from 'react'
import type { LocaleDictionary } from '../config/localization'
import type { CellPosition, MapScenario } from '../game/scenario'

interface FoundingPanelProps {
  scenario: MapScenario
  selectedRegionId: string | null
  castleDraft: CellPosition | null
  draftValid: boolean
  text: LocaleDictionary['founding']
  onSelectRegion: (regionId: string | null) => void
  onConfirm: () => void
}

export function FoundingPanel({ scenario, selectedRegionId, castleDraft, draftValid, text, onSelectRegion, onConfirm }: FoundingPanelProps) {
  const selectedRegion = scenario.regions.find((region) => region.id === selectedRegionId)
  return (
    <section className="founding-panel" aria-live="polite">
      <header>
        <span>{selectedRegion ? '02' : '01'}</span>
        <div><h1>{selectedRegion ? text.placeTitle : text.chooseTitle}</h1><p>{selectedRegion ? text.placeDescription : text.chooseDescription}</p></div>
      </header>
      {!selectedRegion ? (
        <div className="region-options">
          {scenario.regions.map((region) => (
            <button type="button" key={region.id} style={{ '--region-color': region.color } as CSSProperties} onClick={() => onSelectRegion(region.id)}>
              <i>{region.index + 1}</i><strong>{text.region} {region.index + 1}</strong>
              <dl><div><dt>{text.land}</dt><dd>{region.score.cells}</dd></div><div><dt>{text.forest}</dt><dd>{Math.round(region.score.forest / region.score.cells * 100)}%</dd></div><div><dt>{text.hills}</dt><dd>{Math.round(region.score.hills / region.score.cells * 100)}%</dd></div></dl>
            </button>
          ))}
        </div>
      ) : (
        <div className="founding-actions">
          <div className="chosen-region"><i style={{ background: selectedRegion.color }}>{selectedRegion.index + 1}</i><span>{text.region} {selectedRegion.index + 1}<small>{text.selected}</small></span></div>
          <div className={`site-status ${castleDraft && draftValid ? 'valid' : ''}`}><span aria-hidden="true">{castleDraft && draftValid ? '◆' : '◇'}</span>{!castleDraft ? text.chooseSite : draftValid ? text.validSite : text.invalidSite}</div>
          <button type="button" className="change-region" onClick={() => onSelectRegion(null)}>{text.changeRegion}</button>
          <button type="button" className="confirm-founding" disabled={!castleDraft || !draftValid} onClick={onConfirm}>{text.confirm}</button>
        </div>
      )}
      <footer>{text.shiftHint}</footer>
    </section>
  )
}
