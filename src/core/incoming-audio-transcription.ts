import type { Attachment, IncomingMessage } from "../channels/channel-messages.interface.js";
import { limitIncomingText } from "../channels/channel-messages.interface.js";
import { SpeechToTextTool } from "../agents/tools/speech-to-text.js";
import { isUrlSafeToFetch, normalizeMimeType, validateMagicBytes, validateMediaAttachment } from "../utils/media-processor.js";
import { getLogger } from "../utils/logger.js";
import { sttMode, transcribeLocal } from "./local-stt-engine.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

export interface IncomingAudioTranscriptionResult {
  message: IncomingMessage;
  shouldDrop: boolean;
  userWarning?: string;
}

/** Voice message placeholder texts across all supported languages (EN, TR, JA, KO, ZH, DE, ES, FR). */
const VOICE_PLACEHOLDER_TEXTS = new Set([
  // English
  "(voice message)",
  "[voice message]",
  "voice message",
  // Turkish
  "(sesli mesaj)",
  // Spanish
  "(mensaje de voz)",
  // German — lowercase for case-insensitive match
  "(sprachnachricht)",
  // Korean
  "(음성 메시지)",
  // French
  "(message vocal)",
  // Chinese (full-width parentheses)
  "（语音消息）",
  // Japanese (full-width parentheses)
  "(音声メッセージ)",
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

/**
 * Resolve the best available STT provider.
 * Priority: explicit STT_PROVIDER env → OpenAI → Groq → null.
 */
function resolveSpeechToTextTool(): SpeechToTextTool | null {
  const explicitProvider = process.env["STT_PROVIDER"]?.toLowerCase().trim();

  if (explicitProvider === "openai") {
    const key = process.env["OPENAI_API_KEY"];
    return key ? new SpeechToTextTool(key) : null;
  }

  if (explicitProvider === "groq") {
    const key = process.env["GROQ_API_KEY"];
    return key ? new SpeechToTextTool(key, GROQ_BASE_URL, GROQ_WHISPER_MODEL) : null;
  }

  // Auto-detect: try OpenAI first, then Groq
  const openaiKey = process.env["OPENAI_API_KEY"];
  if (openaiKey) {
    return new SpeechToTextTool(openaiKey);
  }

  const groqKey = process.env["GROQ_API_KEY"];
  if (groqKey) {
    return new SpeechToTextTool(groqKey, GROQ_BASE_URL, GROQ_WHISPER_MODEL);
  }

  return null;
}

/** Validate an audio attachment's MIME type and magic bytes. */
function validateAudioAttachment(attachment: Attachment): boolean {
  if (!attachment.data) return true;
  const mimeType = normalizeMimeType(attachment.mimeType) ?? "";
  const logger = getLogger();

  const validation = validateMediaAttachment({ mimeType, size: attachment.data.length, type: "audio" });
  if (!validation.valid) {
    logger.warn("Skipping audio transcription: validation failure", { name: attachment.name, reason: validation.reason });
    return false;
  }
  if (!validateMagicBytes(attachment.data, mimeType)) {
    logger.warn("Skipping audio transcription: magic-byte mismatch", { name: attachment.name, mimeType });
    return false;
  }
  return true;
}

/** Try local Whisper transcription (provider-free). */
async function transcribeWithLocalEngine(attachment: Attachment): Promise<string | null> {
  if (!attachment.data) return null;
  const mimeType = normalizeMimeType(attachment.mimeType) ?? "";
  return (await transcribeLocal(attachment.data, mimeType))?.trim() || null;
}

/** Try cloud API transcription (OpenAI/Groq). */
async function transcribeWithCloudApi(
  tool: SpeechToTextTool,
  attachment: Attachment,
  projectPath: string,
): Promise<string | null> {
  if (attachment.data) {
    const transcript = await tool.transcribe(sliceBufferToArrayBuffer(attachment.data));
    return transcript.trim() || null;
  }
  if (!attachment.url || !isUrlSafeToFetch(attachment.url)) return null;

  const result = await tool.execute(
    { audio_url: attachment.url },
    { projectPath, workingDirectory: projectPath, readOnly: true },
  );
  if (result.isError) {
    getLogger().warn("Cloud STT failed", { name: attachment.name, error: result.content });
    return null;
  }
  return result.content.trim() || null;
}

/** Transcribe a single audio attachment: local → cloud fallback. */
async function transcribeAudioAttachment(
  cloudTool: SpeechToTextTool | null,
  attachment: Attachment,
  projectPath: string,
): Promise<string | null> {
  if (!validateAudioAttachment(attachment)) return null;

  const mode = sttMode();

  // Tier 1: Local Whisper (no API key needed)
  if (mode === "auto" || mode === "local") {
    const localResult = await transcribeWithLocalEngine(attachment);
    if (localResult) return localResult;
  }

  // Tier 2: Cloud API (OpenAI / Groq)
  if (cloudTool && (mode === "auto" || mode === "cloud")) {
    try {
      return await transcribeWithCloudApi(cloudTool, attachment, projectPath);
    } catch (error) {
      getLogger().warn("Cloud STT threw", {
        name: attachment.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
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
  const mode = sttMode();

  if (mode === "disabled") {
    return {
      message: msg,
      shouldDrop: !hasText,
      userWarning: !hasText ? "Voice transcription is disabled (STT_MODE=disabled)." : undefined,
    };
  }

  // Cloud tool is optional — local STT can work without it
  const cloudTool = resolveSpeechToTextTool();

  // Cap audio attachments to prevent budget abuse (max 3 per message)
  const cappedAttachments = audioAttachments.slice(0, 3);
  const transcripts = await Promise.all(cappedAttachments.map(async (attachment) => {
    try {
      const transcript = await transcribeAudioAttachment(cloudTool, attachment, projectPath);
      return transcript ? formatTranscriptBlock(attachment, transcript, cappedAttachments.length) : null;
    } catch (error) {
      getLogger().warn("Audio transcription threw", {
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
        ? "Voice transcription is unavailable. Install @huggingface/transformers and FFmpeg for local transcription, or set OPENAI_API_KEY / GROQ_API_KEY for cloud transcription."
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
