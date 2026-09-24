import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VoiceRecorder from './VoiceRecorder'

class MockMediaRecorder {
  static isTypeSupported = () => true
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm'
  }

  start() {
    this.state = 'recording'
    this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/webm' }) })
  }

  stop() {
    this.state = 'inactive'
    this.onstop?.()
  }
}

const originalMediaRecorder = window.MediaRecorder
const originalMediaDevices = navigator.mediaDevices

describe('VoiceRecorder', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'MediaRecorder', { value: MockMediaRecorder, configurable: true, writable: true })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
      configurable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'MediaRecorder', { value: originalMediaRecorder, configurable: true, writable: true })
    Object.defineProperty(navigator, 'mediaDevices', { value: originalMediaDevices, configurable: true })
  })

  it('sends the clip when the user stops recording (guard)', async () => {
    const user = userEvent.setup()
    const onVoiceMessage = vi.fn().mockReturnValue(true)
    render(<VoiceRecorder onVoiceMessage={onVoiceMessage} />)

    await user.click(screen.getByRole('button', { name: 'Voice input' }))
    await user.click(screen.getByRole('button', { name: 'Stop recording' }))

    await waitFor(() => expect(onVoiceMessage).toHaveBeenCalledTimes(1))
    expect(onVoiceMessage.mock.calls[0]![0]).toEqual(expect.objectContaining({ type: 'audio/webm;codecs=opus', size: 5 }))
  })

  // WEB-5: a server-driven mode switch unmounted the recorder mid-clip; its
  // cleanup stopped the MediaRecorder, whose onstop then SENT the partial clip.
  it('does not send a clip cut short by the recorder being unmounted', async () => {
    const user = userEvent.setup()
    const onVoiceMessage = vi.fn().mockReturnValue(true)
    const { unmount } = render(<VoiceRecorder onVoiceMessage={onVoiceMessage} />)

    await user.click(screen.getByRole('button', { name: 'Voice input' }))
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()
    unmount()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onVoiceMessage).not.toHaveBeenCalled()
  })

  it('reports a recording as busy input so mode suggestions wait for it', async () => {
    const user = userEvent.setup()
    const onBusyChange = vi.fn()
    render(<VoiceRecorder onVoiceMessage={vi.fn()} onBusyChange={onBusyChange} />)

    await user.click(screen.getByRole('button', { name: 'Voice input' }))
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    await user.click(screen.getByRole('button', { name: 'Stop recording' }))
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false))
  })
})
