interface EqProcessorMessage {
  type: 'set-coefficients' | 'set-bypass'
  coeffs?: Float64Array[]
  bypassed?: boolean
}

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: AudioWorkletNodeOptions)
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void

class EqProcessor extends AudioWorkletProcessor {
  private _coeffs: Float64Array[] = []
  private _states: Float64Array[] = []
  private _bypassed = false
  private _numFilters = 0
  private _numChannels = 2

  constructor() {
    super()
    this.port.onmessage = this._onMessage.bind(this)
  }

  private _onMessage(event: MessageEvent<EqProcessorMessage>): void {
    const msg = event.data

    if (msg.type === 'set-coefficients' && msg.coeffs) {
      this._coeffs = msg.coeffs.map(c => new Float64Array(c))
      this._states = this._coeffs.map(() => new Float64Array(this._numChannels * 2))
      this._numFilters = this._coeffs.length
      this._bypassed = msg.bypassed ?? this._bypassed
    } else if (msg.type === 'set-bypass') {
      this._bypassed = msg.bypassed ?? false
      if (!this._bypassed) {
        for (const s of this._states) { s.fill(0) }
      }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _params: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0]
    const output = outputs[0]

    if (!input?.length || !output?.length) return true

    const numCh = Math.min(input.length, output.length, this._numChannels)

    if (this._bypassed || this._numFilters === 0) {
      for (let ch = 0; ch < numCh; ch++) {
        output[ch].set(input[ch])
      }
      for (let ch = numCh; ch < output.length; ch++) {
        output[ch].fill(0)
      }
      return true
    }

    for (let ch = 0; ch < numCh; ch++) {
      const inCh = input[ch]
      const outCh = output[ch]
      const len = inCh.length

      for (let i = 0; i < len; i++) {
        let x = inCh[i]

        for (let f = 0; f < this._numFilters; f++) {
          const c = this._coeffs[f]
          const s = this._states[f]
          const w1 = s[ch * 2]
          const w2 = s[ch * 2 + 1]

          const w0 = x - c[3] * w1 - c[4] * w2
          x = c[0] * w0 + c[1] * w1 + c[2] * w2

          s[ch * 2] = w0
          s[ch * 2 + 1] = w1
        }

        outCh[i] = x
      }
    }

    for (let ch = numCh; ch < output.length; ch++) {
      output[ch].fill(0)
    }

    return true
  }
}

registerProcessor('eq-processor', EqProcessor)
