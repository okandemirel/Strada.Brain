import { useState } from 'react'
import { useWS } from '../../hooks/useWS'
import { Pause, Play } from 'lucide-react'
import { Button } from '../ui/button'

export default function InterventionToolbar() {
  const { sendRawJSON } = useWS()
  const [paused, setPaused] = useState(false)

  const togglePause = () => {
    const type = paused ? 'monitor:resume' : 'monitor:pause'
    if (sendRawJSON({ type })) {
      setPaused(!paused)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={togglePause}>
        {paused ? <Play size={14} /> : <Pause size={14} />}
        <span className="ml-1 text-xs">{paused ? 'Resume' : 'Pause'}</span>
      </Button>
    </div>
  )
}
