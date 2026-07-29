import type { FrequencyPoint } from './eqResponseCalculator'
import type { EqFilterConfig } from './eqTypes'
import type { EqPoint } from './eqTypes'
import { interpolateGraphicEqPoints, filtersToPoints } from './graphicEqEngine'

/**
 * Calculates total frequency response curve for GraphicEQ mode.
 * When graphicEqCurves are provided (multi-curve stacking), their dB gains
 * are summed per frequency. Falls back to flat filter-to-point conversion
 * if no curve groups are given.
 */
export function calculateGraphicTotalResponse(
  preampDb: number,
  filters: EqFilterConfig[],
  graphicEqCurves?: EqPoint[][],
  pointCount = 150
): FrequencyPoint[] {
  const curves = graphicEqCurves && graphicEqCurves.length > 0
    ? graphicEqCurves.map((c) => [...c].sort((a, b) => a.frequency - b.frequency))
    : [filtersToPoints(filters)]

  const minFreq = 20
  const maxFreq = 20000
  const logMin = Math.log10(minFreq)
  const logMax = Math.log10(maxFreq)

  const responsePoints: FrequencyPoint[] = []

  for (let i = 0; i < pointCount; i++) {
    const logF = logMin + (i / (pointCount - 1)) * (logMax - logMin)
    const freq = Math.pow(10, logF)

    let totalGainDb = 0
    for (const curve of curves) {
      totalGainDb += curve.length > 0 ? interpolateGraphicEqPoints(curve, freq) : 0
    }

    responsePoints.push({
      frequency: freq,
      gainDb: preampDb + totalGainDb,
    })
  }

  return responsePoints
}
