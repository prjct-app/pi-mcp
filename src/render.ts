import type { Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text, type Component } from '@earendil-works/pi-tui';
import { plain } from './output.ts';

type Color = 'toolTitle' | 'muted' | 'warning' | 'error';
const label = (value: unknown) => typeof value === 'string' ? plain(value).replace(/\s+/g, ' ').trim().slice(0, 96) : '';
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Stateless rendering keeps theme changes correct and never falls back to raw content. */
function text(theme: Theme, color: Color, value: string): Component {
  return {
    render: width => new Text(theme.fg(color, value), 0, 0).render(width),
    invalidate() {},
  };
}

export const renderCall: NonNullable<ToolDefinition['renderCall']> = (args, theme) => {
  const input = record(args);
  const title = ['MCP', label(input.server), label(input.tool) || label(input.action)].filter(Boolean).join(' · ');
  return text(theme, 'toolTitle', title);
};

export const renderResult: NonNullable<ToolDefinition['renderResult']> = (result, { expanded, isPartial }, theme, context) => {
  if (isPartial) return text(theme, 'muted', 'Working…');
  if (context.isError) return text(theme, 'error', 'Request failed; see the agent’s explanation.');
  const content = result.content.find(block => block.type === 'text');
  const parse = (): unknown => {
    try { return content?.type === 'text' ? JSON.parse(content.text) : undefined; }
    catch { return undefined; }
  };
  const value = parse();
  const data = record(value);
  if (data.status === 'authorization_required') return text(theme, 'warning', 'Authorization required · use the link in the agent’s reply.');
  if (data.status === 'authorization_failed') return text(theme, 'warning', 'Authorization expired or rejected · request a fresh link.');

  const action = record(context.args).action;
  const items = action === 'tools' && Array.isArray(data.items) ? data.items : Array.isArray(value) ? value : undefined;
  const unit = action === 'tools' ? 'tool' : action === 'status' ? 'server' : action === 'resources' ? 'resource' : action === 'templates' ? 'template' : action === 'prompts' ? 'prompt' : undefined;
  const total = action === 'tools' && typeof data.total === 'number' && Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : items?.length;
  const summary = unit && total !== undefined
    ? `${total} ${unit}${total === 1 ? '' : 's'} found${items && total > items.length ? ` · ${items.length} shown` : ''}`
    : 'Result received';
  // Only bounded names/states are displayed on expansion, never schemas, descriptions,
  // raw arguments, response bodies, callback parameters, or authorization URLs.
  const names = expanded && unit && items ? items.slice(0, 20).map(item => {
    const entry = record(item);
    const name = label(entry.name);
    const state = action === 'status' ? label(entry.state) : '';
    return name ? `  ${name}${state ? `: ${state}` : ''}` : '';
  }).filter(Boolean) : [];
  const suffix = record(result.details).truncated === true ? ' · agent output truncated' : '';
  return text(theme, 'muted', [summary + suffix, ...names].join('\n'));
};
