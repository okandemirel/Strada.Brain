export default function TypingIndicator() {
  return (
    <div className="flex gap-[5px] px-[18px] py-[14px] self-start">
      <span className="w-2 h-2 rounded-full bg-text-tertiary animate-[bounce-dot_1.4s_ease-in-out_infinite] [animation-delay:-0.32s]" />
      <span className="w-2 h-2 rounded-full bg-text-tertiary animate-[bounce-dot_1.4s_ease-in-out_infinite] [animation-delay:-0.16s]" />
      <span className="w-2 h-2 rounded-full bg-text-tertiary animate-[bounce-dot_1.4s_ease-in-out_infinite]" />
    </div>
  )
}
