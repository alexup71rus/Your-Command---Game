export const cardinalDirections = [
  { column: 1, row: 0 },
  { column: -1, row: 0 },
  { column: 0, row: 1 },
  { column: 0, row: -1 },
] as const

/** Clockwise order used when deterministic AI preference should sweep a front. */
export const clockwiseCardinalDirections = [
  { column: 1, row: 0 },
  { column: 0, row: 1 },
  { column: -1, row: 0 },
  { column: 0, row: -1 },
] as const
