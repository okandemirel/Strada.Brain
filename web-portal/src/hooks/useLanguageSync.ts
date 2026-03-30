import { useEffect } from 'react'
import { useSessionStore } from '../stores/session-store'
import i18n, { persistLanguage, type SupportedLanguage, SUPPORTED_LANGUAGES } from '../i18n'

/**
 * Syncs the session store language with i18next.
 * Call once near the app root (e.g. in App.tsx).
 */
export function useLanguageSync(): void {
  const language = useSessionStore((s) => s.language)

  useEffect(() => {
    if (!language || !SUPPORTED_LANGUAGES.includes(language as SupportedLanguage)) return
    if (i18n.language === language) return
    void i18n.changeLanguage(language)
    persistLanguage(language as SupportedLanguage)
  }, [language])
}
