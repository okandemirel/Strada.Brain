/**
 * Files a user sent that did not reach the brain usable, and the reply that
 * says so.
 *
 * An adapter that drops a file and forwards the rest of the message has the
 * brain act on a request whose subject is missing: "build the game in this
 * GDD" without the GDD matched gdd-from-docs and built whatever document
 * already sat in docs/ (Telegram fixed 2026-09-02; Discord, Slack and Teams in
 * audit channels#1). So a message with a refused file is not forwarded at all,
 * not even its other files, and the user is told which file and why.
 */

export interface RejectedAttachment {
  readonly name: string;
  readonly reason: string;
}

export const ATTACHMENT_DOWNLOAD_FAILED = "it could not be downloaded";
export const ATTACHMENT_CONTENT_MISMATCH = "its content does not match its declared type";

export function rejectedAttachmentsReply(rejected: readonly RejectedAttachment[]): string {
  const files = rejected.map((file) => `"${file.name}" (${file.reason})`).join(", ");
  return (
    `${rejected.length === 1 ? "Your file was" : "Your files were"} not accepted: ${files}. ` +
    "Nothing from this message was sent to the brain — please resend it in a supported format " +
    "(PDF, TXT or CSV for documents) or paste the text."
  );
}
