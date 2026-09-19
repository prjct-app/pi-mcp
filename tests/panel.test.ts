import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { createPanel } from '@prjct.app/pi-tui-kit';
import { serverPanel, type Action, type Outcome, type ServerInfo } from '../src/manage.ts';

const theme: any = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const servers: ServerInfo[] = [
    { name: 'linear', state: 'idle', endpoint: 'https://mcp.linear.app', auth: 'oauth', credential: 'authorized' },
    { name: 'github', state: 'idle', endpoint: 'https://api.githubcopilot.com', auth: 'bearer', env: 'GITHUB_TOKEN', credential: 'env_missing' },
  ];
  const performed: string[] = [];
  const notified: Outcome[] = [];
  const control = {
    describe: async () => servers.map(server => ({ ...server })),
    perform: async (name: string, action: Action): Promise<Outcome> => {
      performed.push(`${action} ${name}`);
      const server = servers.find(entry => entry.name === name)!;
      if (action === 'connect') { Object.assign(server, { state: 'connected' }); return { message: `${name} connected · 2 tools advertised.`, level: 'info', tools: ['create_issue', 'search'] }; }
      if (action === 'logout') { Object.assign(server, { credential: 'signed_out' }); return { message: `Signed out of ${name}.`, level: 'info' }; }
      if (action === 'auth') return { message: `Click to authorize ${name}: https://auth.example/x`, level: 'info', leave: true };
      return { message: 'ok', level: 'info' };
    },
  };
  const spec = serverPanel(control, servers.map(server => ({ ...server })), outcome => notified.push(outcome));
  const panel = createPanel(spec, { terminal: { columns: 120, rows: 30 }, requestRender() {} } as any, theme, () => undefined);
  const screen = () => panel.render(120).map(line => stripVTControlCharacters(line)).join('\n');
  const press = async (...keys: string[]) => { for (const key of keys) { panel.handleInput!(key); await tick(); await tick(); } };
  return { panel, screen, press, performed, notified };
}

test('the MCP panel lists servers with a credential fact and shows the selected one in detail', () => {
  const h = fixture();
  const text = h.screen();
  assert.match(text, /MCP {2}2 servers · 0 connected · 1 with credentials/);
  assert.match(text, /› ○ linear\s+oauth ✓ │ linear/);
  assert.match(text, /○ github\s+key ✕/);
  assert.match(text, /auth\s+oauth: signed in/);
  assert.match(text, /endpoint\s+https:\/\/mcp\.linear\.app/);
  assert.match(text, /c Connect · d Disconnect · a Re-authenticate · x Sign out/);
});

test('connecting records the tools and the history beside the server', async () => {
  const h = fixture();
  await h.press('c');
  const text = h.screen();
  assert.deepEqual(h.performed, ['connect linear']);
  assert.match(text, /● linear/);
  assert.match(text, /Tools \(2\)/);
  assert.match(text, /create_issue/);
  assert.match(text, /History[\s\S]*now {2}linear connected/);
  assert.match(text, /t List tools · r Reconnect · d Disconnect/);
});

test('sign-out asks again, and an authorization link also lands in the transcript', async () => {
  const h = fixture();
  await h.press('x');
  assert.deepEqual(h.performed, []);
  assert.match(h.screen(), /Press x again to sign out linear/);
  await h.press('x');
  assert.deepEqual(h.performed, ['logout linear']);
  await h.press('a');
  assert.equal(h.notified.length, 1);
  assert.match(h.notified[0]!.message, /https:\/\/auth\.example/);
});
