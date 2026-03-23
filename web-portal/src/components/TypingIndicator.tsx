import { TypingAnimation } from './ui/typing-animation'

export default function TypingIndicator() {
  return (
    <div className="bg-white/3 backdrop-blur border border-white/5 rounded-xl px-4 py-2 inline-flex">
      <TypingAnimation className="text-sm text-text-secondary" duration={80}>Thinking...</TypingAnimation>
    </div>
  )
}
