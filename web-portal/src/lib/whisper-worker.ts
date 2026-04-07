/**
 * Whisper Web Worker
 *
 * Runs @huggingface/transformers Whisper pipeline off the main thread.
 * Audio decoding happens on the main thread (AudioContext), only inference runs here.
 *
 * Message protocol:
 *   Main -> Worker: { type: 'load', model? } | { type: 'transcribe', audio: Float32Array, id }
 *   Worker -> Main: { type: 'load-progress', progress, status } | { type: 'ready' }
 *                 | { type: 'result', text, id } | { type: 'error', message, id? }
 */

import { pipeline, env } from '@huggingface/transformers'

// Disable local model path (browser uses Cache API)
env.allowLocalModels = false

let transcriber: ((input: Float32Array) => Promise<{ text: string }>) | null = null
let loadPromise: Promise<void> | null = null

async function loadModel(model: string): Promise<void> {
  if (transcriber) { self.postMessage({ type: 'ready' }); return }
  if (loadPromise) { await loadPromise; self.postMessage({ type: 'ready' }); return }

  loadPromise = (async () => {
    const p = await pipeline('automatic-speech-recognition', model, {
      progress_callback: (progress: { status: string; progress?: number }) => {
        self.postMessage({
          type: 'load-progress',
          progress: progress.progress ?? 0,
          status: progress.status,
        })
      },
    } as Record<string, unknown>)
    transcriber = p as unknown as typeof transcriber
  })()

  await loadPromise
  loadPromise = null
  self.postMessage({ type: 'ready' })
}

async function transcribe(audio: Float32Array, id: number): Promise<void> {
  if (!transcriber) {
    self.postMessage({ type: 'error', message: 'Model not loaded', id })
    return
  }

  const result = await transcriber(audio)
  self.postMessage({ type: 'result', text: result.text?.trim() ?? '', id })
}

self.onmessage = async (e: MessageEvent) => {
  const { type } = e.data as { type: string }

  try {
    if (type === 'load') {
      await loadModel((e.data as { model?: string }).model || 'onnx-community/whisper-tiny.en')
    } else if (type === 'transcribe') {
      const { audio, id } = e.data as { audio: Float32Array; id: number }
      await transcribe(audio, id)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    self.postMessage({ type: 'error', message, id: (e.data as { id?: number }).id })
  }
}
