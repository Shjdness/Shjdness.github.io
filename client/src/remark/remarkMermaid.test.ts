import { expect, it } from 'vitest';
import type { Root } from 'mdast';
import remarkMermaid from './remarkMermaid';

it('keeps Mermaid code from closing its generated HTML container', () => {
  const root: Root = {
    type: 'root',
    children: [{ type: 'code', lang: 'mermaid', value: '</pre><img src=x onerror=alert(1)>' }],
  };
  (remarkMermaid as () => (root: Root) => void)()(root);
  const html = root.children[0];
  expect(html.type).toBe('html');
  if (html.type === 'html') {
    expect(html.value).not.toContain('<img');
    expect(html.value).toContain('&lt;img');
  }
});
