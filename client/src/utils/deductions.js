export function deductionId(item) {
  const rawId = item?.id == null ? '' : String(item.id).trim();
  if (rawId) return rawId.slice(0, 120);
  const name = String(item?.name == null ? '' : item.name).trim().slice(0, 80);
  const kind = String(item?.kind || '');
  const value = Number(item?.value);
  if (!name || !['percent', 'fixed'].includes(kind) || !Number.isFinite(value) || value < 0) return '';
  return `legacy:${name}:${kind}:${kind === 'percent' ? Math.min(value, 100) : value}`;
}
