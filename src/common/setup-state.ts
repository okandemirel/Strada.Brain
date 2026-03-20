import {
  POST_SETUP_BOOTSTRAP_LANGUAGES,
  type PostSetupBootstrapLanguage,
  SETUP_QUERY_PARAM,
  type PostSetupBootstrap,
  type SetupBootstrapState,
  type SetupProviderFailure,
  type SetupStatusResponse,
} from "./setup-contract.js";

export const SETUP_STATE_DEFAULT_DETAILS: Record<SetupBootstrapState, string> = {
  collecting: "Waiting for setup to begin.",
  saved: "Configuration accepted. Starting Strada on this same URL.",
  booting: "Strada is starting the main web app.",
  ready: "Strada is ready. Redirecting now.",
  failed: "Strada could not finish starting. Re-open setup and fix the configuration.",
};

export type SetupStatusTransition =
  | { type: "reset" }
  | {
    type: "config_saved";
    detail?: string;
    readyUrl?: string;
    providerWarnings?: SetupProviderFailure[];
    postSetupBootstrap?: PostSetupBootstrap;
  }
  | {
    type: "bootstrap_starting";
    detail?: string;
    readyUrl?: string;
  }
  | {
    type: "bootstrap_ready";
    readyUrl?: string;
    detail?: string;
  }
  | {
    type: "bootstrap_failed";
    detail: string;
  };

export type SetupBootstrapViewStatus = "saved" | "booting" | "success" | "error";

export interface SetupBootstrapView {
  saveStatus: SetupBootstrapViewStatus;
  detail: string;
  readyUrl?: string;
  shouldPoll: boolean;
  canRetry: boolean;
}

export function createSetupStatus(state: SetupBootstrapState = "collecting"): SetupStatusResponse {
  if (state === "collecting") {
    return { state };
  }
  return {
    state,
    detail: SETUP_STATE_DEFAULT_DETAILS[state],
    ...(state === "ready" ? { readyUrl: "/" } : {}),
  };
}

export function getSetupStatusDetail(status: Pick<SetupStatusResponse, "state" | "detail">): string {
  return status.detail?.trim() || SETUP_STATE_DEFAULT_DETAILS[status.state];
}

export function transitionSetupStatus(
  current: SetupStatusResponse,
  transition: SetupStatusTransition,
): SetupStatusResponse {
  switch (transition.type) {
    case "reset":
      return createSetupStatus("collecting");
    case "config_saved":
      return {
        state: "saved",
        detail: transition.detail ?? SETUP_STATE_DEFAULT_DETAILS.saved,
        readyUrl: transition.readyUrl ?? current.readyUrl,
        providerWarnings: transition.providerWarnings ?? current.providerWarnings,
        postSetupBootstrap: transition.postSetupBootstrap ?? current.postSetupBootstrap,
      };
    case "bootstrap_starting":
      return {
        state: "booting",
        detail: transition.detail ?? SETUP_STATE_DEFAULT_DETAILS.booting,
        readyUrl: transition.readyUrl ?? current.readyUrl,
        providerWarnings: current.providerWarnings,
        postSetupBootstrap: current.postSetupBootstrap,
      };
    case "bootstrap_ready":
      return {
        state: "ready",
        detail: transition.detail ?? SETUP_STATE_DEFAULT_DETAILS.ready,
        readyUrl: transition.readyUrl ?? "/",
        providerWarnings: current.providerWarnings,
        postSetupBootstrap: current.postSetupBootstrap,
      };
    case "bootstrap_failed":
      return {
        state: "failed",
        detail: transition.detail,
        readyUrl: current.readyUrl,
        providerWarnings: current.providerWarnings,
        postSetupBootstrap: current.postSetupBootstrap,
      };
  }
}

export function deriveSetupBootstrapView(status: SetupStatusResponse): SetupBootstrapView | null {
  switch (status.state) {
    case "collecting":
      return null;
    case "saved":
      return {
        saveStatus: "saved",
        detail: getSetupStatusDetail(status),
        readyUrl: status.readyUrl,
        shouldPoll: true,
        canRetry: false,
      };
    case "booting":
      return {
        saveStatus: "booting",
        detail: getSetupStatusDetail(status),
        readyUrl: status.readyUrl,
        shouldPoll: true,
        canRetry: false,
      };
    case "ready":
      return {
        saveStatus: "success",
        detail: getSetupStatusDetail(status),
        readyUrl: status.readyUrl || "/",
        shouldPoll: false,
        canRetry: false,
      };
    case "failed":
      return {
        saveStatus: "error",
        detail: getSetupStatusDetail(status),
        readyUrl: status.readyUrl,
        shouldPoll: false,
        canRetry: true,
      };
  }
}

export function buildSetupRetryHref(): string {
  const params = new URLSearchParams({
    [SETUP_QUERY_PARAM]: "1",
    retry: "1",
  });
  return `/?${params.toString()}`;
}

const POST_SETUP_WELCOME_MESSAGES: Record<PostSetupBootstrapLanguage, string> = {
  en: "Hi, I'm Strada. What should I call you, and do you want replies brief, detailed, formal, or casual?",
  tr: "Merhaba, ben Strada. Sana nasıl sesleneyim; yanıtlarımı kısa, detaylı, daha resmi ya da daha rahat mı istersin?",
  ja: "こんにちは、Stradaです。何とお呼びすればよく、返答は簡潔・詳しめ・フォーマル・カジュアルのどれが好みですか？",
  ko: "안녕하세요, 저는 Strada입니다. 어떻게 불러드리면 될지, 그리고 답변은 간결하게, 자세하게, 더 공식적으로, 혹은 편하게 드릴지 알려주세요.",
  zh: "你好，我是 Strada。你希望我怎么称呼你，以及回复更适合简短、详细、正式还是轻松一些？",
  de: "Hallo, ich bin Strada. Wie soll ich dich nennen, und möchtest du eher kurze, detaillierte, formelle oder lockere Antworten?",
  es: "Hola, soy Strada. ¿Cómo quieres que te llame y prefieres respuestas breves, detalladas, formales o más relajadas?",
  fr: "Bonjour, je suis Strada. Comment dois-je t'appeler, et préfères-tu des réponses brèves, détaillées, formelles ou plus décontractées ?",
};

export function buildPostSetupWelcomeMessage(language: string): string {
  return POST_SETUP_WELCOME_MESSAGES[language as PostSetupBootstrapLanguage] ?? POST_SETUP_WELCOME_MESSAGES.en;
}

export function buildPostSetupBootstrap(config: Record<string, string>): PostSetupBootstrap {
  const rawLanguage = config.LANGUAGE_PREFERENCE?.trim();
  const language = (
    rawLanguage
    && (POST_SETUP_BOOTSTRAP_LANGUAGES as readonly string[]).includes(rawLanguage)
      ? rawLanguage
      : "en"
  ) as PostSetupBootstrapLanguage;
  const autonomyEnabled = config.AUTONOMOUS_DEFAULT_ENABLED === "true";
  const hoursValue = Number(config.AUTONOMOUS_DEFAULT_HOURS);
  const bootstrap: PostSetupBootstrap = { language };

  if (autonomyEnabled) {
    bootstrap.autonomy = {
      enabled: true,
      ...(Number.isFinite(hoursValue) && hoursValue >= 1 && hoursValue <= 168
        ? { hours: Math.trunc(hoursValue) }
        : {}),
    };
  }

  return bootstrap;
}
