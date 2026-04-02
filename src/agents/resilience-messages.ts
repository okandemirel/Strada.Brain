export type MessageKey = "provider_slow" | "provider_failing" | "provider_backoff" | "provider_ask_user" | "provider_abort";

const MESSAGES: Record<string, Record<MessageKey, string>> = {
  en: {
    provider_slow: "The AI provider is experiencing delays. Retrying...",
    provider_failing: "The AI provider is not responding. Waiting {seconds}s before retry ({attempt}/{max}).",
    provider_backoff: "Provider unreliable — backing off for {seconds}s before next attempt ({attempt}/{max}).",
    provider_ask_user: "The AI provider has been unreliable for this task. You can continue waiting, switch to a different provider, or cancel.",
    provider_abort: "Unable to complete this task — the AI provider is not responding. Please try again later or switch to a different provider.",
  },
  tr: {
    provider_slow: "Yapay zeka sağlayıcısı gecikme yaşıyor. Yeniden deneniyor...",
    provider_failing: "Yapay zeka sağlayıcısı yanıt vermiyor. {seconds}s sonra tekrar denenecek ({attempt}/{max}).",
    provider_backoff: "Sağlayıcı güvenilir değil — sonraki deneme için {seconds}s bekleniyor ({attempt}/{max}).",
    provider_ask_user: "Yapay zeka sağlayıcısı bu görev için güvenilir çalışmıyor. Beklemeye devam edebilir, farklı bir sağlayıcıya geçebilir veya görevi iptal edebilirsiniz.",
    provider_abort: "Bu görev tamamlanamadı — yapay zeka sağlayıcısı yanıt vermiyor. Lütfen daha sonra tekrar deneyin veya farklı bir sağlayıcı kullanın.",
  },
  ja: {
    provider_slow: "AIプロバイダーに遅延が発生しています。再試行中...",
    provider_failing: "AIプロバイダーが応答していません。{seconds}秒後に再試行します ({attempt}/{max})。",
    provider_backoff: "プロバイダーが不安定です — 次の試行まで{seconds}秒待機中 ({attempt}/{max})。",
    provider_ask_user: "AIプロバイダーがこのタスクで不安定な状態が続いています。待機を続けるか、別のプロバイダーに切り替えるか、タスクをキャンセルできます。",
    provider_abort: "このタスクを完了できませんでした — AIプロバイダーが応答していません。後でもう一度お試しいただくか、別のプロバイダーをご利用ください。",
  },
  ko: {
    provider_slow: "AI 제공업체에서 지연이 발생하고 있습니다. 재시도 중...",
    provider_failing: "AI 제공업체가 응답하지 않습니다. {seconds}초 후 재시도합니다 ({attempt}/{max}).",
    provider_backoff: "제공업체가 불안정합니다 — 다음 시도까지 {seconds}초 대기 중 ({attempt}/{max}).",
    provider_ask_user: "AI 제공업체가 이 작업에 대해 불안정한 상태입니다. 계속 대기하거나, 다른 제공업체로 전환하거나, 작업을 취소할 수 있습니다.",
    provider_abort: "이 작업을 완료할 수 없습니다 — AI 제공업체가 응답하지 않습니다. 나중에 다시 시도하거나 다른 제공업체를 사용해 주세요.",
  },
  zh: {
    provider_slow: "AI提供商正在经历延迟。正在重试...",
    provider_failing: "AI提供商未响应。将在{seconds}秒后重试 ({attempt}/{max})。",
    provider_backoff: "提供商不稳定 — 等待{seconds}秒后进行下一次尝试 ({attempt}/{max})。",
    provider_ask_user: "AI提供商在此任务中一直不稳定。您可以继续等待、切换到其他提供商或取消任务。",
    provider_abort: "无法完成此任务 — AI提供商未响应。请稍后再试或使用其他提供商。",
  },
  de: {
    provider_slow: "Der KI-Anbieter hat Verzögerungen. Wird erneut versucht...",
    provider_failing: "Der KI-Anbieter antwortet nicht. Erneuter Versuch in {seconds}s ({attempt}/{max}).",
    provider_backoff: "Anbieter unzuverlässig — Wartezeit von {seconds}s vor dem nächsten Versuch ({attempt}/{max}).",
    provider_ask_user: "Der KI-Anbieter war für diese Aufgabe unzuverlässig. Sie können weiter warten, zu einem anderen Anbieter wechseln oder die Aufgabe abbrechen.",
    provider_abort: "Diese Aufgabe konnte nicht abgeschlossen werden — der KI-Anbieter antwortet nicht. Bitte versuchen Sie es später erneut oder verwenden Sie einen anderen Anbieter.",
  },
  es: {
    provider_slow: "El proveedor de IA está experimentando retrasos. Reintentando...",
    provider_failing: "El proveedor de IA no responde. Reintentando en {seconds}s ({attempt}/{max}).",
    provider_backoff: "Proveedor inestable — esperando {seconds}s antes del próximo intento ({attempt}/{max}).",
    provider_ask_user: "El proveedor de IA ha sido inestable para esta tarea. Puede seguir esperando, cambiar a otro proveedor o cancelar la tarea.",
    provider_abort: "No se pudo completar esta tarea — el proveedor de IA no responde. Inténtelo de nuevo más tarde o use otro proveedor.",
  },
  fr: {
    provider_slow: "Le fournisseur d'IA subit des retards. Nouvelle tentative...",
    provider_failing: "Le fournisseur d'IA ne répond pas. Nouvelle tentative dans {seconds}s ({attempt}/{max}).",
    provider_backoff: "Fournisseur instable — attente de {seconds}s avant la prochaine tentative ({attempt}/{max}).",
    provider_ask_user: "Le fournisseur d'IA a été instable pour cette tâche. Vous pouvez continuer à attendre, passer à un autre fournisseur ou annuler la tâche.",
    provider_abort: "Impossible de terminer cette tâche — le fournisseur d'IA ne répond pas. Veuillez réessayer plus tard ou utiliser un autre fournisseur.",
  },
};

export function getResilienceMessage(
  key: MessageKey,
  language: string,
  params?: Record<string, string | number>,
): string {
  const lang = language.toLowerCase().slice(0, 2);
  const messages = MESSAGES[lang] ?? MESSAGES.en!;
  let msg = messages[key] ?? MESSAGES.en![key]!;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return msg;
}
