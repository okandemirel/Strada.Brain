/**
 * Speech-to-Text Tool
 *
 * Transcribes audio files using the OpenAI Whisper API.
 * Used by Telegram channel for voice message processing.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { getLogger } from "../../utils/logger.js";
import { fetchWithRetry } from "../../common/fetch-with-retry.js";
import { isUrlSafeToFetch } from "../../utils/media-processor.js";
import { sanitizeSecrets } from "../../security/secret-sanitizer.js";

/** Strip tokens from Telegram-style bot URLs for safe logging. */
function sanitizeUrlForLog(url: string): string {
  return url.replace(/\/bot[^/]+\//, "/bot****/");
}

const MAX_AUDIO_SIZE_MB = 25; // Whisper API limit

export class SpeechToTextTool implements ITool {
  readonly name = "speech_to_text";
  readonly description = "Transcribe audio to text using OpenAI Whisper API";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      audio_url: {
        type: "string",
        description: "URL or file path to the audio file",
      },
      language: {
        type: "string",
        description: "ISO 639-1 language code (e.g., 'en', 'tr')",
      },
    },
    required: ["audio_url"],
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(apiKey: string, baseUrl = "https://api.openai.com/v1", model = "whisper-1") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const logger = getLogger();
    const audioUrl = String(input["audio_url"] ?? "");
    const language = input["language"] ? String(input["language"]) : undefined;

    if (!audioUrl) {
      return { content: "audio_url is required", isError: true };
    }

    try {
      const audioData = await this.fetchAudio(audioUrl, context);

      if (audioData.byteLength > MAX_AUDIO_SIZE_MB * 1024 * 1024) {
        return { content: `Audio file exceeds ${MAX_AUDIO_SIZE_MB}MB limit`, isError: true };
      }

      const transcript = await this.transcribe(audioData, language);
      logger.debug("Speech-to-text transcription completed", {
        audioUrl: sanitizeUrlForLog(audioUrl),
        transcriptLength: transcript.length,
      });

      return { content: transcript };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Speech-to-text failed", { audioUrl: sanitizeUrlForLog(audioUrl), error: sanitizeSecrets(msg) });
      return { content: `Transcription failed: ${sanitizeSecrets(msg)}`, isError: true };
    }
  }

  /**
   * Transcribe raw audio bytes via the Whisper API.
   */
  async transcribe(audioData: ArrayBuffer, language?: string): Promise<string> {
    const formData = new FormData();
    formData.append("file", new Blob([audioData]), "audio.ogg");
    formData.append("model", this.model);
    if (language) {
      formData.append("language", language);
    }

    const response = await fetchWithRetry(
      `${this.baseUrl}/audio/transcriptions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData,
      },
      { maxRetries: 2, callerName: "Whisper" },
    );

    const data = (await response.json()) as { text: string };
    return data.text;
  }

  private async fetchAudio(url: string, context: ToolContext): Promise<ArrayBuffer> {
    const maxBytes = MAX_AUDIO_SIZE_MB * 1024 * 1024;

    if (url.startsWith("http://") || url.startsWith("https://")) {
      if (!isUrlSafeToFetch(url)) {
        throw new Error("Audio URL blocked by SSRF protection");
      }
      const response = await fetchWithRetry(url, { redirect: "error" }, { maxRetries: 2, callerName: "AudioFetch" });
      const contentLength = parseInt(response.headers.get("content-length") ?? "", 10);
      if (contentLength > maxBytes) {
        throw new Error(`Audio file exceeds ${MAX_AUDIO_SIZE_MB}MB limit (${contentLength} bytes)`);
      }
      return response.arrayBuffer();
    }

    // Local file — validate path stays within project directory
    const { resolve, sep } = await import("node:path");
    const safeRoot = resolve(context.projectPath);
    const resolved = resolve(safeRoot, url);
    if (!resolved.startsWith(safeRoot + sep) && resolved !== safeRoot) {
      throw new Error("Path traversal blocked: audio path must be within the project directory");
    }

    // Validate audio file extension
    const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
    const allowedExts = ["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"];
    if (!allowedExts.includes(ext)) {
      throw new Error(`Unsupported audio format: .${ext}`);
    }

    const { stat, readFile } = await import("node:fs/promises");
    const fileInfo = await stat(resolved);
    if (fileInfo.size > maxBytes) {
      throw new Error(`Audio file exceeds ${MAX_AUDIO_SIZE_MB}MB limit (${fileInfo.size} bytes)`);
    }
    const buffer = await readFile(resolved);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
}
