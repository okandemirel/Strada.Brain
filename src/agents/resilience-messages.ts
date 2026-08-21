export type MessageKey = "provider_slow" | "provider_failing" | "provider_backoff" | "provider_ask_user" | "provider_abort" | "provider_quota" | "task_stuck" | "token_budget_exceeded" | "max_steps_reached";

const MESSAGES: Record<string, Record<MessageKey, string>> = {
  en: {
    provider_slow: "The AI provider is experiencing delays. Retrying...",
    provider_failing: "The AI provider is not responding. Waiting {seconds}s before retry ({attempt}/{max}).",
    provider_backoff: "Provider unreliable — backing off for {seconds}s before next attempt ({attempt}/{max}).",
    provider_ask_user: "The AI provider has been unreliable for this task. You can continue waiting, switch to a different provider, or cancel.",
    provider_quota: "Stopped: {provider} has no quota left for this billing cycle. It said: {detail} This is not a failure of the work — nothing was wrong with the task. The run can continue once the quota refreshes, or immediately if you add a second provider to PROVIDER_CHAIN.",
    provider_abort: "Unable to complete this task — the AI provider is not responding. Please try again later or switch to a different provider.",
    task_stuck: "I got stuck on this task after multiple approaches. I'll share what I tried and where I got blocked so we can move forward together.",
    token_budget_exceeded: "Token budget exceeded ({used}K / {budget}K input tokens). Use `/token -1` for unlimited.",
    max_steps_reached: "I've reached the maximum number of steps for this request. Please send a follow-up message to continue.",
  },
  tr: {
    provider_slow: "Yapay zeka sağlayıcısı gecikme yaşıyor. Yeniden deneniyor...",
    provider_failing: "Yapay zeka sağlayıcısı yanıt vermiyor. {seconds}s sonra tekrar denenecek ({attempt}/{max}).",
    provider_backoff: "Sağlayıcı güvenilir değil — sonraki deneme için {seconds}s bekleniyor ({attempt}/{max}).",
    provider_ask_user: "Yapay zeka sağlayıcısı bu görev için güvenilir çalışmıyor. Beklemeye devam edebilir, farklı bir sağlayıcıya geçebilir veya görevi iptal edebilirsiniz.",
    provider_quota: "Durduruldu: {provider} sağlayıcısının bu fatura döneminde kotası kalmadı. Söylediği: {detail} Bu işin başarısızlığı değil — görevde yanlış bir şey yoktu. Kota yenilenince koşu devam edebilir, ya da PROVIDER_CHAIN'e ikinci bir sağlayıcı eklerseniz hemen.",
    provider_abort: "Bu görev tamamlanamadı — yapay zeka sağlayıcısı yanıt vermiyor. Lütfen daha sonra tekrar deneyin veya farklı bir sağlayıcı kullanın.",
    task_stuck: "Bu görevde birden fazla yaklaşım denedikten sonra takıldım. Neler denediğimi ve nerede tıkandığımı paylaşacağım, böylece birlikte ilerleyebiliriz.",
    token_budget_exceeded: "Token bütçesi aşıldı ({used}K / {budget}K input token). Sınırsız için `/token -1` kullan.",
    max_steps_reached: "Bu istek için maksimum adım sayısına ulaştım. Devam etmek için lütfen bir takip mesajı gönderin.",
  },
  ja: {
    provider_slow: "AIプロバイダーに遅延が発生しています。再試行中...",
    provider_failing: "AIプロバイダーが応答していません。{seconds}秒後に再試行します ({attempt}/{max})。",
    provider_backoff: "プロバイダーが不安定です — 次の試行まで{seconds}秒待機中 ({attempt}/{max})。",
    provider_ask_user: "AIプロバイダーがこのタスクで不安定な状態が続いています。待機を続けるか、別のプロバイダーに切り替えるか、タスクをキャンセルできます。",
    provider_quota: "停止しました: {provider} は今回の請求サイクルのクォータを使い切りました。応答: {detail} これは作業の失敗ではありません — タスクに問題はありませんでした。クォータが更新されれば再開できます。PROVIDER_CHAIN に2つ目のプロバイダーを追加すればすぐに続行できます。",
    provider_abort: "このタスクを完了できませんでした — AIプロバイダーが応答していません。後でもう一度お試しいただくか、別のプロバイダーをご利用ください。",
    task_stuck: "複数のアプローチを試みましたが、このタスクで行き詰まりました。試したことと問題点を共有しますので、一緒に進めましょう。",
    token_budget_exceeded: "トークン予算を超過しました（{used}K / {budget}K入力トークン）。無制限には `/token -1` を使用。",
    max_steps_reached: "このリクエストの最大ステップ数に達しました。続行するにはフォローアップメッセージを送信してください。",
  },
  ko: {
    provider_slow: "AI 제공업체에서 지연이 발생하고 있습니다. 재시도 중...",
    provider_failing: "AI 제공업체가 응답하지 않습니다. {seconds}초 후 재시도합니다 ({attempt}/{max}).",
    provider_backoff: "제공업체가 불안정합니다 — 다음 시도까지 {seconds}초 대기 중 ({attempt}/{max}).",
    provider_ask_user: "AI 제공업체가 이 작업에 대해 불안정한 상태입니다. 계속 대기하거나, 다른 제공업체로 전환하거나, 작업을 취소할 수 있습니다.",
    provider_quota: "중단됨: {provider}의 이번 청구 주기 할당량이 모두 소진되었습니다. 응답: {detail} 작업이 실패한 것이 아닙니다 — 과제 자체에는 문제가 없었습니다. 할당량이 갱신되면 계속할 수 있고, PROVIDER_CHAIN에 두 번째 제공업체를 추가하면 즉시 가능합니다.",
    provider_abort: "이 작업을 완료할 수 없습니다 — AI 제공업체가 응답하지 않습니다. 나중에 다시 시도하거나 다른 제공업체를 사용해 주세요.",
    task_stuck: "여러 접근 방식을 시도했지만 이 작업에서 막혔습니다. 시도한 내용과 문제점을 공유하여 함께 진행하겠습니다.",
    token_budget_exceeded: "토큰 예산 초과 ({used}K / {budget}K 입력 토큰). 무제한은 `/token -1` 사용.",
    max_steps_reached: "이 요청의 최대 단계 수에 도달했습니다. 계속하려면 후속 메시지를 보내주세요.",
  },
  zh: {
    provider_slow: "AI提供商正在经历延迟。正在重试...",
    provider_failing: "AI提供商未响应。将在{seconds}秒后重试 ({attempt}/{max})。",
    provider_backoff: "提供商不稳定 — 等待{seconds}秒后进行下一次尝试 ({attempt}/{max})。",
    provider_ask_user: "AI提供商在此任务中一直不稳定。您可以继续等待、切换到其他提供商或取消任务。",
    provider_quota: "已停止：{provider} 在本计费周期内的配额已用尽。它的回复：{detail} 这不是工作的失败——任务本身没有问题。配额刷新后即可继续，或在 PROVIDER_CHAIN 中添加第二个提供商后立即继续。",
    provider_abort: "无法完成此任务 — AI提供商未响应。请稍后再试或使用其他提供商。",
    task_stuck: "尝试了多种方法后，我在这个任务上遇到了困难。我会分享我尝试的内容和遇到的问题，以便我们一起推进。",
    token_budget_exceeded: "令牌预算已超出（{used}K / {budget}K输入令牌）。无限制请使用 `/token -1`。",
    max_steps_reached: "已达到此请求的最大步骤数。请发送后续消息以继续。",
  },
  de: {
    provider_slow: "Der KI-Anbieter hat Verzögerungen. Wird erneut versucht...",
    provider_failing: "Der KI-Anbieter antwortet nicht. Erneuter Versuch in {seconds}s ({attempt}/{max}).",
    provider_backoff: "Anbieter unzuverlässig — Wartezeit von {seconds}s vor dem nächsten Versuch ({attempt}/{max}).",
    provider_ask_user: "Der KI-Anbieter war für diese Aufgabe unzuverlässig. Sie können weiter warten, zu einem anderen Anbieter wechseln oder die Aufgabe abbrechen.",
    provider_quota: "Gestoppt: {provider} hat in diesem Abrechnungszeitraum kein Kontingent mehr. Die Antwort lautete: {detail} Das ist kein Fehlschlag der Arbeit — an der Aufgabe war nichts falsch. Der Lauf kann fortgesetzt werden, sobald das Kontingent erneuert wird, oder sofort mit einem zweiten Anbieter in PROVIDER_CHAIN.",
    provider_abort: "Diese Aufgabe konnte nicht abgeschlossen werden — der KI-Anbieter antwortet nicht. Bitte versuchen Sie es später erneut oder verwenden Sie einen anderen Anbieter.",
    task_stuck: "Nach mehreren Ansätzen bin ich bei dieser Aufgabe nicht weitergekommen. Ich teile mit, was ich versucht habe und wo ich steckengeblieben bin, damit wir gemeinsam vorankommen.",
    token_budget_exceeded: "Token-Budget überschritten ({used}K / {budget}K Eingabe-Token). Für unbegrenzt `/token -1` verwenden.",
    max_steps_reached: "Ich habe die maximale Anzahl an Schritten für diese Anfrage erreicht. Bitte senden Sie eine Folgenachricht, um fortzufahren.",
  },
  es: {
    provider_slow: "El proveedor de IA está experimentando retrasos. Reintentando...",
    provider_failing: "El proveedor de IA no responde. Reintentando en {seconds}s ({attempt}/{max}).",
    provider_backoff: "Proveedor inestable — esperando {seconds}s antes del próximo intento ({attempt}/{max}).",
    provider_ask_user: "El proveedor de IA ha sido inestable para esta tarea. Puede seguir esperando, cambiar a otro proveedor o cancelar la tarea.",
    provider_quota: "Detenido: {provider} no tiene cuota disponible en este ciclo de facturación. Respondió: {detail} Esto no es un fallo del trabajo — la tarea no tenía nada malo. La ejecución puede continuar cuando se renueve la cuota, o de inmediato si añades un segundo proveedor a PROVIDER_CHAIN.",
    provider_abort: "No se pudo completar esta tarea — el proveedor de IA no responde. Inténtelo de nuevo más tarde o use otro proveedor.",
    task_stuck: "Me quedé atascado en esta tarea después de varios intentos. Compartiré lo que probé y dónde me bloqueé para que podamos avanzar juntos.",
    token_budget_exceeded: "Presupuesto de tokens excedido ({used}K / {budget}K tokens de entrada). Para ilimitado use `/token -1`.",
    max_steps_reached: "He alcanzado el número máximo de pasos para esta solicitud. Por favor, envíe un mensaje de seguimiento para continuar.",
  },
  fr: {
    provider_slow: "Le fournisseur d'IA subit des retards. Nouvelle tentative...",
    provider_failing: "Le fournisseur d'IA ne répond pas. Nouvelle tentative dans {seconds}s ({attempt}/{max}).",
    provider_backoff: "Fournisseur instable — attente de {seconds}s avant la prochaine tentative ({attempt}/{max}).",
    provider_ask_user: "Le fournisseur d'IA a été instable pour cette tâche. Vous pouvez continuer à attendre, passer à un autre fournisseur ou annuler la tâche.",
    provider_quota: "Arrêté : {provider} n'a plus de quota pour ce cycle de facturation. Sa réponse : {detail} Ce n'est pas un échec du travail — la tâche n'avait rien d'incorrect. L'exécution peut reprendre au renouvellement du quota, ou immédiatement avec un second fournisseur dans PROVIDER_CHAIN.",
    provider_abort: "Impossible de terminer cette tâche — le fournisseur d'IA ne répond pas. Veuillez réessayer plus tard ou utiliser un autre fournisseur.",
    task_stuck: "Je suis resté bloqué sur cette tâche après plusieurs approches. Je vais partager ce que j'ai essayé et où je me suis bloqué afin que nous puissions avancer ensemble.",
    token_budget_exceeded: "Budget de tokens dépassé ({used}K / {budget}K tokens d'entrée). Pour illimité utilisez `/token -1`.",
    max_steps_reached: "J'ai atteint le nombre maximum d'étapes pour cette demande. Veuillez envoyer un message de suivi pour continuer.",
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
