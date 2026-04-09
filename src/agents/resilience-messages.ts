export type MessageKey = "provider_slow" | "provider_failing" | "provider_backoff" | "provider_ask_user" | "provider_abort" | "task_stuck" | "token_budget_exceeded";

const MESSAGES: Record<string, Record<MessageKey, string>> = {
  en: {
    provider_slow: "The AI provider is experiencing delays. Retrying...",
    provider_failing: "The AI provider is not responding. Waiting {seconds}s before retry ({attempt}/{max}).",
    provider_backoff: "Provider unreliable — backing off for {seconds}s before next attempt ({attempt}/{max}).",
    provider_ask_user: "The AI provider has been unreliable for this task. You can continue waiting, switch to a different provider, or cancel.",
    provider_abort: "Unable to complete this task — the AI provider is not responding. Please try again later or switch to a different provider.",
    task_stuck: "I got stuck on this task after multiple approaches. I'll share what I tried and where I got blocked so we can move forward together.",
    token_budget_exceeded: "Token budget exceeded ({used}K / {budget}K input tokens). Returning what I have so far to avoid excessive cost.",
  },
  tr: {
    provider_slow: "Yapay zeka sağlayıcısı gecikme yaşıyor. Yeniden deneniyor...",
    provider_failing: "Yapay zeka sağlayıcısı yanıt vermiyor. {seconds}s sonra tekrar denenecek ({attempt}/{max}).",
    provider_backoff: "Sağlayıcı güvenilir değil — sonraki deneme için {seconds}s bekleniyor ({attempt}/{max}).",
    provider_ask_user: "Yapay zeka sağlayıcısı bu görev için güvenilir çalışmıyor. Beklemeye devam edebilir, farklı bir sağlayıcıya geçebilir veya görevi iptal edebilirsiniz.",
    provider_abort: "Bu görev tamamlanamadı — yapay zeka sağlayıcısı yanıt vermiyor. Lütfen daha sonra tekrar deneyin veya farklı bir sağlayıcı kullanın.",
    task_stuck: "Bu görevde birden fazla yaklaşım denedikten sonra takıldım. Neler denediğimi ve nerede tıkandığımı paylaşacağım, böylece birlikte ilerleyebiliriz.",
    token_budget_exceeded: "Token bütçesi aşıldı ({used}K / {budget}K input token). Aşırı maliyetten kaçınmak için mevcut sonucu döndürüyorum.",
  },
  ja: {
    provider_slow: "AIプロバイダーに遅延が発生しています。再試行中...",
    provider_failing: "AIプロバイダーが応答していません。{seconds}秒後に再試行します ({attempt}/{max})。",
    provider_backoff: "プロバイダーが不安定です — 次の試行まで{seconds}秒待機中 ({attempt}/{max})。",
    provider_ask_user: "AIプロバイダーがこのタスクで不安定な状態が続いています。待機を続けるか、別のプロバイダーに切り替えるか、タスクをキャンセルできます。",
    provider_abort: "このタスクを完了できませんでした — AIプロバイダーが応答していません。後でもう一度お試しいただくか、別のプロバイダーをご利用ください。",
    task_stuck: "複数のアプローチを試みましたが、このタスクで行き詰まりました。試したことと問題点を共有しますので、一緒に進めましょう。",
    token_budget_exceeded: "トークン予算を超過しました（{used}K / {budget}K入力トークン）。過剰なコストを避けるため、現時点の結果を返します。",
  },
  ko: {
    provider_slow: "AI 제공업체에서 지연이 발생하고 있습니다. 재시도 중...",
    provider_failing: "AI 제공업체가 응답하지 않습니다. {seconds}초 후 재시도합니다 ({attempt}/{max}).",
    provider_backoff: "제공업체가 불안정합니다 — 다음 시도까지 {seconds}초 대기 중 ({attempt}/{max}).",
    provider_ask_user: "AI 제공업체가 이 작업에 대해 불안정한 상태입니다. 계속 대기하거나, 다른 제공업체로 전환하거나, 작업을 취소할 수 있습니다.",
    provider_abort: "이 작업을 완료할 수 없습니다 — AI 제공업체가 응답하지 않습니다. 나중에 다시 시도하거나 다른 제공업체를 사용해 주세요.",
    task_stuck: "여러 접근 방식을 시도했지만 이 작업에서 막혔습니다. 시도한 내용과 문제점을 공유하여 함께 진행하겠습니다.",
    token_budget_exceeded: "토큰 예산 초과 ({used}K / {budget}K 입력 토큰). 과도한 비용을 방지하기 위해 현재 결과를 반환합니다.",
  },
  zh: {
    provider_slow: "AI提供商正在经历延迟。正在重试...",
    provider_failing: "AI提供商未响应。将在{seconds}秒后重试 ({attempt}/{max})。",
    provider_backoff: "提供商不稳定 — 等待{seconds}秒后进行下一次尝试 ({attempt}/{max})。",
    provider_ask_user: "AI提供商在此任务中一直不稳定。您可以继续等待、切换到其他提供商或取消任务。",
    provider_abort: "无法完成此任务 — AI提供商未响应。请稍后再试或使用其他提供商。",
    task_stuck: "尝试了多种方法后，我在这个任务上遇到了困难。我会分享我尝试的内容和遇到的问题，以便我们一起推进。",
    token_budget_exceeded: "令牌预算已超出（{used}K / {budget}K输入令牌）。为避免过高成本，返回当前结果。",
  },
  de: {
    provider_slow: "Der KI-Anbieter hat Verzögerungen. Wird erneut versucht...",
    provider_failing: "Der KI-Anbieter antwortet nicht. Erneuter Versuch in {seconds}s ({attempt}/{max}).",
    provider_backoff: "Anbieter unzuverlässig — Wartezeit von {seconds}s vor dem nächsten Versuch ({attempt}/{max}).",
    provider_ask_user: "Der KI-Anbieter war für diese Aufgabe unzuverlässig. Sie können weiter warten, zu einem anderen Anbieter wechseln oder die Aufgabe abbrechen.",
    provider_abort: "Diese Aufgabe konnte nicht abgeschlossen werden — der KI-Anbieter antwortet nicht. Bitte versuchen Sie es später erneut oder verwenden Sie einen anderen Anbieter.",
    task_stuck: "Nach mehreren Ansätzen bin ich bei dieser Aufgabe nicht weitergekommen. Ich teile mit, was ich versucht habe und wo ich steckengeblieben bin, damit wir gemeinsam vorankommen.",
    token_budget_exceeded: "Token-Budget überschritten ({used}K / {budget}K Eingabe-Token). Um übermäßige Kosten zu vermeiden, wird das bisherige Ergebnis zurückgegeben.",
  },
  es: {
    provider_slow: "El proveedor de IA está experimentando retrasos. Reintentando...",
    provider_failing: "El proveedor de IA no responde. Reintentando en {seconds}s ({attempt}/{max}).",
    provider_backoff: "Proveedor inestable — esperando {seconds}s antes del próximo intento ({attempt}/{max}).",
    provider_ask_user: "El proveedor de IA ha sido inestable para esta tarea. Puede seguir esperando, cambiar a otro proveedor o cancelar la tarea.",
    provider_abort: "No se pudo completar esta tarea — el proveedor de IA no responde. Inténtelo de nuevo más tarde o use otro proveedor.",
    task_stuck: "Me quedé atascado en esta tarea después de varios intentos. Compartiré lo que probé y dónde me bloqueé para que podamos avanzar juntos.",
    token_budget_exceeded: "Presupuesto de tokens excedido ({used}K / {budget}K tokens de entrada). Devolviendo el resultado parcial para evitar costos excesivos.",
  },
  fr: {
    provider_slow: "Le fournisseur d'IA subit des retards. Nouvelle tentative...",
    provider_failing: "Le fournisseur d'IA ne répond pas. Nouvelle tentative dans {seconds}s ({attempt}/{max}).",
    provider_backoff: "Fournisseur instable — attente de {seconds}s avant la prochaine tentative ({attempt}/{max}).",
    provider_ask_user: "Le fournisseur d'IA a été instable pour cette tâche. Vous pouvez continuer à attendre, passer à un autre fournisseur ou annuler la tâche.",
    provider_abort: "Impossible de terminer cette tâche — le fournisseur d'IA ne répond pas. Veuillez réessayer plus tard ou utiliser un autre fournisseur.",
    task_stuck: "Je suis resté bloqué sur cette tâche après plusieurs approches. Je vais partager ce que j'ai essayé et où je me suis bloqué afin que nous puissions avancer ensemble.",
    token_budget_exceeded: "Budget de tokens dépassé ({used}K / {budget}K tokens d'entrée). Renvoi du résultat partiel pour éviter des coûts excessifs.",
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
