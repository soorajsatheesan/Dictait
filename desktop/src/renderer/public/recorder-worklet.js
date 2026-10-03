// Collects mono samples off the audio thread and reports a level for every 32 ms block.
class DictaitRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(512)
    this.length = 0
    this.port.onmessage = (event) => {
      if (event.data === 'flush') { this.flush(); this.port.postMessage({ flushed: true }) }
    }
  }

  process(inputs) {
    const input = inputs[0]
    if (input && input.length) {
      const channels = input.length
      const frames = input[0].length
      for (let i = 0; i < frames; i++) {
        let sample = 0
        for (let c = 0; c < channels; c++) sample += input[c][i]
        this.block[this.length++] = sample / channels
        if (this.length === this.block.length) this.flush()
      }
    }
    return true
  }

  flush() {
    if (!this.length) return
    const samples = this.block.slice(0, this.length)
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
    this.port.postMessage({ samples, rms: Math.sqrt(sum / samples.length) }, [samples.buffer])
    this.length = 0
  }
}

registerProcessor('dictait-recorder', DictaitRecorder)
