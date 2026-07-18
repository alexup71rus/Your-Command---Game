import type { GeneratorSettings } from './generator'
import { defaultGeneratorSettings } from './generator'

export type PresetId = 'greenMarches' | 'highlandPasses' | 'woodedBorder'

export interface MapPreset {
  id: PresetId
  settings: GeneratorSettings
}

export const mapPresets: MapPreset[] = [
  {
    id: 'greenMarches',
    settings: { ...defaultGeneratorSettings, seed: 4127, hillCoverage: 26, peakCoverage: 3, vegetationDensity: 30, heightDistribution: 22 },
  },
  {
    id: 'highlandPasses',
    settings: { ...defaultGeneratorSettings, seed: 27183, hillCoverage: 48, peakCoverage: 10, vegetationDensity: 25, reliefScale: 38, heightDistribution: -6 },
  },
  {
    id: 'woodedBorder',
    settings: { ...defaultGeneratorSettings, seed: 73421, hillCoverage: 34, peakCoverage: 5, vegetationDensity: 52, vegetationHeight: 'lowlands', heightInfluence: 72 },
  },
]
