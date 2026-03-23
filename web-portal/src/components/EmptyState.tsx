export default function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-text-secondary">
      <div className="bg-white/3 backdrop-blur-xl border border-white/5 rounded-2xl p-8 flex flex-col items-center gap-4">
        <div className="animate-[glow-pulse_3s_ease-in-out_infinite]">
          <img src="/strada-brain-icon.png" alt="Strada.Brain" width="64" height="64" className="max-w-[200px] max-h-[140px] object-contain" />
        </div>
        <h2 className="text-text text-[26px] font-bold tracking-tight">Strada.Brain</h2>
        <p className="text-[15px] max-w-[320px] text-center leading-relaxed">AI-powered Unity development assistant. Send a message to get started.</p>
      </div>
    </div>
  )
}
