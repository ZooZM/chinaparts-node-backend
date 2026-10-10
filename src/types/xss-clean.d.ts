// `xss-clean` ships no types. Only its pure `clean` function is used: its Express middleware
// assigns `req.query`, which is read-only in Express 5 (see common/security/sanitize.middleware.ts).
declare module 'xss-clean/lib/xss' {
  export function clean<T>(data: T): T;
}
