import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useMonitorStore } from '../../stores/monitor-store'
import RootSwitcher from './RootSwitcher'

// i18n: return the key so assertions are stable without loading translations.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// lucide icon stub
vi.mock('lucide-react', () => ({
  ChevronDown: () => <svg data-testid="chevron" />,
}))

function seedRoot(rootId: string, label: string, conversationId?: string) {
  useMonitorStore.getState().setDAG(
    { nodes: [{ id: rootId }], edges: [] },
    rootId,
    { label, conversationId },
  )
}

describe('RootSwitcher', () => {
  beforeEach(() => {
    useMonitorStore.getState().clearMonitor()
  })

  it('renders nothing when there is one root or fewer (single-request UX)', () => {
    const { container } = render(<RootSwitcher />)
    expect(container).toBeEmptyDOMElement()

    seedRoot('root-a', 'Only request', 'conv-1')
    const { container: c2 } = render(<RootSwitcher />)
    expect(c2).toBeEmptyDOMElement()
  })

  it('renders the trigger with the active root label when more than one root exists', () => {
    seedRoot('root-a', 'Build login page', 'conv-1')
    seedRoot('root-b', 'Add dark mode', 'conv-1')
    useMonitorStore.getState().setActiveRootId('root-a')

    render(<RootSwitcher />)
    // The active root label is shown on the trigger.
    expect(screen.getByText('Build login page')).toBeInTheDocument()
    expect(screen.getByLabelText('panel.rootSwitcher')).toBeInTheDocument()
  })

  it('falls back to the select placeholder when there is no active root', () => {
    seedRoot('root-a', 'A', 'conv-1')
    seedRoot('root-b', 'B', 'conv-2')

    render(<RootSwitcher />)
    expect(screen.getByText('panel.rootSwitcherSelect')).toBeInTheDocument()
  })
})
