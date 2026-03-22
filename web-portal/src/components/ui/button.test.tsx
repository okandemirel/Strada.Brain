import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './button'

describe('Button', () => {
  it('renders with default variant', () => {
    render(<Button>Click me</Button>)
    const btn = screen.getByRole('button', { name: 'Click me' })
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('bg-accent')
  })

  it('renders outline variant', () => {
    render(<Button variant="outline">Outline</Button>)
    const btn = screen.getByRole('button', { name: 'Outline' })
    expect(btn.className).toContain('border')
    expect(btn.className).toContain('bg-transparent')
  })

  it('renders ghost variant', () => {
    render(<Button variant="ghost">Ghost</Button>)
    const btn = screen.getByRole('button', { name: 'Ghost' })
    expect(btn.className).toContain('hover:bg-surface-hover')
    expect(btn.className).not.toContain('bg-accent')
  })

  it('renders destructive variant', () => {
    render(<Button variant="destructive">Delete</Button>)
    const btn = screen.getByRole('button', { name: 'Delete' })
    expect(btn.className).toContain('bg-error')
  })

  it('renders sm size', () => {
    render(<Button size="sm">Small</Button>)
    const btn = screen.getByRole('button', { name: 'Small' })
    expect(btn.className).toContain('h-8')
    expect(btn.className).toContain('text-xs')
  })

  it('renders lg size', () => {
    render(<Button size="lg">Large</Button>)
    const btn = screen.getByRole('button', { name: 'Large' })
    expect(btn.className).toContain('h-11')
    expect(btn.className).toContain('text-base')
  })

  it('renders icon size', () => {
    render(<Button size="icon">X</Button>)
    const btn = screen.getByRole('button', { name: 'X' })
    expect(btn.className).toContain('w-9')
  })

  it('forwards ref', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Button ref={ref}>Ref</Button>)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
    expect(ref.current?.textContent).toBe('Ref')
  })

  it('handles disabled state', () => {
    const onClick = vi.fn()
    render(<Button disabled onClick={onClick}>Disabled</Button>)
    const btn = screen.getByRole('button', { name: 'Disabled' })
    expect(btn).toBeDisabled()
    expect(btn.className).toContain('disabled:opacity-50')
  })

  it('applies custom className', () => {
    render(<Button className="my-custom-class">Custom</Button>)
    const btn = screen.getByRole('button', { name: 'Custom' })
    expect(btn.className).toContain('my-custom-class')
  })

  it('calls onClick handler when clicked', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Clickable</Button>)
    await user.click(screen.getByRole('button', { name: 'Clickable' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
