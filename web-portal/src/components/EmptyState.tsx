import { useTranslation } from 'react-i18next'

export default function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-text-secondary">
      <div className="bg-white/3 backdrop-blur-xl border border-white/5 rounded-2xl p-8 flex flex-col items-center gap-4">
        <div className="animate-[glow-pulse_3s_ease-in-out_infinite]">
          <img src="/strada-brain-icon.png" alt={t('brand.name')} width="64" height="64" className="max-w-[200px] max-h-[140px] object-contain" />
        </div>
        <h2 className="text-text text-[26px] font-bold tracking-tight">{t('chat.empty.title')}</h2>
        <p className="text-[15px] max-w-[320px] text-center leading-relaxed">{t('chat.empty.description')}</p>
      </div>
    </div>
  )
}
