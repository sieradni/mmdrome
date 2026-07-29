import type { FrequencyPoint } from './eqResponseCalculator'
import type { EqFilterConfig } from './eqTypes'
import { interpolateGraphicEqPoints, filtersToPoints } from './graphicEqEngine'

/**
 * Calculates total frequency response curve for GraphicEQ mode (straight-line log-frequency interpolation).
 */
export function calculateGraphicTotalResponse(
  preampDb: number,
  filters: EqFilterConfig[],
  pointCount = 150
): FrequencyPoint[] {
  const points = filtersToPoints(filters)

  const minFreq = 20
  const maxFreq = 20000
  const logMin = Math.log10(minFreq)
  const logMax = Math.log10(maxFreq)

  const responsePoints: FrequencyPoint[] = []

  for (let i = 0; i < pointCount; i++) {
    const logF = logMin + (i / (pointCount - 1)) * (logMax - logMin)
    const freq = Math.pow(10, logF)
    const gainDb = points.length > 0 ? interpolateGraphicEqPoints(points, freq) : 0

    responsePoints.push({
      frequency: freq,
      gainDb: preampDb + gainDb,
    })
  }

  return responsePoints
}
