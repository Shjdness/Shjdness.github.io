import type { R2Bucket } from '@cloudflare/workers-types';

const idPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const privateMediaId = new RegExp(`^${idPattern}$`);
export const privateMediaKey = (subject: string, id: string) => `github-v1/${subject}/${id}`;

function* privateMediaReferences(content: string) {
    // Match the editor's literal inline syntax. Bound each candidate and
    // exclude nested openers so malformed Markdown stays cheap to scan.
    const pattern = new RegExp(`!\\[[^\\[\\]\\r\\n]{0,240}\\]\\(private-media:(${idPattern})\\)`, 'g');
    for (const match of content.matchAll(pattern)) yield match[1];
}

export function feedReferencesPrivateMedia(content: string, target: string) {
    for (const id of privateMediaReferences(content)) if (id === target) return true;
    return false;
}

export async function privateMediaReferencesAvailable(content: string, subject: string | undefined, bucket?: R2Bucket) {
    const ids = new Set<string>();
    for (const id of privateMediaReferences(content)) {
        ids.add(id);
        if (ids.size > 20) return false;
    }
    if (!ids.size) return true;
    if (!bucket || !subject) return false;
    const metadata = await Promise.all([...ids].map(id => bucket.head(privateMediaKey(subject, id))));
    return metadata.every(object => object !== null);
}
