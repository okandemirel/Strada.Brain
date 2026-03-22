import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock VoiceRecorder to avoid SpeechRecognition issues in jsdom
vi.mock('./VoiceRecorder', () => ({
  default: () => null,
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
})
