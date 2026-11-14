export async function githubSubject(uid: number, openid: string | undefined): Promise<string | undefined> {
    const githubId = /^([1-9][0-9]*)(?:\.0)?$/.exec(openid ?? '')?.[1];
    if (!githubId || !Number.isSafeInteger(uid) || uid < 1) return;
    const bytes = new TextEncoder().encode(`github-user:v1:${uid}:${githubId}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
