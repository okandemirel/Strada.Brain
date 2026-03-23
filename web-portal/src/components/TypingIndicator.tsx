export default function TypingIndicator() {
  return (
    <div className="self-start bg-white/[0.03] backdrop-blur border border-white/5 rounded-xl px-4 py-2 inline-flex gap-[5px] items-center">
      <span className="w-2 h-2 rounded-full bg-text-tertiary animate-[bounce-dot_1.4s_ease-in-out_infinite] [animation-delay:-0.32s]" />
      <span className="w-2 h-2 rounded-full bg-text-tertiary animate-[bounce-dot_1.4s_ease-in-out_infinite] [animation-delay:-0.16s]" />
      <span className="w-2 h-2 rounded-full bg-text-tertiary animate-[bounce-dot_1.4s_ease-in-out_infinite]" />
    </div>
  )
}
