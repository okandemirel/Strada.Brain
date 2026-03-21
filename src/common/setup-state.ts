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
  en: `## Welcome to Strada

I'm ready to help with your project right away.

Tell me in one message:
- what I should call you
- whether you want replies brief, detailed, formal, or casual
- and, if you already have a task, send it directly so I can start immediately

You can always change these later in Settings.`,
  tr: `## Strada'ya Hoş Geldin

Projende hemen yardımcı olmaya hazırım.

İstersen tek mesajda şunları yaz:
- sana nasıl hitap etmemi istediğini
- yanıtlarımın kısa mı detaylı mı, daha resmi mi daha rahat mı olmasını istediğini
- ve elinde bir görev varsa doğrudan onu; ben hemen başlayayım

Bunları daha sonra Settings üzerinden de değiştirebilirsin.`,
  ja: `## Stradaへようこそ

すぐにプロジェクトを手伝えます。

よければ1つのメッセージで教えてください:
- 何とお呼びすればよいか
- 返答は簡潔・詳しめ・フォーマル・カジュアルのどれがよいか
- すでに頼みたい作業があれば、そのまま送ってください。すぐに着手します

これらは後で Settings からいつでも変更できます。`,
  ko: `## Strada에 오신 것을 환영합니다

지금 바로 프로젝트 작업을 도와드릴 수 있습니다.

원하면 한 메시지로 알려주세요:
- 어떻게 불러드리면 될지
- 답변을 간결하게, 자세하게, 더 공식적으로, 혹은 편하게 드릴지
- 그리고 이미 할 일이 있다면 그대로 보내 주세요. 바로 시작하겠습니다

이 설정들은 나중에 Settings에서 언제든 바꿀 수 있습니다.`,
  zh: `## 欢迎来到 Strada

我已经可以立即开始帮你处理项目。

如果方便，可以在一条消息里告诉我:
- 我该怎么称呼你
- 你更喜欢简短、详细、正式还是轻松一点的回复
- 如果你已经有具体任务，也可以直接发给我，我会马上开始

这些偏好之后也可以在 Settings 里随时修改。`,
  de: `## Willkommen bei Strada

Ich kann dir sofort mit deinem Projekt helfen.

Wenn du magst, sag mir in einer Nachricht:
- wie ich dich nennen soll
- ob du eher kurze, detaillierte, formelle oder lockere Antworten willst
- und falls du schon eine konkrete Aufgabe hast, schick sie direkt mit, damit ich sofort loslegen kann

Das kannst du später jederzeit in den Settings ändern.`,
  es: `## Bienvenido a Strada

Puedo ayudarte con tu proyecto de inmediato.

Si quieres, dime en un solo mensaje:
- cómo quieres que te llame
- si prefieres respuestas breves, detalladas, formales o más relajadas
- y, si ya tienes una tarea concreta, envíamela directamente para que empiece enseguida

Siempre podrás cambiar esto después en Settings.`,
  fr: `## Bienvenue sur Strada

Je peux t'aider sur ton projet tout de suite.

Si tu veux, dis-moi dans un seul message :
- comment tu veux que je t'appelle
- si tu préfères des réponses brèves, détaillées, formelles ou plus décontractées
- et, si tu as déjà une tâche précise, envoie-la directement pour que je commence tout de suite

Tu pourras toujours changer cela plus tard dans Settings.`,
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
