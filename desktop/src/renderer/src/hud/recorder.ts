const RATE = 16_000
/**
 * Speech is handed over in pieces cut at natural pauses, so words appear while you talk and
 * only the last few seconds remain when you stop. The longer a piece runs, the shorter the
 * pause that ends it; no piece runs past the limit.
 */
const CUTS: [seconds: number, pause: number][] = [[3, 0.45], [8, 0.25], [14, 0.12]]
const PIECE_LIMIT_SECONDS = 25
/** Keep up to 0.4 s of silent pre-roll so the start of the next word is never clipped. */
const PREROLL_SECONDS = 0.4
/** Minimum voiced audio before cutting a piece so pure-silence gaps never hit Whisper. */
const MIN_VOICED_SECONDS = 0.2

/** Map RMS to a perceptual 0–1 level: -52 dBFS is silence, -12 dBFS is a loud voice. */
export function levelFromRMS(rms: number): number {
  const db = 20 * Math.log10(rms + 1e-9)
  return Math.max(0, Math.min(1, (db + 52) / 40))
}

/**
 * Captures the microphone as 16 kHz mono 16-bit PCM WAV, the format the model worker expects.
 * The device opens only while recording, so macOS shows its microphone indicator only then.
 * Long dictations are handed over in pieces, cut at pauses, while the speaker keeps going.
 */
export class Recorder {
  onLevel: (level: number) => void = () => {}
  onEnded: () => void = () => {}
  onPiece: (audio: ArrayBuffer, index: number) => void = () => {}
  private pieceSamples = 0
  private quietSamples = 0
  private voicedSamples = 0
  private floor = 0
  private pieces = 0
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private chunks: Float32Array[] = []
  private session = 0

  get deviceName(): string { return this.stream?.getAudioTracks()[0]?.label ?? '' }

  /** `device` names a microphone to use instead of the system default (matched by label). */
  async start(device?: string | null, monitor = false): Promise<void> {
    this.cancel()
    const session = ++this.session
    let stream: MediaStream
    try {
      const deviceId = device ? await findDevice(device) : undefined
      const base = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: deviceId ? { exact: deviceId } : undefined, ...base }
        })
      } catch (error) {
        const name = (error as DOMException).name
        if (deviceId && (name === 'NotFoundError' || name === 'OverconstrainedError')) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: base })
        } else {
          throw error
        }
      }
    } catch (error) {
      const name = (error as DOMException).name
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('Microphone access is off. Allow Dictait in System Settings → Privacy & Security → Microphone.')
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('No microphone found. Check your input device in System Settings → Sound.')
      throw new Error('Could not start the microphone. Check your input device in System Settings → Sound.')
    }
    if (session !== this.session) { stream.getTracks().forEach((track) => track.stop()); throw new Error('Cancelled.') }
    let context: AudioContext
    try { context = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' }) } catch { context = new AudioContext({ latencyHint: 'interactive' }) }
    try { await context.audioWorklet.addModule(new URL('recorder-worklet.js', document.baseURI).href) }
    catch (error) { stream.getTracks().forEach((track) => track.stop()); void context.close(); throw error }
    if (session !== this.session) { stream.getTracks().forEach((track) => track.stop()); void context.close(); throw new Error('Cancelled.') }
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'dictait-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    const mute = context.createGain()
    mute.gain.value = 0
    node.port.onmessage = (event: MessageEvent<{ samples?: Float32Array; rms?: number }>) => {
      if (session !== this.session || !event.data.samples) return
      this.onLevel(levelFromRMS(event.data.rms ?? 0))
      if (monitor) return // Mic tests retain no samples and never produce transcription pieces.
      this.chunks.push(event.data.samples)
      this.considerCut(event.data.samples.length, event.data.rms ?? 0, context.sampleRate)
    }
    source.connect(node)
    node.connect(mute).connect(context.destination) // Keeps the graph pulled; silent.
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => { if (this.stream === stream) this.onEnded() })
    try { if (context.state === 'suspended') await context.resume() }
    catch (error) { stream.getTracks().forEach((track) => track.stop()); node.disconnect(); void context.close(); throw error }
    if (session !== this.session) { stream.getTracks().forEach((track) => track.stop()); node.disconnect(); void context.close(); throw new Error('Cancelled.') }
    this.stream = stream; this.context = context; this.node = node; this.chunks = []
    this.pieceSamples = 0; this.quietSamples = 0; this.voicedSamples = 0; this.floor = 0; this.pieces = 0
  }

  /** Cut at a real pause, judged against the room's own noise floor. Pure silence is pruned instead of sent. */
  private considerCut(length: number, rms: number, rate: number): void {
    this.pieceSamples += length
    this.floor = this.floor === 0 || rms < this.floor ? rms : this.floor + (rms - this.floor) * 0.002
    const quiet = rms < Math.min(0.025, Math.max(0.004, this.floor * 2.8))
    if (quiet) {
      this.quietSamples += length
    } else {
      this.quietSamples = 0
      this.voicedSamples += length
    }
    const seconds = this.pieceSamples / rate, pause = this.quietSamples / rate, voiced = this.voicedSamples / rate
    // Long silence before speech begins: trim stale silent chunks down to a short pre-roll.
    if (voiced < MIN_VOICED_SECONDS && seconds >= 2.0) {
      const keep = Math.round(rate * PREROLL_SECONDS)
      let total = this.pieceSamples
      while (this.chunks.length > 1 && total - this.chunks[0].length >= keep) {
        total -= this.chunks.shift()!.length
      }
      this.pieceSamples = total
      this.quietSamples = Math.min(this.quietSamples, total)
      return
    }
    if (seconds >= PIECE_LIMIT_SECONDS || CUTS.some(([after, needed]) => seconds >= after && pause >= needed)) {
      const audio = voiced >= MIN_VOICED_SECONDS ? toWAV(this.chunks, rate) : null
      this.chunks = []; this.pieceSamples = 0; this.quietSamples = 0; this.voicedSamples = 0
      if (audio) this.onPiece(audio, this.pieces++)
    }
  }

  /** The final piece, plus how many earlier pieces were already handed over. */
  async stop(): Promise<{ audio: ArrayBuffer | null; pieces: number }> {
    const { node, context } = this
    if (!node || !context) { this.release(); return { audio: null, pieces: 0 } }
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 250)
      const previous = node.port.onmessage
      node.port.onmessage = (event) => {
        if (event.data?.flushed) { window.clearTimeout(timer); resolve(); return }
        previous?.call(node.port, event)
      }
      node.port.postMessage('flush')
    })
    const rate = context.sampleRate
    const chunks = this.chunks, pieces = this.pieces // Read after the flush, which may cut a piece.
    this.release()
    // After earlier pieces, an empty tail still finishes the dictation.
    return { audio: toWAV(chunks, rate) ?? (pieces ? encodeWAV(new Float32Array(0), RATE) : null), pieces }
  }

  cancel(): void {
    this.session++
    this.release()
  }

  private release(): void {
    if (this.node) this.node.port.onmessage = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.node?.disconnect()
    if (this.context && this.context.state !== 'closed') void this.context.close()
    this.stream = null; this.context = null; this.node = null; this.chunks = []
  }
}

async function findDevice(name: string): Promise<string | undefined> {
  try {
    const wanted = name.trim().toLowerCase()
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === 'audioinput' && item.deviceId !== 'default')
    const stripSuffix = (label: string) => label.trim().toLowerCase().replace(/\s*\([^)]*\)\s*$/, '')
    return (
      inputs.find((item) => item.label.trim().toLowerCase() === wanted || stripSuffix(item.label) === wanted) ??
      inputs.find((item) => item.label.trim().toLowerCase().startsWith(wanted)) ??
      inputs.find((item) => item.label.toLowerCase().includes(wanted))
    )?.deviceId
  } catch {
    return undefined
  }
}

function toWAV(chunks: Float32Array[], rate: number): ArrayBuffer | null {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  if (total === 0) return null
  const samples = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length }
  return encodeWAV(rate === RATE ? samples : resample(samples, rate, RATE), RATE)
}

/** Box-filtered decimation when downsampling, linear interpolation when upsampling (e.g. 8 kHz Bluetooth HFP). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (input.length === 0 || from <= 0 || to <= 0) return new Float32Array(0)
  if (from === to) return input
  const ratio = from / to
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  if (ratio < 1) {
    // Upsampling: linear interpolation avoids zero-stuffed samples.
    const last = input.length - 1
    for (let i = 0; i < output.length; i++) {
      const pos = i * ratio
      const idx = Math.min(last, Math.floor(pos))
      const next = Math.min(last, idx + 1)
      const frac = pos - idx
      output[i] = input[idx] * (1 - frac) + input[next] * frac
    }
    return output
  }
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    output[i] = sum / (end - start)
  }
  return output
}

function encodeWAV(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return buffer
}
