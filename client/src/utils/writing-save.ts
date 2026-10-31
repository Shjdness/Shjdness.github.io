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
