import { useEffect, useRef, useState } from 'react'
import { Check, Mic, Square } from 'lucide-react'
import type { AppState } from '@shared/types'
import { api } from '../lib/store'

export function MicrophoneTest({ state }: { state: AppState }) {
  const [level, setLevel] = useState(0)
  const [heard, setHeard] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [tested, setTested] = useState(false)
  const alive = useRef(true)
  const active = state.micTestActive
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; api.stopMicTest() }
  }, [])
  useEffect(() => {
    // If real dictation interrupted the test, clear tested flag so we don't flash "No voice detected".
    if (state.phase !== 'ready') setTested(false)
  }, [state.phase])
  useEffect(() => {
    if (!active) { setLevel(0); return }
    return api.onLevel((value) => { setLevel(value); if (value >= 0.15) setHeard(true) })
  }, [active])
  const start = async () => {
    setHeard(false); setTested(false); setFeedback('Opening your microphone…')
    try {
      const result = await api.startMicTest()
      if (alive.current) { setFeedback(result.feedback); setTested(result.ok) }
    } catch { if (alive.current) setFeedback('Could not open the microphone. Try again.') }
  }
  return <div className="mic-test">
    <div className="mic-test-head">
      <div><span className="mic-test-title">Check your microphone</span><p>{active ? `Using ${state.microphoneName || 'your selected microphone'}` : 'Speak a sentence and watch the level.'}</p></div>
      <button type="button" className={`btn ${active ? 'secondary' : 'ghost'}`} disabled={!active && state.phase !== 'ready'}
        onClick={() => active ? api.stopMicTest() : void start()}>
        {active ? <Square size={12} /> : <Mic size={13} />}{active ? 'Stop test' : 'Test mic'}
      </button>
    </div>
    <div className={`mic-test-meter ${heard ? 'heard' : ''}`} role="meter" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      <span style={{ transform: `scaleX(${level})` }} />
    </div>
    <div className="mic-test-feedback" role="status">
      {heard && <Check size={12} aria-hidden />}
      <span>{active ? level >= 0.95 ? 'Input is very loud · move a little farther away' : heard ? 'Good signal · speak naturally' : 'Listening · move closer if the level stays flat'
        : heard ? 'Microphone checked. Your voice is coming through.' : tested ? 'No voice detected. Check the selected mic or move closer.'
          : feedback && !feedback.startsWith('Speak to check') ? feedback : 'Level check only. Nothing is recorded or saved. Stops after 15 seconds.'}</span>
    </div>
  </div>
}
