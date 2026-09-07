// Natywny sterownik dokłada do wyniku .get() własne, wyliczane co wywołanie pole
// _metadata. Kolumny mają być porównywane dokładnie, więc zdejmujemy tylko je.
export function rowWithoutDriverMetadata(row) {
  if (!row || typeof row !== "object") {
    return row;
  }
  const { _metadata: _driverMetadata, ...columns } = row;
  return columns;
}
