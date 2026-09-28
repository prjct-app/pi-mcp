import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { Box, Text, hyperlink } from '@earendil-works/pi-tui';
import { plain } from './output.ts';

export const AUTH_LINK_TYPE = 'mcp-auth-link';

export function authorizationUrl(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as { status?: unknown; authorizationUrl?: unknown };
  return record.status === 'authorization_required' && typeof record.authorizationUrl === 'string' ? record.authorizationUrl : undefined;
}

/** One conversation entry per URL. Notifications are not clickable; this message is. */
export function publishAuthorizationLink(pi: ExtensionAPI, name: string, value: unknown, published: Set<string>): void {
  const url = authorizationUrl(value);
  if (!url || published.has(url)) return;
  published.add(url);
  pi.sendMessage({
    customType: AUTH_LINK_TYPE,
    content: `Authorize ${plain(name)}: ${url}`,
    display: true,
    details: { server: plain(name), authorizationUrl: url },
  }, { triggerTurn: false });
}

export function renderAuthorizationLink(message: { content: string | unknown; details?: unknown }, _options: unknown, theme: Theme) {
  const details = message.details !== null && typeof message.details === 'object' ? message.details as { authorizationUrl?: unknown; server?: unknown } : {};
  const url = typeof details.authorizationUrl === 'string' ? details.authorizationUrl : typeof message.content === 'string' ? message.content : '';
  const server = typeof details.server === 'string' ? details.server : 'MCP';
  const box = new Box(1, 1, text => theme.bg('customMessageBg', text));
  box.addChild(new Text(theme.fg('accent', `Authorize ${plain(server)}`), 0, 0));
  box.addChild(new Text(hyperlink(theme.underline(url), url), 0, 0));
  return box;
}
