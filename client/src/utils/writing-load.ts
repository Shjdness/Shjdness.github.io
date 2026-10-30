// A late cloud response must not invoke setters that also persist local drafts.
export async function loadWritingRecord<T>(
  request: () => Promise<{ data?: T | null; error?: unknown }>,
  isCurrent: () => boolean,
  apply: (data: Exclude<T, string | null | undefined>) => void,
  onFailure: () => void,
) {
  if (!isCurrent()) return;
  try {
    const { data, error } = await request();
    if (!isCurrent()) return;
    if (error || data == null || typeof data === 'string') {
      onFailure();
      return;
    }
    apply(data as Exclude<T, string | null | undefined>);
  } catch {
    if (isCurrent()) onFailure();
  }
}
