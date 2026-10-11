/** Shown in the delete confirmation: up to three names, then a count of the rest. */
export function deleteConfirmMessage(filenames: string[], shown = 3): string {
  const names = filenames.slice(0, shown).join("、");
  const rest = filenames.length - shown;
  return rest > 0 ? `${names} ほか${rest}枚を削除しますか？` : `${names} を削除しますか？`;
}

/** Shift-click: every ID between the anchor and the target in the current display order. */
export function selectionRange(orderedIds: string[], anchor: string, target: string): string[] {
  const from = orderedIds.indexOf(anchor);
  const to = orderedIds.indexOf(target);
  if (from < 0 || to < 0) return [target];
  return orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1);
}
