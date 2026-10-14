import type { Plugin } from 'unified';
import type { Content, Root } from 'mdast';

function processNode(child: Content, index: number, siblings: Content[]) {
  if (child.type !== 'code') {
    if ('children' in child) {
      child.children.map(processNode);
    }
    return;
  }
  const { lang, value } = child;
  if (lang !== 'mermaid') return;
  const escaped = value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
  siblings[index] = {
    type: 'html',
    value: `
    <pre class="mermaid_default dark:hidden">${escaped}</pre>
    <pre class="mermaid_dark dark:block hidden">${escaped}</pre>
    `
  }
}

const remarkMermaid: Plugin<[], Root> = () => (root: Root) => {
  root.children.map(processNode)
};

export default remarkMermaid;
