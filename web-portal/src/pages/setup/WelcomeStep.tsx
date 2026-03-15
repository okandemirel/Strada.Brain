interface WelcomeStepProps {
  onNext: () => void
}

export default function WelcomeStep({ onNext }: WelcomeStepProps) {
  return (
    <div className="step">
      <img
        src="/strada-brain-icon.png"
        alt="Strada.Brain"
        width={96}
        height={96}
        className="step-icon"
      />
      <h1>Welcome to Strada.Brain</h1>
      <p>AI-powered Unity development assistant. Let's configure your environment.</p>
      <button className="btn btn-primary" onClick={onNext}>
        Get Started
      </button>
    </div>
  )
}
