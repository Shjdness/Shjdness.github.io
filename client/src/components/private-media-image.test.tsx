import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import type { Element, Root, RootContent } from 'hast';
import { Markdown } from './markdown';
import { markdownSchema } from './markdown-schema';
import { isPrivateMediaPreview, markPrivateMediaPreviews, privateMediaIdFromImage } from './private-media-image';

vi.mock('../main', () => ({ endpoint: 'https://api.invalid' }));
vi.mock('../utils/darkModeUtils', () => ({ useColorMode: () => 'dark' }));
vi.mock('react-syntax-highlighter', () => ({ Prism: () => null }));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ base16AteliersulphurpoolLight: {}, vscDarkPlus: {} }));
vi.mock('yet-another-react-lightbox', () => ({ default: () => null }));

const id = '784f0bfa-6d25-4a21-9f5c-f410fdb7822a';
const src = `private-media:${id}`;

function findImage(node: Root | RootContent): Element | undefined {
  if (node.type === 'element' && node.tagName === 'img') return node;
  if ('children' in node) {
    for (const child of node.children) {
      const result = findImage(child);
      if (result) return result;
    }
  }
}

const processor = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw).use(rehypeSanitize, markdownSchema);
const imageNode = (markdown: string) => findImage(processor.runSync(processor.parse(markdown)) as Root);

it('resolves only literal bounded inline Markdown refs after sanitizer strips their src', () => {
  for (const alt of ['', '私密图片', '中'.repeat(240)]) {
    const markdown = `A\n\n> ![${alt}](${src})\n\nB`;
    const node = imageNode(markdown);
    expect(node?.properties.src).toBeUndefined();
    expect(privateMediaIdFromImage(markdown, node?.position)).toBe(id);
  }
  for (const markdown of [
    `![${'a'.repeat(241)}](${src})`,
    `![nested [alt]](${src})`,
    `![newline\nalt](${src})`,
    `![alt](<${src}>)`,
    `![alt](${src} "title")`,
    `![alt][ref]\n\n[ref]: ${src}`,
    `<img alt="raw" src="${src}">`,
    `\`![alt](${src})\``,
    `![alt](blob:https://site.invalid/${id})`,
    `![alt](${src.toUpperCase()})`,
  ]) {
    expect(privateMediaIdFromImage(markdown, imageNode(markdown)?.position), markdown).toBeNull();
  }
});

it('leaves private and blob sources out of HTML and preserves public image lightbox input', () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, { content: [
    `![private](${src})`,
    `![injected](blob:https://site.invalid/${id})`,
    '![public](https://assets.invalid/public.png)',
  ].join('\n\n') }));
  expect(html).not.toContain(src);
  expect(html).not.toContain('blob:');
  expect(html.match(/<img\b/g)).toHaveLength(1);
  expect(html).toContain('https://assets.invalid/public.png');
  expect(html).toContain('data-markdown-public-image');
});

it('counts rendered attachments once each, ignoring code, raw HTML, and duplicate references', () => {
  const ref = `![alt](${src})`;
  const others = Array.from({ length: 20 }, (_, index) => `![next](private-media:${id.slice(0, -2)}${index.toString(16).padStart(2, '0')})`);
  const markdown = ['~~~md', ...Array(25).fill(ref), '~~~', '', `<img src="${src}">`, '', ...Array(24).fill(ref), ...others].join('\n');
  const pipeline = processor().use(markPrivateMediaPreviews(markdown));
  const tree = pipeline.runSync(pipeline.parse(markdown));
  const renders = [...tree.children].flatMap(node => node.type === 'element' && node.tagName === 'p'
    ? node.children.filter((child): child is Element => child.type === 'element' && child.tagName === 'img') : []);
  expect(renders.filter(isPrivateMediaPreview)).toHaveLength(20);
  expect(renders.filter(isPrivateMediaPreview)[0]?.properties.alt).toBe('alt');
  expect(isPrivateMediaPreview(renders[renders.length - 1])).toBe(false);
});
