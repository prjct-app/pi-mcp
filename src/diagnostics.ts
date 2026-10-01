export class McpFailure extends Error {
  constructor(readonly category: 'transport' | 'arguments' | 'configuration', message: string) { super(message); }
}

function field(error: unknown, key: string): unknown {
  return error && typeof error === 'object' && key in error ? Reflect.get(error, key) : undefined;
}

/** Never print raw remote bodies, arbitrary error messages, endpoints or credentials. */
export function safeDiagnostic(error: unknown): string {
  if (error instanceof McpFailure) return error.message;
  const code = field(error, 'code');
  const name = field(error, 'name');
  const status = field(error, 'status');
  const message = error instanceof Error ? error.message : '';
  const reason = name === 'AbortError' || /closed|cancelled|aborted/i.test(message) ? 'MCP operation cancelled or session closed.'
    : /timeout|timed out/i.test(message) ? 'MCP request timed out. Increase requestTimeoutMs if this operation needs longer.'
    : code === 'ERA_NEGOTIATION_FAILED' || code === -32022 ? 'MCP protocol negotiation failed. Check protocol mode and supported server version.'
    : code === 'HTTP_AUTH_REQUIRED' || code === 'HTTP_ACCESS_DENIED' ? 'MCP authentication failed or access was denied. Use /mcp auth <server> or check bearer environment variables.'
    : code === 'ENOENT' ? 'MCP executable or working directory was not found. Check command, args and cwd.'
    : code === 'EACCES' ? 'MCP process could not start: permission denied. Check executable permissions and cwd.'
    : typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? `MCP HTTP request failed (${status}). Check server availability and authentication.`
    : typeof code === 'number' && Number.isFinite(code) ? `MCP protocol request failed (${code}). Check the discovered schema and server logs.`
    : 'MCP operation failed. Check configuration/authentication.';
  return `${reason} No operation was automatically replayed by pi-mcp; /mcp reconnect <server> resets a failed connection.`;
}

/** Classify the bounded stderr tail without revealing the child process's arbitrary payload. */
export function stderrReason(text: string): string | undefined {
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(text)) return 'The stdio server could not load a module. Check its command, args and installed dependencies.';
  if (/SyntaxError/.test(text)) return 'The stdio server reported a syntax error. Check the server program.';
  if (/ENOENT/.test(text)) return 'The stdio server reported a missing file or executable. Check command, args and cwd.';
  if (/EACCES|Permission denied/.test(text)) return 'The stdio server reported permission denied. Check executable permissions and cwd.';
  return undefined;
}
