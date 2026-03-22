import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfirmDialog from './ConfirmDialog'
import type { ConfirmationState } from '../types/messages'

function makeConfirmation(overrides: Partial<ConfirmationState> = {}): ConfirmationState {
  return {
    confirmId: 'confirm-test',
    question: 'Do you want to proceed?',
    options: ['Yes', 'No'],
    ...overrides,
  }
}

describe('ConfirmDialog', () => {
  it('renders question text', () => {
    render(
      <ConfirmDialog
        confirmation={makeConfirmation()}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText('Do you want to proceed?')).toBeInTheDocument()
  })

  it('renders option buttons', () => {
    render(
      <ConfirmDialog
        confirmation={makeConfirmation({ options: ['Accept', 'Reject', 'Skip'] })}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
  })

  it('highlights recommended option', () => {
    render(
      <ConfirmDialog
        confirmation={makeConfirmation({ options: ['Approve (Recommended)', 'Reject'] })}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    // The recommended button uses default variant (bg-accent), the other uses outline
    const approveBtn = screen.getByRole('button', { name: /Approve/i })
    expect(approveBtn.className).toContain('bg-accent')
  })

  it('detects plan questions (starts with "**Plan:")', () => {
    render(
      <ConfirmDialog
        confirmation={makeConfirmation({
          question: '**Plan: Deploy release**\n1. Build\n2. Test\n3. Ship',
          options: ['Approve (Recommended)', 'Modify', 'Reject'],
        })}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText('Plan: Deploy release')).toBeInTheDocument()
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.getByText('Test')).toBeInTheDocument()
    expect(screen.getByText('Ship')).toBeInTheDocument()
  })

  it('calls onRespond with selected option', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ConfirmDialog
        confirmation={makeConfirmation({ options: ['Yes', 'No'] })}
        onRespond={onRespond}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onRespond).toHaveBeenCalledWith('confirm-test', 'Yes')
  })

  it('modify option shows textarea', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ConfirmDialog
        confirmation={makeConfirmation({ options: ['Approve', 'Modify'] })}
        onRespond={onRespond}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Modify' }))
    expect(screen.getByPlaceholderText('Describe your modification...')).toBeInTheDocument()
    // onRespond should NOT have been called -- modify shows input instead
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('closes on ESC (calls onRespond with timeout)', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ConfirmDialog
        confirmation={makeConfirmation()}
        onRespond={onRespond}
      />,
    )
    await user.keyboard('{Escape}')
    expect(onRespond).toHaveBeenCalledWith('confirm-test', 'timeout')
  })

  it('submits modify text on Enter key', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ConfirmDialog
        confirmation={makeConfirmation({ options: ['Approve', 'Modify'] })}
        onRespond={onRespond}
      />,
    )
    // Click Modify to show the textarea
    await user.click(screen.getByRole('button', { name: 'Modify' }))
    const textarea = screen.getByPlaceholderText('Describe your modification...')
    await user.type(textarea, 'Change step 2')
    await user.keyboard('{Enter}')
    expect(onRespond).toHaveBeenCalledWith('confirm-test', 'Modify: Change step 2')
  })

  it('renders details when provided', () => {
    render(
      <ConfirmDialog
        confirmation={makeConfirmation({ details: 'Here are more details about this action.' })}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText('Here are more details about this action.')).toBeInTheDocument()
  })
})
