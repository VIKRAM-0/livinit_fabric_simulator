// Viewpoint resolution order, most specific first (spec: viewpoints section):
//   tenant lock (backend, per-tenant) → global S3 lock ("Livinit default",
//   legacy api/viewpoints.ts) → PRODUCT_VIEWPOINTS shipped default → none.
export function resolveViewpoint(key, tenantLocks, s3Locks, defaults) {
  return tenantLocks[key] || s3Locks[key] || defaults[key] || null;
}

export function lockSource(key, tenantLocks, s3Locks, defaults) {
  if (tenantLocks[key]) return 'tenant';
  if (s3Locks[key]) return 'published';
  if (defaults[key]) return 'default';
  return 'none';
}
