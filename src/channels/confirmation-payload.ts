/**
 * Confirmation-prompt payloads that fit every platform's limits (CHN-7).
 *
 * A button used to carry `<confirm_ + uuid>:<option text>`, which is 45
 * characters before the option: Telegram's 64-byte `callback_data` refused any
 * option over ~19 bytes and Discord's 100-character `customId` any over 55,
 * while `ask_user` allows options of 100. A button now carries a short opaque
 * id and the option's INDEX; the option text stays server-side with the
 * pending prompt and is looked up (and range-checked) when the click arrives.
 *
 * A prompt that could not be delivered is answered with the non-answer
 * sentinel `CONFIRMATION_NOT_ANSWERED` ("timeout"), which every caller already
 * treats as "nobody answered" — never with an option-like word such as
 * "cancelled", which callers read as the user's decision.
 */

/** The value every caller treats as "the user did not answer". */
export const CONFIRMATION_NOT_ANSWERED = "timeout";

/** A short, opaque prompt id: `confirm_` plus 12 hex characters of a UUID. */
export function shortConfirmationId(uuid: string): string {
  return `confirm_${uuid.replace(/-/g, "").slice(0, 12)}`;
}

/** The button payload for option `index` of prompt `confirmId`. */
export function encodeConfirmationChoice(confirmId: string, index: number): string {
  return `${confirmId}:${index}`;
}

/**
 * Split a button payload back into its prompt id and option index. Undefined
 * for anything that is not `<id>:<non-negative integer>`.
 */
export function decodeConfirmationChoice(data: string): { confirmId: string; index: number } | undefined {
  const separator = data.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const rawIndex = data.slice(separator + 1);
  if (!/^\d{1,3}$/.test(rawIndex)) return undefined;
  return { confirmId: data.slice(0, separator), index: Number(rawIndex) };
}

/** The option a clicked index names, or undefined when it names none. */
export function confirmationOptionAt(options: readonly string[], index: number): string | undefined {
  return Number.isInteger(index) && index >= 0 && index < options.length ? options[index] : undefined;
}

/**
 * `text` cut to at most `max` UTF-16 units, ending in an ellipsis when cut,
 * without splitting a surrogate pair.
 */
export function fitText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}
