import { expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { markdownSchema } from './markdown-schema';

it('drops active HTML while keeping Mermaid presentation classes', () => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, markdownSchema);
  const tree = processor.runSync(processor.parse(
    '<iframe src="https://example.invalid"></iframe><img src="x" onerror="alert(1)"><pre class="mermaid_default dark:hidden">graph TD</pre>'
  ));
  const output = JSON.stringify(tree);
  expect(output).not.toContain('iframe');
  expect(output).not.toContain('onerror');
  expect(output).toContain('mermaid_default');
});

it('preserves mathematical notation after sanitization', () => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, markdownSchema)
    .use(rehypeKatex);
  const tree = processor.runSync(processor.parse('$x^2$'));
  expect(JSON.stringify(tree)).toContain('katex');
});
