export function rowWithoutDriverMetadata(row) {
  if (!row || typeof row !== "object") {
    return row;
  }
  const { _metadata: _driverMetadata, ...columns } = row;
  return columns;
}
