import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
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

  it('renders inline and block LaTeX math via KaTeX', () => {
    const { container } = render(
      <MarkdownPreview source={'Inline $E = mc^2$ and block:\n\n$$\\int_0^1 x\\,dx$$'} />,
    );
    // rehype-katex wraps rendered math in `.katex` — survives the sanitize
    // schema (math markers are preserved) and is no longer raw dollar text.
    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain('$E = mc^2$');
  });

  it('still keeps syntax-highlighting classes on fenced code', () => {
    const { container } = render(
      <MarkdownPreview source={'```js\nconst x = 1;\n```'} />,
    );
    // rehype-highlight runs after sanitize so its hljs classes survive.
    expect(container.querySelector('code.hljs, .hljs')).not.toBeNull();
  });

  it('renders ==highlight== as <mark>', () => {
    const { container } = render(<MarkdownPreview source={'a ==hi there== b'} />);
    const mark = container.querySelector('mark');
    expect(mark?.textContent).toBe('hi there');
    expect(container.innerHTML).not.toContain('==');
  });

  it('renders [[wikilinks]] with alias as styled text, not raw brackets', () => {
    const { container } = render(<MarkdownPreview source={'See [[Some Note|the alias]] now'} />);
    const link = container.querySelector('span.obsidian-wikilink');
    expect(link?.textContent).toBe('the alias');
    expect(container.innerHTML).not.toContain('[[');
    expect(container.textContent).toContain('See the alias now');
  });

  it('carries data-wikilink-target through sanitize and navigates on click', () => {
    const onWikilink = vi.fn();
    const { container } = render(<MarkdownPreview source={'Go to [[Some Note]] here'} onWikilink={onWikilink} />);
    const link = container.querySelector('span.obsidian-wikilink');
    expect(link).not.toBeNull();
    // The inert data attribute survived rehype-sanitize.
    expect(link?.getAttribute('data-wikilink-target')).toBe('Some Note');
    fireEvent.click(link!);
    expect(onWikilink).toHaveBeenCalledWith('Some Note');
  });

  it('renders ![[embeds]] as a labelled placeholder, not raw syntax', () => {
    const { container } = render(<MarkdownPreview source={'![[diagram.png]]'} />);
    expect(container.querySelector('span.obsidian-embed')).not.toBeNull();
    expect(container.innerHTML).not.toContain('![[');
    expect(container.textContent).toContain('diagram.png');
  });

  it('strips %%Obsidian comments%% from the output', () => {
    const { container } = render(<MarkdownPreview source={'before %%hidden note%% after'} />);
    expect(container.textContent).not.toContain('hidden note');
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('after');
    expect(container.innerHTML).not.toContain('%%');
  });

  it('renders a [!type] blockquote as a styled callout, not raw marker text', () => {
    const { container } = render(
      <MarkdownPreview source={'> [!warning] Watch out\n> careful now'} />,
    );
    const callout = container.querySelector('.obsidian-callout.callout-warning');
    expect(callout).not.toBeNull();
    expect(callout?.querySelector('.callout-title')?.textContent).toBe('warning');
    expect(callout?.textContent).toContain('careful now');
    expect(container.innerHTML).not.toContain('[!warning]');
  });

  it('renders YAML frontmatter as a properties table instead of a raw dump', () => {
    const { container } = render(
      <MarkdownPreview source={'---\ntitle: My Note\nstatus: draft\n---\n\n# Body'} />,
    );
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain('title');
    expect(table?.textContent).toContain('My Note');
    expect(container.querySelector('h1')?.textContent).toBe('Body');
    // The raw frontmatter delimiters/key lines must not leak as body text.
    expect(container.innerHTML).not.toContain('title: My Note');
  });
});
