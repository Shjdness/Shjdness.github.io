import { defaultSchema, type Options } from 'rehype-sanitize';

export const markdownSchema: Options = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    pre: [['className', 'mermaid_default', 'mermaid_dark', 'dark:hidden', 'dark:block', 'hidden']],
  },
};
