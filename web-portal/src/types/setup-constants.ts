import type { ProviderDef, PresetDef, ChannelDef } from './setup'

export const PRESETS: PresetDef[] = [
  { id: 'free', name: 'Free', cost: '$0/mo', desc: 'Ollama local only', providers: ['ollama'] },
  { id: 'budget', name: 'Budget', cost: '$1-3/mo', desc: 'DeepSeek + Groq', providers: ['deepseek', 'groq'] },
  { id: 'balanced', name: 'Balanced', cost: '$5-10/mo', desc: 'Gemini + DeepSeek', providers: ['gemini', 'deepseek'] },
  { id: 'performance', name: 'Performance', cost: '$15-30/mo', desc: 'Claude + Gemini', providers: ['claude', 'gemini'] },
  { id: 'premium', name: 'Premium', cost: '$50-100/mo', desc: 'Claude + OpenAI', providers: ['claude', 'openai', 'deepseek'] },
]

export const PROVIDERS: ProviderDef[] = [
  { id: 'claude', name: 'Claude', envKey: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...', recommended: true, helpUrl: 'https://console.anthropic.com' },
  { id: 'openai', name: 'OpenAI', envKey: 'OPENAI_API_KEY', placeholder: 'sk-...', helpUrl: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', placeholder: 'sk-...', helpUrl: 'https://platform.deepseek.com' },
  { id: 'kimi', name: 'Kimi', envKey: 'KIMI_API_KEY', placeholder: 'sk-...', helpUrl: 'https://platform.moonshot.cn' },
  { id: 'qwen', name: 'Qwen', envKey: 'QWEN_API_KEY', placeholder: 'sk-...', helpUrl: 'https://dashscope.console.aliyun.com' },
  { id: 'gemini', name: 'Gemini', envKey: 'GEMINI_API_KEY', placeholder: '...', embeddingRecommended: true, helpUrl: 'https://aistudio.google.com/apikey' },
  { id: 'groq', name: 'Groq', envKey: 'GROQ_API_KEY', placeholder: 'gsk_...', helpUrl: 'https://console.groq.com/keys' },
  { id: 'mistral', name: 'Mistral', envKey: 'MISTRAL_API_KEY', placeholder: '...', helpUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'together', name: 'Together', envKey: 'TOGETHER_API_KEY', placeholder: '...', helpUrl: 'https://api.together.xyz/settings/api-keys' },
  { id: 'fireworks', name: 'Fireworks', envKey: 'FIREWORKS_API_KEY', placeholder: '...', helpUrl: 'https://fireworks.ai/account/api-keys' },
  { id: 'minimax', name: 'MiniMax', envKey: 'MINIMAX_API_KEY', placeholder: '...', helpUrl: 'https://www.minimaxi.com' },
  { id: 'ollama', name: 'Ollama', envKey: null, placeholder: null, helpUrl: 'https://ollama.com' },
]

export const PROVIDER_MAP = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]))

export const CHANNELS: ChannelDef[] = [
  { id: 'web', name: 'Web', icon: 'globe', fields: [] },
  {
    id: 'telegram',
    name: 'Telegram',
    icon: 'send',
    fields: [
      { domId: 'telegramToken', envKey: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', placeholder: '123456:ABC-DEF...' },
      { domId: 'telegramUsers', envKey: 'ALLOWED_TELEGRAM_USER_IDS', label: 'Allowed User IDs', placeholder: '12345,67890' },
    ],
  },
  {
    id: 'discord',
    name: 'Discord',
    icon: 'hash',
    fields: [
      { domId: 'discordToken', envKey: 'DISCORD_BOT_TOKEN', label: 'Bot Token', placeholder: 'MTk...' },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    icon: 'message-square',
    fields: [
      { domId: 'slackBotToken', envKey: 'SLACK_BOT_TOKEN', label: 'Bot Token', placeholder: 'xoxb-...' },
      { domId: 'slackAppToken', envKey: 'SLACK_APP_TOKEN', label: 'App Token', placeholder: 'xapp-...' },
    ],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    icon: 'phone',
    fields: [
      { domId: 'whatsappAllowedNumbers', envKey: 'WHATSAPP_ALLOWED_NUMBERS', label: 'Allowed Numbers', placeholder: '+1234567890' },
      { domId: 'whatsappSessionPath', envKey: 'WHATSAPP_SESSION_PATH', label: 'Session Path', placeholder: '.wwebjs_auth' },
    ],
  },
  { id: 'cli', name: 'CLI', icon: 'terminal', fields: [] },
]

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'de', name: 'German' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
]

export const EMBEDDING_CAPABLE = new Set([
  'openai', 'mistral', 'together', 'fireworks', 'qwen', 'gemini', 'ollama',
])

export const EMBEDDING_PROVIDERS = [
  { id: 'auto', name: 'Auto (detect from providers)' },
  { id: 'gemini', name: 'Gemini' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'mistral', name: 'Mistral' },
  { id: 'together', name: 'Together' },
  { id: 'fireworks', name: 'Fireworks' },
  { id: 'qwen', name: 'Qwen' },
  { id: 'ollama', name: 'Ollama' },
]
