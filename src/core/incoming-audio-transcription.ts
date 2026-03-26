import type { Attachment, IncomingMessage } from "../channels/channel-messages.interface.js";
import { limitIncomingText } from "../channels/channel-messages.interface.js";
import { SpeechToTextTool } from "../agents/tools/speech-to-text.js";
import { isUrlSafeToFetch, validateMagicBytes, validateMediaAttachment } from "../utils/media-processor.js";
import { getLogger } from "../utils/logger.js";

export interface IncomingAudioTranscriptionResult {
  message: IncomingMessage;
  shouldDrop: boolean;
  userWarning?: string;
}

const VOICE_PLACEHOLDER_TEXTS = new Set([
  "(voice message)",
  "[voice message]",
  "voice message",
]);

function isVoicePlaceholder(text: string): boolean {
  return VOICE_PLACEHOLDER_TEXTS.has(text.trim().toLowerCase());
}

function hasMeaningfulText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !isVoicePlaceholder(trimmed);
}

function formatTranscriptBlock(attachment: Attachment, transcript: string, totalCount: number): string {
  if (totalCount === 1) {
    return transcript;
  }

  return `${attachment.name}:\n${transcript}`;
}

function mergeTranscriptIntoText(text: string, transcript: string): string {
  const trimmed = text.trim();
  if (!trimmed || isVoicePlaceholder(trimmed)) {
    return transcript;
  }

  return `${trimmed}\n\nVoice transcript:\n${transcript}`;
}

function sliceBufferToArrayBuffer(data: Buffer): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

async function transcribeAudioAttachment(
  tool: SpeechToTextTool,
  attachment: Attachment,
  projectPath: string,
): Promise<string | null> {
  const mimeType = attachment.mimeType ?? "";
  const logger = getLogger();

  if (attachment.data) {
    const validation = validateMediaAttachment({
      mimeType,
      size: attachment.data.length,
      type: "audio",
    });
    if (!validation.valid) {
      logger.warn("Skipping audio attachment transcription after validation failure", {
        name: attachment.name,
        reason: validation.reason,
      });
      return null;
    }

    if (!validateMagicBytes(attachment.data, mimeType)) {
      logger.warn("Skipping audio attachment transcription after magic-byte validation failure", {
        name: attachment.name,
        mimeType,
      });
      return null;
    }

    const transcript = await tool.transcribe(sliceBufferToArrayBuffer(attachment.data));
    return transcript.trim() || null;
  }

  if (!attachment.url || !isUrlSafeToFetch(attachment.url)) {
    return null;
  }

  const result = await tool.execute(
    {
      audio_url: attachment.url,
    },
    {
      projectPath,
      workingDirectory: projectPath,
      readOnly: true,
    },
  );

  if (result.isError) {
    logger.warn("Audio attachment transcription failed", {
      name: attachment.name,
      error: result.content,
    });
    return null;
  }

  const transcript = result.content.trim();
  return transcript || null;
}

export async function transcribeIncomingAudioMessage(
  msg: IncomingMessage,
  projectPath: string,
): Promise<IncomingAudioTranscriptionResult> {
  const audioAttachments = (msg.attachments ?? []).filter((attachment) => attachment.type === "audio");
  if (audioAttachments.length === 0) {
    return { message: msg, shouldDrop: false };
  }

  const hasText = hasMeaningfulText(msg.text);
  const openaiKey = process.env["OPENAI_API_KEY"];
  if (!openaiKey) {
    return {
      message: msg,
      shouldDrop: !hasText,
      userWarning: !hasText
        ? "Voice transcription is unavailable because OPENAI_API_KEY is not configured."
        : undefined,
    };
  }

  const tool = new SpeechToTextTool(openaiKey);
  const transcripts = await Promise.all(audioAttachments.map(async (attachment) => {
    try {
      const transcript = await transcribeAudioAttachment(tool, attachment, projectPath);
      return transcript ? formatTranscriptBlock(attachment, transcript, audioAttachments.length) : null;
    } catch (error) {
      getLogger().warn("Audio attachment transcription threw an error", {
        name: attachment.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }));

  const successfulTranscripts = transcripts.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  if (successfulTranscripts.length === 0) {
    return {
      message: msg,
      shouldDrop: !hasText,
      userWarning: !hasText
        ? "I received your audio message but could not transcribe it."
        : undefined,
    };
  }

  const transcriptText = successfulTranscripts.join("\n\n");
  return {
    shouldDrop: false,
    message: {
      ...msg,
      text: limitIncomingText(mergeTranscriptIntoText(msg.text, transcriptText)),
    },
  };
}
