import type { Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Container, Text, type Component } from '@earendil-works/pi-tui';
import { SYMBOL, row, type Tone } from '@prjct.app/pi-tui-kit';
import { plain } from './output.ts';

type Color = 'toolTitle' | 'muted' | 'dim' | 'success' | 'warning' | 'error';
type Line = Readonly<{ color: Color; value: string }>;
const label = (value: unknown) => typeof value === 'string' ? plain(value).replace(/\s+/g, ' ').trim().slice(0, 96) : '';
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const plural = (total: number, unit: string) => `${total} ${unit}${total === 1 ? '' : 's'}`;

const actions: Readonly<Record<string, string>> = {
  status: 'Status', tools: 'Discover tools', call: 'Call tool', resources: 'List resources',
  templates: 'List templates', read: 'Read resource', prompts: 'List prompts',
  prompt: 'Render prompt', complete: 'Complete argument',
};

function operation(args: unknown): string {
  const input = record(args);
  const action = label(input.action);
  const server = label(input.server);
  const target = action === 'call' ? label(input.tool) : action === 'prompt' ? label(input.prompt) : '';
  return [server, target || actions[action] || action].filter(Boolean).join(' · ') || 'MCP request';
}

/** Stateless rendering keeps theme changes correct and never falls back to raw content. */
function lines(theme: Theme, values: readonly Line[]): Component {
  return {
    render: width => values.flatMap(({ color, value }) => new Text(theme.fg(color, value), 0, 0).render(width)),
    invalidate() {},
  };
}

/** The row every tool call uses: symbol, verb, what it acted on, and the outcome. */
const mcpRow = (theme: Theme, request: string, symbol: string, tone: Tone, meta: string, metaTone?: Tone): Component =>
  row(theme, { symbol, tone, verb: 'MCP', target: request, meta, ...(metaTone ? { metaTone } : {}) });

/** While the call runs its row is the call; once settled the result row replaces it. */
export const renderCall: NonNullable<ToolDefinition['renderCall']> = (args, theme, context) =>
  context?.isPartial === false ? new Container() : mcpRow(theme, operation(args), SYMBOL.active, 'accent', 'working…');

export const renderResult: NonNullable<ToolDefinition['renderResult']> = (result, { expanded, isPartial }, theme, context) => {
  const request = operation(context.args);
  if (isPartial) {
    const progress = record(result.details);
    return typeof progress.progress === 'number'
      ? mcpRow(theme, request, SYMBOL.active, 'accent', `${progress.progress}${typeof progress.total === 'number' ? ` / ${progress.total}` : ''}`)
      : new Container();
  }
  if (context.isError) return mcpRow(theme, request, SYMBOL.error, 'error', 'failed · see the reply', 'error');
  const screened = record(record(result.details).screened);
  if (screened.flagged === true) {
    const p = typeof screened.p === 'number' ? ` ${screened.p.toFixed(2)}` : '';
    return mcpRow(theme, request, SYMBOL.attention, 'warning', `instructions in the result${p} · marked as data`, 'warning');
  }
  const content = result.content.find(block => block.type === 'text');
  const parse = (): unknown => {
    try { return content?.type === 'text' ? JSON.parse(content.text) : undefined; }
    catch { return undefined; }
  };
  const value = parse();
  const data = record(value);
  if (data.status === 'authorization_required') return mcpRow(theme, request, SYMBOL.attention, 'warning', 'sign-in needed · link in the reply', 'warning');
  if (data.status === 'authorization_failed') return mcpRow(theme, request, SYMBOL.attention, 'warning', 'sign-in expired · /mcp', 'warning');

  const action = label(record(context.args).action);
  const items = action === 'tools' && Array.isArray(data.items) ? data.items : Array.isArray(value) ? value : undefined;
  const unit = action === 'tools' ? 'tool' : action === 'status' ? 'server' : action === 'resources' ? 'resource' : action === 'templates' ? 'template' : action === 'prompts' ? 'prompt' : undefined;
  const total = action === 'tools' && typeof data.total === 'number' && Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : items?.length;
  const truncated = record(result.details).truncated === true;
  const suffix = truncated ? ' · agent output truncated' : '';
  const states = action === 'status' && items ? items.map(item => label(record(item).state)).filter(Boolean) : [];
  const stateCount = (state: string) => states.filter(value => value === state).length;
  const statusOrder = ['connected', 'connecting', 'resetting', 'failed', 'idle', 'disconnected', 'disabled'] as const;
  const statusCounts = statusOrder.map(state => ({ state, total: stateCount(state) })).filter(entry => entry.total > 0);
  const knownStates = statusCounts.reduce((sum, entry) => sum + entry.total, 0);
  const failed = stateCount('failed');
  const connected = stateCount('connected');
  const statusSummary = total !== undefined
    ? [plural(total, 'server'), ...statusCounts.map(entry => `${entry.total} ${entry.state}`), ...(total > knownStates ? [`${total - knownStates} unknown`] : [])].join(' · ')
    : undefined;
  const summary = action === 'status' && statusSummary
    ? `${statusSummary}${suffix}`
    : unit && total !== undefined
      ? `${plural(total, unit)}${items && total > items.length ? ` · ${items.length} shown` : ''}${suffix}`
      : `done${suffix}`;
  const symbol = failed ? SYMBOL.error : truncated || (action === 'status' && (!total || connected !== total)) ? SYMBOL.idle : SYMBOL.ok;
  const tone: Tone = failed ? 'error' : truncated ? 'warning' : action === 'status' && (!total || connected !== total) ? 'muted' : 'success';

  // Only bounded names/states are displayed on expansion, never schemas, descriptions,
  // raw arguments, response bodies, callback parameters, or authorization URLs.
  const visible = expanded && unit && items ? items.slice(0, 20).map(item => {
    const entry = record(item);
    const name = label(entry.name);
    const state = action === 'status' ? label(entry.state) : '';
    const era = action === 'status' ? label(entry.era) : '';
    return { name, state, era };
  }).filter(item => item.name) : [];
  const details: Line[] = visible.map((item, index) => {
    const branch = index === visible.length - 1 && (!total || total <= visible.length) ? '└' : '├';
    const state = item.state ? `  ${item.state}${item.era ? ` · ${item.era}` : ''}` : '';
    const color: Color = item.state === 'connected' ? 'success' : item.state === 'failed' ? 'error' : item.state === 'connecting' ? 'warning' : 'muted';
    return { color, value: `  ${branch} ${item.name}${state}` };
  });
  if (expanded && total !== undefined && total > visible.length) details.push({ color: 'dim', value: `  └ … ${total - visible.length} more` });
  const head = mcpRow(theme, request, symbol, tone, summary, truncated ? 'warning' : undefined);
  if (!details.length) return head;
  const container = new Container();
  container.addChild(head);
  container.addChild(lines(theme, details));
  return container;
};
