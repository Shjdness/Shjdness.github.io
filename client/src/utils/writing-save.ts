export async function confirmWritingDraftDeletion({ isCurrent, unchanged, remove, onEdited, afterDeleted }: {
  isCurrent: () => boolean;
  unchanged: () => boolean;
  remove: () => Promise<void>;
  onEdited: () => void;
  afterDeleted: () => void;
}) {
  if (!isCurrent()) return;
  if (!unchanged()) { onEdited(); return; }
  await remove();
  if (isCurrent()) afterDeleted();
}

// Call only after a confirmed server success, immediately before leaving.
export function completeWritingSave({ isCurrent, unchanged, clear, leave, onEdited }: {
  isCurrent: () => boolean;
  unchanged: () => boolean;
  clear: () => void;
  leave: () => void;
  onEdited: () => void;
}) {
  if (!isCurrent()) return;
  if (!unchanged()) { onEdited(); return; }
  clear();
  leave();
}
