import type { Attachment, ChatMessage, MessageAttachment } from '../types/messages'

/** Image types the chat renders as thumbnails (the rest show as a file chip). */
export const PREVIEWABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

function objectUrlFromBase64(data: string, type: string): string | undefined {
  if (typeof URL.createObjectURL !== 'function') return undefined
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return URL.createObjectURL(new Blob([bytes], { type }))
  } catch {
    return undefined
  }
}

/**
 * The history's copy of attachments that are being sent. The base64 stays
 * only in the outgoing frame: kept in history it held up to ~133 MB per
 * message for as long as the tab lived (WEB-19). Images keep their bytes as
 * an object URL for the thumbnail.
 */
export function toMessageAttachments(attachments: Attachment[]): MessageAttachment[] {
  return attachments.map(({ name, type, size, data }) => {
    const previewUrl = PREVIEWABLE_IMAGE_TYPES.has(type) ? objectUrlFromBase64(data, type) : undefined
    return previewUrl ? { name, type, size, previewUrl } : { name, type, size }
  })
}

function previewUrlsOf(lists: ReadonlyArray<readonly ChatMessage[] | null>): Set<string> {
  const urls = new Set<string>()
  for (const list of lists) {
    for (const message of list ?? []) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.previewUrl) urls.add(attachment.previewUrl)
      }
    }
  }
  return urls
}

/** Revoke the thumbnails of messages that were in `before` and are in none of `after`. */
export function releaseDroppedPreviews(
  before: ReadonlyArray<readonly ChatMessage[] | null>,
  after: ReadonlyArray<readonly ChatMessage[] | null>,
): void {
  const dropped = previewUrlsOf(before)
  if (dropped.size === 0 || typeof URL.revokeObjectURL !== 'function') return
  const kept = previewUrlsOf(after)
  for (const url of dropped) {
    if (!kept.has(url)) URL.revokeObjectURL(url)
  }
}
