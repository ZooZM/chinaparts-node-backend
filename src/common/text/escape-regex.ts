/** Escapes a user-supplied string for use inside a MongoDB `$regex`, so `.` and `(` match literally. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
