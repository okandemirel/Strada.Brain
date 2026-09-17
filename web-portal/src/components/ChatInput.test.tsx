import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock VoiceRecorder to avoid SpeechRecognition issues in jsdom
vi.mock('./VoiceRecorder', () => ({
  default: ({ onVoiceMessage, disabled }: { onVoiceMessage: (attachment: unknown) => void; disabled?: boolean }) => (
    <button
      type="button"
      onClick={() => onVoiceMessage({
        name: 'voice.webm',
        type: 'audio/webm;codecs=opus',
        data: 'dm9pY2U=',
        size: 5,
      })}
      disabled={disabled}
    >
      Record Voice
    </button>
  ),
}))

import ChatInput from './ChatInput'

describe('ChatInput', () => {
  let onSend: (text: string, attachments?: unknown[]) => boolean

  beforeEach(() => {
    onSend = vi.fn().mockReturnValue(true) as unknown as (text: string, attachments?: unknown[]) => boolean
  })

  it('renders input field', () => {
    render(<ChatInput onSend={onSend} disabled={false} />)
    expect(screen.getByPlaceholderText(/Send a message/)).toBeInTheDocument()
  })

  it('send button disabled when empty', () => {
    render(<ChatInput onSend={onSend} disabled={false} />)
    const sendBtn = screen.getByRole('button', { name: 'Send' })
    expect(sendBtn).toBeDisabled()
  })

  it('sends message on Enter', async () => {
    const user = userEvent.setup()
    render(<ChatInput onSend={onSend} disabled={false} />)

    const textarea = screen.getByPlaceholderText(/Send a message/)
    await user.type(textarea, 'Hello world')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledWith('Hello world', undefined)
  })

  it('handles file drag and drop', () => {
    render(<ChatInput onSend={onSend} disabled={false} />)

    const dropZone = screen.getByPlaceholderText(/Send a message/).closest('div[class*="flex flex-col"]')!
    const file = new File(['hello'], 'test.txt', { type: 'text/plain' })

    const dataTransfer = {
      files: [file],
      types: ['Files'],
    }

    fireEvent.dragOver(dropZone, { dataTransfer })
    fireEvent.drop(dropZone, { dataTransfer })

    // After drop, file preview should appear
    expect(screen.getByText('test.txt')).toBeInTheDocument()
  })

  it('tells the user why a dropped file was not attached instead of dropping it silently (D37)', () => {
    render(<ChatInput onSend={onSend} disabled={false} />)
    const dropZone = screen.getByPlaceholderText(/Send a message/).closest('div[class*="flex flex-col"]')!

    const docx = new File(['PK'], 'GDD.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const noMime = new File(['x'], 'notes.md', { type: '' })
    const huge = new File(['x'], 'capture.mp4', { type: 'video/mp4' })
    Object.defineProperty(huge, 'size', { value: 21 * 1024 * 1024 })
    fireEvent.drop(dropZone, { dataTransfer: { files: [docx, noMime, huge] } })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('GDD.docx: Word documents (.docx) are not accepted')
    expect(alert).toHaveTextContent('notes.md: unsupported file type (unknown)')
    expect(alert).toHaveTextContent('capture.mp4: larger than the 20 MB limit')
    // None of them became an attachment.
    expect(screen.queryByText('GDD.docx')).toBeNull()
    expect(screen.queryByText('capture.mp4')).toBeNull()
  })

  it('names the file that exceeded the per-message limit (D37)', () => {
    render(<ChatInput onSend={onSend} disabled={false} />)
    const dropZone = screen.getByPlaceholderText(/Send a message/).closest('div[class*="flex flex-col"]')!
    const files = Array.from({ length: 6 }, (_, i) => new File(['x'], `f${i}.txt`, { type: 'text/plain' }))
    fireEvent.drop(dropZone, { dataTransfer: { files } })
    expect(screen.getByRole('alert')).toHaveTextContent('f5.txt: at most 5 files per message')
    expect(screen.getByText('f4.txt')).toBeInTheDocument()
    expect(screen.queryByText('f5.txt')).toBeNull()
  })

  it('attaches an accepted type without any rejection notice (guard)', () => {
    render(<ChatInput onSend={onSend} disabled={false} />)
    const dropZone = screen.getByPlaceholderText(/Send a message/).closest('div[class*="flex flex-col"]')!
    fireEvent.drop(dropZone, { dataTransfer: { files: [new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' })] } })
    expect(screen.getByText('spec.pdf')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows file preview after drop', () => {
    render(<ChatInput onSend={onSend} disabled={false} />)

    const dropZone = screen.getByPlaceholderText(/Send a message/).closest('div[class*="flex flex-col"]')!
    const file = new File(['content'], 'document.pdf', { type: 'application/pdf' })

    fireEvent.drop(dropZone, {
      dataTransfer: { files: [file] },
    })

    expect(screen.getByText('document.pdf')).toBeInTheDocument()
    // The file extension badge should be shown
    expect(screen.getByText('PDF')).toBeInTheDocument()
  })

  it('enables send button when text is entered', async () => {
    const user = userEvent.setup()
    render(<ChatInput onSend={onSend} disabled={false} />)
    const sendBtn = screen.getByRole('button', { name: 'Send' })
    expect(sendBtn).toBeDisabled()

    await user.type(screen.getByPlaceholderText(/Send a message/), 'Hello')
    expect(sendBtn).not.toBeDisabled()
  })

  it('clears input after sending', async () => {
    const user = userEvent.setup()
    render(<ChatInput onSend={onSend} disabled={false} />)
    const textarea = screen.getByPlaceholderText(/Send a message/) as HTMLTextAreaElement

    await user.type(textarea, 'test message')
    await user.keyboard('{Enter}')

    expect(textarea.value).toBe('')
  })

  it('disables input when disabled prop is true', () => {
    render(<ChatInput onSend={onSend} disabled={true} />)
    const textarea = screen.getByPlaceholderText(/Send a message/)
    expect(textarea).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('resets workspace override after sending message', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace-store')
    const resetOverrideSpy = vi.spyOn(useWorkspaceStore.getState(), 'resetOverride')

    const user = userEvent.setup()
    render(<ChatInput onSend={onSend} disabled={false} />)

    const textarea = screen.getByPlaceholderText(/Send a message/)
    await user.type(textarea, 'Hello world')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalled()
    expect(resetOverrideSpy).toHaveBeenCalled()

    resetOverrideSpy.mockRestore()
  })

  it('sends a recorded voice attachment', async () => {
    const user = userEvent.setup()
    render(<ChatInput onSend={onSend} disabled={false} />)

    await user.click(screen.getByRole('button', { name: 'Record Voice' }))

    expect(onSend).toHaveBeenCalledWith('(voice message)', [{
      name: 'voice.webm',
      type: 'audio/webm;codecs=opus',
      data: 'dm9pY2U=',
      size: 5,
    }])
  })
})
