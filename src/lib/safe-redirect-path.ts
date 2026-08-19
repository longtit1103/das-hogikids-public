/**
 * Guards a post-login `redirect` query-param value before it is ever passed
 * to `router.push` / `redirect()`. A naive `path.startsWith("/")` check lets
 * protocol-relative (`//evil.com`) and backslash (`/\evil.com`) values
 * through — browsers resolve both as an off-origin absolute URL, turning a
 * successful login into an open redirect to an attacker page. Safe only when
 * the path starts with a single `/` and is not one of those two escapes.
 */
export function isSafeRedirectPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}
