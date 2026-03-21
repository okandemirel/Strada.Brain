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

Good to meet you. I can start helping right away and adapt quickly to how you like to work.

You can reply with any mix of these:
- what I should call you
- what you want to call me
- the persona or personality you want from me, for example: pragmatic teammate, strict reviewer, friendly mentor, formal, casual, brief, or detailed
- and, if you already have a task, send it directly so I can start immediately

You can also change this anytime in chat, for example:
- "Call yourself Nova"
- "Use the formal persona"
- "Be more like a mentor and keep replies brief"

You can still manage these later in Settings too.`,
  tr: `## Strada'ya Hoş Geldin

Tanıştığımıza memnun oldum. Hemen yardımcı olmaya başlayabilirim ve çalışma tarzımı sana göre ayarlayabilirim.

İstersen tek mesajda şunlardan istediğini yaz:
- sana nasıl hitap etmemi istediğini
- bana hangi isimle hitap etmek istediğini
- bende nasıl bir persona veya personality istediğini; örneğin teknik partner, mentor, daha resmi, daha samimi, daha kısa ya da daha detaylı
- ve elinde bir görev varsa doğrudan onu; ben hemen başlayayım

Bunları konuşmanın herhangi bir anında mesajla da değiştirebilirsin. Örneğin:
- "Kendine Nova de"
- "Formal persona kullan"
- "Bir mentor gibi davran ve kısa cevap ver"

İstersen daha sonra Settings üzerinden de değiştirebilirsin.`,
  ja: `## Stradaへようこそ

はじめまして。すぐに手伝い始められますし、話し方や雰囲気もあなたに合わせられます。

必要なら、1つのメッセージで次の好きなものを教えてください:
- 何とお呼びすればよいか
- 私を何と呼びたいか
- 私にどんなペルソナや雰囲気を持たせたいか。たとえば、実務的な相棒、厳しめのレビュー役、やさしいメンター、フォーマル、カジュアル、簡潔、詳細など
- すでに頼みたい作業があれば、そのまま送ってください。すぐに着手します

途中でいつでもチャットで変更できます。たとえば:
- "Nova と名乗って"
- "formal persona を使って"
- "メンターのように、短めに答えて"

あとで Settings から変更しても大丈夫です。`,
  ko: `## Strada에 오신 것을 환영합니다

반갑습니다. 지금 바로 도와드릴 수 있고, 말투와 분위기도 원하는 방식에 맞출 수 있습니다.

원하면 한 메시지로 아래 중 원하는 것을 알려주세요:
- 어떻게 불러드리면 될지
- 저를 어떤 이름으로 부르고 싶은지
- 제가 어떤 페르소나나 성격으로 응답하면 좋을지. 예: 실용적인 동료, 엄격한 리뷰어, 친근한 멘토, 더 공식적으로, 더 편하게, 더 짧게, 더 자세하게
- 그리고 이미 할 일이 있다면 그대로 보내 주세요. 바로 시작하겠습니다

대화 중에도 언제든 메시지로 바꿀 수 있습니다. 예:
- "이제부터 이름은 Nova로 해"
- "formal persona를 써줘"
- "멘토처럼 말하고 답변은 짧게 해줘"

원하면 나중에 Settings에서도 바꿀 수 있습니다.`,
  zh: `## 欢迎来到 Strada

很高兴见到你。我现在就可以开始帮你处理项目，也可以快速适应你喜欢的交流方式。

你可以在一条消息里告诉我以下任意内容:
- 我该怎么称呼你
- 你想怎么称呼我
- 你希望我采用什么样的人设或性格，比如务实搭档、严格评审、友好导师、更正式、更轻松、更简短或更详细
- 如果你已经有具体任务，也可以直接发给我，我会马上开始

这些在对话过程中也可以随时直接改，比如:
- “以后你叫自己 Nova”
- “使用 formal persona”
- “像导师一样回答，并且简短一点”

之后你也可以在 Settings 里修改。`,
  de: `## Willkommen bei Strada

Schön, dich kennenzulernen. Ich kann sofort loslegen und mich schnell an deinen bevorzugten Stil anpassen.

Wenn du möchtest, schreib mir in einer Nachricht irgendetwas davon:
- wie ich dich nennen soll
- wie du mich nennen möchtest
- welche Persona oder welchen Stil du von mir willst, zum Beispiel pragmatischer Teamkollege, strenger Reviewer, freundlicher Mentor, formell, locker, kurz oder detailliert
- und falls du schon eine konkrete Aufgabe hast, schick sie direkt mit, damit ich sofort loslegen kann

Du kannst das auch jederzeit direkt im Chat ändern, zum Beispiel:
- "Nenn dich Nova"
- "Nutze die formale Persona"
- "Antworte wie ein Mentor und eher kurz"

Später geht das auch weiterhin in den Settings.`,
  es: `## Bienvenido a Strada

Encantado de conocerte. Puedo empezar de inmediato y adaptarme rápido a la forma en que prefieres trabajar.

Si quieres, en un solo mensaje puedes decirme cualquiera de estas cosas:
- cómo quieres que te llame
- cómo quieres llamarme a mí
- qué persona o personalidad quieres que tenga: por ejemplo compañero pragmático, revisor estricto, mentor cercano, más formal, más casual, más breve o más detallado
- y, si ya tienes una tarea concreta, envíamela directamente para que empiece enseguida

También puedes cambiarlo en cualquier momento por chat, por ejemplo:
- "Llámate Nova"
- "Usa la persona formal"
- "Compórtate más como un mentor y responde breve"

Si prefieres, después también puedes ajustarlo en Settings.`,
  fr: `## Bienvenue sur Strada

Ravi de te rencontrer. Je peux commencer tout de suite et m'adapter rapidement à la façon dont tu aimes travailler.

Si tu veux, tu peux me dire en un seul message n'importe lequel de ces points :
- comment tu veux que je t'appelle
- comment tu veux m'appeler
- quelle persona ou quelle personnalité tu veux pour moi : partenaire pragmatique, relecteur exigeant, mentor chaleureux, plus formel, plus détendu, plus bref ou plus détaillé
- et, si tu as déjà une tâche précise, envoie-la directement pour que je commence tout de suite

Tu peux aussi changer cela à tout moment dans le chat, par exemple :
- "Appelle-toi Nova"
- "Utilise la persona formelle"
- "Réponds comme un mentor et plus brièvement"

Tu pourras toujours le modifier plus tard dans Settings.`,
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
