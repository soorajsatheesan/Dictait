import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import './styles/base.css'
import './styles/hud.css'
import { Island } from './hud/Island'

// Design previews can paint a desktop behind the island: ?backdrop=light|dark
const backdrop = new URLSearchParams(location.search).get('backdrop')
if (backdrop) document.body.dataset.backdrop = backdrop

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <Island />
    </MotionConfig>
  </StrictMode>
)
