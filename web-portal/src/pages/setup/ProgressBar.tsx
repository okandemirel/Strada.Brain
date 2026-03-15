interface ProgressBarProps {
  step: number
  totalSteps: number
}

export default function ProgressBar({ step, totalSteps }: ProgressBarProps) {
  const fillWidth = `${(step / totalSteps) * 100}%`

  return (
    <div className="progress-bar">
      <div className="progress-fill" style={{ width: fillWidth }} />
      <div className="step-dots">
        {Array.from({ length: totalSteps }, (_, i) => {
          const stepNum = i + 1
          const className = [
            'step-dot',
            stepNum === step && 'active',
            stepNum < step && 'completed',
          ].filter(Boolean).join(' ')

          return <div key={stepNum} className={className} />
        })}
      </div>
    </div>
  )
}
