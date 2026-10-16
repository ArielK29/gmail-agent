// Where the Google consent returns to (issue 32): the web page (default) or the mobile app's deep link.
// The deep link itself is the server's setting APP_DEEP_LINK; the request only chooses between the two.
export type TargetResult = { ok: true; target: 'web' | 'app' } | { ok: false; error: 'bad_target' | 'app_link_not_configured' };

export function parseTarget(body: unknown, appLinkConfigured: boolean): TargetResult {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('target' in body)) return { ok: true, target: 'web' };
  const target = (body as { target?: unknown }).target;
  if (target === 'web') return { ok: true, target: 'web' };
  if (target === 'app') return appLinkConfigured ? { ok: true, target: 'app' } : { ok: false, error: 'app_link_not_configured' };
  return { ok: false, error: 'bad_target' };
}