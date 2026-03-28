import type { IncomingMessage } from "../channels/channel-messages.interface.js";

const TURKISH_HINT_RE = /[ğüşöçıİ]|\b(?:ve|için|şu|hata|düzelt|incele|bak|çöz|dosya|ekle|güncelle|mesaj)\b/iu;

function detectLanguage(text: string): "en" | "tr" {
  return TURKISH_HINT_RE.test(text) ? "tr" : "en";
}

export function buildBatchedPrompt(messages: readonly Pick<IncomingMessage, "text">[]): string {
  if (messages.length === 1) {
    return messages[0]!.text;
  }

  const parts = messages.map((message, index) =>
    `[User message ${index + 1}]\n${message.text.trim()}`,
  );
  return [
    `The user sent ${messages.length} consecutive messages before you responded. Treat them as one ordered request.`,
    "",
    ...parts,
  ].join("\n\n");
}

export function buildBurstOrQueueNotice(
  messages: readonly Pick<IncomingMessage, "text">[],
  queuedBehindActiveTask: boolean,
): string | null {
  if (messages.length === 0) return null;
  const language = detectLanguage(messages.at(-1)?.text ?? "");

  if (queuedBehindActiveTask) {
    if (messages.length === 1) {
      return language === "tr"
        ? "Son mesajını kuyruğa aldım. Mevcut işi bitirir bitirmez buna geçeceğim."
        : "I queued your latest message and will pick it up as soon as the current task finishes.";
    }
    return language === "tr"
      ? `Son ${messages.length} mesajını birlikte kuyruğa aldım. Mevcut işi bitirir bitirmez bunları sırayla işleyeceğim.`
      : `I queued your last ${messages.length} messages together and will process them as soon as the current task finishes.`;
  }

  if (messages.length <= 1) {
    return null;
  }

  return language === "tr"
    ? `Arka arkaya gelen ${messages.length} mesajını tek bir istek olarak birleştiriyorum.`
    : `I’m combining your ${messages.length} consecutive messages into one ordered request.`;
}
