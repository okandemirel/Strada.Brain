import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Eager-import all namespace bundles per locale.
// Vite tree-shakes unused languages at build time if needed.
import enCommon from './locales/en/common.json'
import enMonitor from './locales/en/monitor.json'
import enCanvas from './locales/en/canvas.json'
import enCode from './locales/en/code.json'
import enSetup from './locales/en/setup.json'
import enSettings from './locales/en/settings.json'
import enPages from './locales/en/pages.json'
import enVault from './locales/en/vault.json'

import trCommon from './locales/tr/common.json'
import trMonitor from './locales/tr/monitor.json'
import trCanvas from './locales/tr/canvas.json'
import trCode from './locales/tr/code.json'
import trSetup from './locales/tr/setup.json'
import trSettings from './locales/tr/settings.json'
import trPages from './locales/tr/pages.json'
import trVault from './locales/tr/vault.json'

import jaCommon from './locales/ja/common.json'
import jaMonitor from './locales/ja/monitor.json'
import jaCanvas from './locales/ja/canvas.json'
import jaCode from './locales/ja/code.json'
import jaSetup from './locales/ja/setup.json'
import jaSettings from './locales/ja/settings.json'
import jaPages from './locales/ja/pages.json'
import jaVault from './locales/ja/vault.json'

import koCommon from './locales/ko/common.json'
import koMonitor from './locales/ko/monitor.json'
import koCanvas from './locales/ko/canvas.json'
import koCode from './locales/ko/code.json'
import koSetup from './locales/ko/setup.json'
import koSettings from './locales/ko/settings.json'
import koPages from './locales/ko/pages.json'
import koVault from './locales/ko/vault.json'

import zhCommon from './locales/zh/common.json'
import zhMonitor from './locales/zh/monitor.json'
import zhCanvas from './locales/zh/canvas.json'
import zhCode from './locales/zh/code.json'
import zhSetup from './locales/zh/setup.json'
import zhSettings from './locales/zh/settings.json'
import zhPages from './locales/zh/pages.json'
import zhVault from './locales/zh/vault.json'

import deCommon from './locales/de/common.json'
import deMonitor from './locales/de/monitor.json'
import deCanvas from './locales/de/canvas.json'
import deCode from './locales/de/code.json'
import deSetup from './locales/de/setup.json'
import deSettings from './locales/de/settings.json'
import dePages from './locales/de/pages.json'
import deVault from './locales/de/vault.json'

import esCommon from './locales/es/common.json'
import esMonitor from './locales/es/monitor.json'
import esCanvas from './locales/es/canvas.json'
import esCode from './locales/es/code.json'
import esSetup from './locales/es/setup.json'
import esSettings from './locales/es/settings.json'
import esPages from './locales/es/pages.json'
import esVault from './locales/es/vault.json'

import frCommon from './locales/fr/common.json'
import frMonitor from './locales/fr/monitor.json'
import frCanvas from './locales/fr/canvas.json'
import frCode from './locales/fr/code.json'
import frSetup from './locales/fr/setup.json'
import frSettings from './locales/fr/settings.json'
import frPages from './locales/fr/pages.json'
import frVault from './locales/fr/vault.json'

// Keep in sync with the server-side Zod enum in src/config/config.ts (language field)
export const SUPPORTED_LANGUAGES = ['en', 'tr', 'ja', 'ko', 'zh', 'de', 'es', 'fr'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

const LANGUAGE_STORAGE_KEY = 'strada-language'

function getStoredLanguage(): SupportedLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (stored && SUPPORTED_LANGUAGES.includes(stored as SupportedLanguage)) {
      return stored as SupportedLanguage
    }
  } catch { /* SSR / test fallback */ }
  return 'en'
}

export function persistLanguage(lang: SupportedLanguage): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang)
  } catch { /* ignore */ }
}

void i18n.use(initReactI18next).init({
  lng: getStoredLanguage(),
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: ['common', 'monitor', 'canvas', 'code', 'setup', 'settings', 'pages', 'vault'],
  interpolation: { escapeValue: false },
  resources: {
    en: { common: enCommon, monitor: enMonitor, canvas: enCanvas, code: enCode, setup: enSetup, settings: enSettings, pages: enPages, vault: enVault },
    tr: { common: trCommon, monitor: trMonitor, canvas: trCanvas, code: trCode, setup: trSetup, settings: trSettings, pages: trPages, vault: trVault },
    ja: { common: jaCommon, monitor: jaMonitor, canvas: jaCanvas, code: jaCode, setup: jaSetup, settings: jaSettings, pages: jaPages, vault: jaVault },
    ko: { common: koCommon, monitor: koMonitor, canvas: koCanvas, code: koCode, setup: koSetup, settings: koSettings, pages: koPages, vault: koVault },
    zh: { common: zhCommon, monitor: zhMonitor, canvas: zhCanvas, code: zhCode, setup: zhSetup, settings: zhSettings, pages: zhPages, vault: zhVault },
    de: { common: deCommon, monitor: deMonitor, canvas: deCanvas, code: deCode, setup: deSetup, settings: deSettings, pages: dePages, vault: deVault },
    es: { common: esCommon, monitor: esMonitor, canvas: esCanvas, code: esCode, setup: esSetup, settings: esSettings, pages: esPages, vault: esVault },
    fr: { common: frCommon, monitor: frMonitor, canvas: frCanvas, code: frCode, setup: frSetup, settings: frSettings, pages: frPages, vault: frVault },
  },
})

export default i18n
