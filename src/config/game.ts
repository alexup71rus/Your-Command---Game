export const gameConfig = {
  map: {
    columns: 100,
    rows: 100,
    cellSize: 50,
  },
  generator: {
    editorColumns: 12,
    editorRows: 12,
    defaultSeed: 4127,
  },
  turn: {
    maxOrders: 4,
  },
  audio: {
    defaultVolume: 70,
    volumeStorageKey: 'castle-turns:sound-volume',
    lastVolumeStorageKey: 'castle-turns:last-sound-volume',
    legacyEnabledStorageKey: 'castle-turns:sound-enabled',
    gainMultiplier: 2.8,
  },
  camera: {
    minZoom: 0.3,
    maxZoom: 1.5,
    wheelSensitivity: 0.0015,
    dragThreshold: 5,
  },
  navigationHint: {
    storageKey: 'castle-turns:navigation-hint-seen',
    masteredDelayMs: 10_000,
    partialDelayMs: 60_000,
  },
} as const
