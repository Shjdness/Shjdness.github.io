// Count edits, including A -> B -> A, rather than comparing final field values.
export function createWritingRevision() {
  let revision = 0;
  const fields = new Map<string, number>();
  return {
    track<T>(field: string, set: (value: T) => void) {
      return (value: T) => { revision++; fields.set(field, revision); set(value); };
    },
    checkpoint() {
      const start = revision;
      const before = new Map(fields);
      return (field?: string) => field === undefined ? revision === start : fields.get(field) === before.get(field);
    },
  };
}

// A late cloud response must not invoke setters that also persist local drafts.
export async function loadWritingRecord<T>(
  request: () => Promise<{ data?: T | null; error?: unknown }>,
  isCurrent: () => boolean,
  apply: (data: Exclude<T, string | null | undefined>, unchanged: (field?: string) => boolean) => void,
  onFailure: () => void,
  edits?: { unchanged: (field?: string) => boolean; onChanged: () => void },
) {
  if (!isCurrent()) return;
  try {
    const { data, error } = await request();
    if (!isCurrent()) return;
    if (error || data == null || typeof data === 'string') {
      onFailure();
      return;
    }
    const changed = edits && !edits.unchanged();
    apply(data as Exclude<T, string | null | undefined>, edits?.unchanged ?? (() => true));
    if (changed) edits.onChanged();
  } catch {
    if (isCurrent()) onFailure();
  }
}
