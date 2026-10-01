import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { z } from 'zod';
import { ServerSchema, type ServerConfig } from './schema.ts';
export type { ServerConfig } from './schema.ts';


export function safeUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error('URLs must not include userinfo or fragments');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('HTTPS is required except for loopback endpoints');
  }
  return url;
}

function interpolate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) throw new Error(`Missing environment variable: ${name}`);
    return resolved;
  });
}

export function parseServers(raw: unknown, baseDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, ServerConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mcpServers must be an object');
  const entries = Object.entries(raw);
  if (entries.length > 64) throw new Error('At most 64 MCP servers are supported');
  return Object.fromEntries(entries.map(([name, value]) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Invalid MCP server name');
    const parsed = ServerSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid configuration for MCP server ${name}: check supported fields and types`);
    const server: ServerConfig = parsed.data;
    if (server.disabled) return [name, server];
    if (Boolean(server.command) === Boolean(server.url)) throw new Error(`MCP server ${name} needs exactly one command or URL`);
    if (server.command && (server.auth || server.oauth || server.headers || server.bearerTokenEnv)) throw new Error(`HTTP options are not valid for stdio server ${name}`);
    if (server.url && (server.args || server.env || server.cwd)) throw new Error(`Stdio options are not valid for HTTP server ${name}`);
    if ((server.oauth && server.auth !== 'oauth') || (server.bearerTokenEnv && server.auth !== 'bearer')) throw new Error(`Authentication mode mismatch for ${name}`);
    if (server.auth === 'bearer' && !server.bearerTokenEnv) throw new Error(`MCP server ${name} needs bearerTokenEnv`);
    if (server.url) server.url = safeUrl(interpolate(server.url, env)).href;
    if (server.command) server.command = interpolate(server.command, env);
    if (server.args) server.args = server.args.map(value => interpolate(value, env));
    for (const field of ['headers', 'env'] as const) {
      if (server[field]) server[field] = Object.fromEntries(Object.entries(server[field]!).map(([key, value]) => {
        if (value.startsWith('!')) throw new Error(`Command-based secrets are not supported for ${name}`);
        return [key, interpolate(value, env)];
      }));
    }
    if (server.auth && Object.keys(server.headers ?? {}).some(key => key.toLowerCase() === 'authorization')) throw new Error(`Choose one authorization source for ${name}`);
    const machineAuth = server.oauth?.grantType === 'client_credentials';
    if (machineAuth && (!server.oauth?.clientId || !server.oauth.clientSecretEnv || !server.oauth.issuer)) throw new Error(`Machine OAuth for ${name} requires clientId, clientSecretEnv, and exact issuer`);
    if (machineAuth && (server.oauth?.clientMetadataUrl || server.oauth?.redirectUri)) throw new Error(`Machine OAuth for ${name} cannot use interactive client metadata or redirect URIs`);
    if (!machineAuth && server.oauth?.clientSecretEnv) throw new Error(`clientSecretEnv requires client_credentials for ${name}`);
    if (server.oauth?.clientId && !server.oauth.issuer) throw new Error(`Pre-registered OAuth client for ${name} requires its exact issuer`);
    if (server.oauth?.issuer && safeUrl(server.oauth.issuer).protocol !== 'https:') throw new Error('OAuth issuer requires HTTPS');
    if (server.oauth?.redirectUri) {
      const redirect = safeUrl(server.oauth.redirectUri);
      if (redirect.search) throw new Error(`OAuth callback must not contain query parameters for ${name}`);
    }
    if (server.oauth?.clientMetadataUrl && safeUrl(server.oauth.clientMetadataUrl).protocol !== 'https:') throw new Error('Client metadata document requires HTTPS');
    server.cwd = server.command ? resolve(baseDir, (server.cwd ?? '.').replace(/^~(?=\/|$)/, homedir())) : undefined;
    return [name, server];
  }));
}

export type ConfigOptions = {
  cwd: string; agentDir: string; configDirName: string; trusted: boolean; sharedConfigPath?: string;
};
export type Configuration = Readonly<{ servers: Record<string, ServerConfig>; sources: Record<string, string> }>;

export async function loadConfig(options: ConfigOptions): Promise<Record<string, ServerConfig>> {
  return (await loadConfiguration(options)).servers;
}

export async function loadConfiguration(options: ConfigOptions): Promise<Configuration> {
  const paths = [options.sharedConfigPath ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'mcp', 'mcp.json'), join(options.agentDir, 'mcp.json')];
  if (options.trusted) paths.push(join(options.cwd, '.mcp.json'), join(options.cwd, options.configDirName, 'mcp.json'));
  const result = await paths.reduce(async (previous, path) => {
    const servers = await previous;
    const raw = await readDocument(path);
    if (raw === undefined) return servers;
    const document = z.object({ mcpServers: z.record(z.string(), z.unknown()).default({}), imports: z.array(z.unknown()).max(0).optional() }).passthrough().safeParse(raw);
    if (!document.success) throw new Error('Invalid MCP configuration; host imports are not supported');
    const parsed = parseServers(document.data.mcpServers, dirname(path));
    return {
      servers: { ...servers.servers, ...parsed },
      sources: { ...servers.sources, ...Object.fromEntries(Object.keys(parsed).map(name => [name, path])) },
    };
  }, Promise.resolve<Configuration>({ servers: {}, sources: {} }));
  if (Object.keys(result.servers).length > 64) throw new Error('At most 64 MCP servers are supported');
  return result;
}

async function readDocument(path: string): Promise<unknown> {
  try {
    if ((await stat(path)).size > 1024 * 1024) throw new Error('MCP configuration exceeds 1 MiB');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error('Invalid JSON in MCP configuration');
    throw error;
  }
}
