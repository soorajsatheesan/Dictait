import { motion } from 'motion/react'
import { useRef, type ReactNode } from 'react'
import { Accessibility, Check, Download, Keyboard, Mic, RotateCw } from 'lucide-react'
import type { AppState } from '@shared/types'
import { Keys, Mark } from '../components/ui'
import { smooth, snappy } from '../lib/motion'
import { api } from '../lib/store'

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`

/**
 * First run: everything Dictait needs, as a live checklist. Each line turns done on its own as the
 * permission is granted, the models arrive, and the first dictation lands.
 */
export function SetupView({ state }: { state: AppState }) {
  const firstTranscript = useRef(state.transcript)
  const modelsReady = !['preparing', 'failed'].includes(state.phase)
  const tried = modelsReady && Boolean(state.transcript) && state.transcript !== firstTranscript.current
  const finish = () => { void api.setSettings({ setupDone: true }) }
  const download = state.download
  const fraction = download && download.total ? Math.min(1, download.done / download.total) : null

  return (
    <motion.div className="setup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.25 } }}>
      <div className="setup-light" aria-hidden><i /><i /><i /></div>
      <div className="setup-drag" />
      <motion.div className="setup-card" initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...smooth, delay: 0.08 }}>
        <header className="setup-head">
          <span className="setup-mark"><Mark size={44} /></span>
          <h1 className="display setup-title">Welcome to Dictait</h1>
          <p className="setup-lede">Talk anywhere on your Mac and clean text lands at your cursor. Four quick things, and everything stays on this Mac.</p>
        </header>

        <ol className="setup-steps">
          <Step index={1} icon={Mic} done={state.microphoneAllowed} title="Microphone" detail="So Dictait can hear you while you hold the shortcut. Nothing is recorded otherwise.">
            {!state.microphoneAllowed && <button type="button" className="btn primary" onClick={() => api.requestMicrophone()}>Allow</button>}
          </Step>
          <Step index={2} icon={Accessibility} done={state.accessibilityAllowed} title="Paste where you type" detail="Accessibility lets Dictait paste at your cursor. Turn Dictait on in the list, then come back here.">
            {!state.accessibilityAllowed && <button type="button" className="btn primary" onClick={() => api.requestAccessibility()}>Open settings</button>}
          </Step>
          <Step index={3} icon={Download} done={modelsReady} busy={!modelsReady && state.phase !== 'failed'} title="Voice models"
            detail={state.phase === 'failed' ? state.message
              : modelsReady ? 'Ready on this Mac. They work offline from now on.'
                : download ? `Downloading the ${download.model} · ${gb(download.done)} of ${gb(download.total)}`
                  : state.message || 'Getting the models ready…'}>
            {state.phase === 'failed' && <button type="button" className="btn secondary" onClick={() => api.reloadModels()}><RotateCw size={13} /> Retry</button>}
          </Step>
          {fraction !== null && !modelsReady && (
            <li className="setup-progress" aria-hidden>
              <motion.span className="setup-progress-fill" animate={{ scaleX: Math.max(0.02, fraction) }} transition={snappy} />
            </li>
          )}
          <Step index={4} icon={Keyboard} done={tried} title="Try it" detail={tried ? <>Dictait wrote: “{state.transcript.slice(0, 90)}”</> : <>Click into any text box, press <Keys keys={['⌃', 'Space']} small />, say a sentence, and press it again.</>} />
        </ol>

        <footer className="setup-foot">
          <button type="button" className="btn ghost" onClick={finish}>Finish later</button>
          <button type="button" className="btn primary big" disabled={!modelsReady} onClick={finish}>{tried ? 'Start dictating' : 'Done'}</button>
        </footer>
      </motion.div>
    </motion.div>
  )
}

function Step({ index, icon: Icon, done, busy = false, title, detail, children }: {
  index: number; icon: typeof Mic; done: boolean; busy?: boolean; title: string; detail: ReactNode; children?: ReactNode
}) {
  return (
    <li className={`setup-step ${done ? 'done' : ''}`}>
      <span className="setup-step-icon" aria-hidden>
        {done ? <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={snappy}><Check size={15} strokeWidth={2.6} /></motion.span>
          : busy ? <span className="setup-spin" /> : <Icon size={15} />}
      </span>
      <span className="setup-step-text">
        <span className="setup-step-title"><span className="setup-step-index">{index}</span>{title}</span>
        <span className="setup-step-detail">{detail}</span>
      </span>
      <span className="setup-step-action">{children}</span>
    </li>
  )
}
