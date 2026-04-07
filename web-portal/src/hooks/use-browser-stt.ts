/**
 * Browser-side Speech-to-Text Hook
 *
 * Uses a Web Worker running @huggingface/transformers Whisper model.
 * Audio decoding (blob -> Float32Array 16kHz) happens on the main thread
 * via AudioContext; only the heavy Whisper inference runs in the worker.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useVoiceSettings } from './use-voice-settings'

export type BrowserSttStatus = 'idle' | 'loading' | 'ready' | 'transcribing' | 'error'

interface PendingTranscription {
  resolve: (text: string | null) => void
  timer: ReturnType<typeof setTimeout>
}

const TRANSCRIBE_TIMEOUT_MS = 30_000

/** Decode an audio Blob to 16 kHz mono Float32Array using AudioContext. */
async function decodeAudioBlob(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer()
  const ctx = new AudioContext({ sampleRate: 16000 })
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer)
    return decoded.getChannelData(0)
  } finally {
    void ctx.close()
  }
}

export function useBrowserStt() {
  const [status, setStatus] = useState<BrowserSttStatus>('idle')
  const [loadProgress, setLoadProgress] = useState(0)
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<number, PendingTranscription>>(new Map())
  const nextIdRef = useRef(1)
  const statusRef = useRef<BrowserSttStatus>('idle')

  // Keep ref in sync so async callbacks read current value
  useEffect(() => { statusRef.current = status }, [status])

  // Reactive settings (Fix #3: use hook, not plain function)
  const { voice } = useVoiceSettings()
  const enabled = voice.browserSttEnabled && typeof Worker !== 'undefined'

  // Initialize worker on first use (lazy)
  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current

    const worker = new Worker(
      new URL('../lib/whisper-worker.ts', import.meta.url),
      { type: 'module' },
    )

    worker.onmessage = (e: MessageEvent) => {
      const { type } = e.data

      if (type === 'load-progress') {
        setLoadProgress(Math.round(e.data.progress ?? 0))
      } else if (type === 'ready') {
        setStatus('ready')
        statusRef.current = 'ready'
        setLoadProgress(100)
      } else if (type === 'result') {
        const pending = pendingRef.current.get(e.data.id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingRef.current.delete(e.data.id)
          pending.resolve(e.data.text || null)
        }
        if (pendingRef.current.size === 0) {
          setStatus('ready')
          statusRef.current = 'ready'
        }
      } else if (type === 'error') {
        const id = e.data.id as number | undefined
        if (id !== undefined) {
          const pending = pendingRef.current.get(id)
          if (pending) {
            clearTimeout(pending.timer)
            pendingRef.current.delete(id)
            pending.resolve(null)
          }
        }
        if (pendingRef.current.size === 0) {
          const next = workerRef.current ? 'ready' : 'error' as BrowserSttStatus
          setStatus(next)
          statusRef.current = next
        }
      }
    }

    // Fix #5: null workerRef on crash so next ensureWorker creates a fresh one
    worker.onerror = () => {
      workerRef.current = null
      setStatus('error')
      statusRef.current = 'error'
      for (const [, pending] of pendingRef.current) {
        clearTimeout(pending.timer)
        pending.resolve(null)
      }
      pendingRef.current.clear()
    }

    workerRef.current = worker
    return worker
  }, [])

  /** Wait for the worker to reach 'ready' state. */
  const waitForReady = useCallback((worker: Worker): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (statusRef.current === 'ready') { resolve(); return }
      const onMsg = (e: MessageEvent) => {
        if (e.data.type === 'ready') {
          worker.removeEventListener('message', onMsg)
          resolve()
        } else if (e.data.type === 'error' && e.data.id === undefined) {
          worker.removeEventListener('message', onMsg)
          reject(new Error(e.data.message))
        }
      }
      worker.addEventListener('message', onMsg)
    })
  }, [])

  // Load the model (call once before first transcription)
  const loadModel = useCallback(() => {
    if (!enabled) return
    const s = statusRef.current
    if (s === 'loading' || s === 'ready') return

    setStatus('loading')
    statusRef.current = 'loading'
    setLoadProgress(0)
    const worker = ensureWorker()
    worker.postMessage({ type: 'load' })
  }, [enabled, ensureWorker])

  // Transcribe an audio blob (Fix #1: wait when loading, Fix #4: use statusRef)
  const transcribe = useCallback(async (blob: Blob): Promise<string | null> => {
    if (!enabled) return null

    const worker = ensureWorker()
    const s = statusRef.current

    // Ensure model is loaded — wait if idle or still loading
    if (s === 'idle' || s === 'loading') {
      if (s === 'idle') {
        setStatus('loading')
        statusRef.current = 'loading'
        worker.postMessage({ type: 'load' })
      }
      try {
        await waitForReady(worker)
      } catch {
        return null
      }
    }

    // Decode audio on main thread
    let audio: Float32Array
    try {
      audio = await decodeAudioBlob(blob)
    } catch {
      return null
    }
    if (audio.length === 0) return null

    setStatus('transcribing')
    statusRef.current = 'transcribing'
    const id = nextIdRef.current++

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingRef.current.delete(id)
        if (pendingRef.current.size === 0) {
          setStatus('ready')
          statusRef.current = 'ready'
        }
        resolve(null)
      }, TRANSCRIBE_TIMEOUT_MS)

      pendingRef.current.set(id, { resolve, timer })
      worker.postMessage(
        { type: 'transcribe', audio, id },
        [audio.buffer],
      )
    })
  }, [enabled, ensureWorker, waitForReady])

  // Cleanup on unmount
  useEffect(() => {
    const pending = pendingRef.current
    return () => {
      const worker = workerRef.current
      if (worker) {
        worker.terminate()
        workerRef.current = null
      }
      for (const [, p] of pending) {
        clearTimeout(p.timer)
      }
      pending.clear()
    }
  }, [])

  return {
    status,
    loadProgress,
    enabled,
    loadModel,
    transcribe,
  }
}
