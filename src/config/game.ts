export const gameConfig = {
  map: {
    columns: 100,
    rows: 100,
    cellSize: 34,
  },
  turn: {
    maxOrders: 4,
  },
  audio: {
    defaultEnabled: true,
    storageKey: 'castle-turns:sound-enabled',
  },
} as const
