import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import MarkdownPreview from './MarkdownPreview';

describe('MarkdownPreview', () => {
  it('renders basic markdown content as HTML', () => {
    const { container } = render(<MarkdownPreview source={'# Hello\n\n**world**'} />);
    expect(container.querySelector('h1')?.textContent).toBe('Hello');
    expect(container.querySelector('strong')?.textContent).toBe('world');
  });

  it('sanitizes <script> tags from markdown source (XSS)', () => {
    const malicious = 'Safe text\n\n<script>alert(1)</script>\n\nMore text';
    const { container } = render(<MarkdownPreview source={malicious} />);
    // rehype-sanitize must strip <script> entirely — it must never make it into the DOM.
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('<script');
    expect(container.innerHTML).not.toContain('alert(1)');
  });

  it('strips dangerous event handlers like onerror from <img> tags (XSS)', () => {
    const malicious = '<img src="x" onerror="alert(1)" />';
    const { container } = render(<MarkdownPreview source={malicious} />);
    // Image may or may not survive sanitization depending on schema,
    // but the onerror handler and alert payload must be gone.
    expect(container.innerHTML).not.toContain('onerror');
    expect(container.innerHTML).not.toContain('alert(1)');
    const img = container.querySelector('img');
    if (img) {
      expect(img.getAttribute('onerror')).toBeNull();
    }
  });

  it('strips javascript: URLs from links (XSS)', () => {
    const malicious = '[click me](javascript:alert(1))';
    const { container } = render(<MarkdownPreview source={malicious} />);
    const anchor = container.querySelector('a');
    if (anchor) {
      const href = anchor.getAttribute('href') ?? '';
      expect(href.toLowerCase()).not.toContain('javascript:');
    }
    expect(container.innerHTML).not.toContain('alert(1)');
  });
});
