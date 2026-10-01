export function remapRemovedLessons(
  oldOrder: readonly string[],
  newOrder: readonly string[],
): Map<string, string> {
  if (newOrder.length === 0) return new Map();

  const retained = new Set(newOrder);
  const fallback = newOrder.at(-1)!;
  const remap = new Map<string, string>();

  oldOrder.forEach((contentId, index) => {
    if (retained.has(contentId) || remap.has(contentId)) return;
    const nextRetained = oldOrder
      .slice(index + 1)
      .find((candidate) => retained.has(candidate));
    remap.set(contentId, nextRetained ?? fallback);
  });

  return remap;
}
