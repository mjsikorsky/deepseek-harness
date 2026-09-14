/** Built-package Loader proof for the deployment publication provider. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const probe = String.raw`
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = path => import(pathToFileURL(resolve(path)).href);
const { Context } = await load('vendor/cordis/lib/index.js');
const { default: Loader } = await load('vendor/loader/lib/index.js');
const { default: Include } = await load('vendor/include/lib/index.js');
const modules = new Map();
for (const [name, path] of [
  ['llm', 'packages/llm/llm'],
  ['session', 'packages/core/session'],
  ['session-projection', 'packages/session/session-projection'],
  ['system-prompt', 'packages/core/system-prompt'],
  ['tools', 'packages/core/tools'],
  ['agent', 'packages/core/agent'],
  ['session-persistence-jsonl', 'packages/session/session-persistence-jsonl'],
  ['agent-loop', 'packages/core/agent-loop'],
]) modules.set('@deepseek-ai/dsh-' + name, (await load(path + '/lib/index.js')).default);
const temp = await mkdtemp(join(tmpdir(), 'native-loader-built-'));
const ctx = new Context();
let allowed = false;
const order = [];
modules.set('qualification:authority', {
  name: 'qualification-authority',
  inject: ['agents'],
  apply(owner) {
    owner.provide('agentLifecycleSetup', {
      prepare(_scope, agent) {
        assert.equal(owner.agents.get(agent.id), undefined);
        order.push('prepare');
        return { commit() {
          if (!allowed) throw new Error('publication denied');
          order.push('commit');
        }};
      },
    });
  },
});
try {
  ctx.baseUrl = pathToFileURL(temp).href + '/';
  await ctx.plugin(Loader);
  ctx.loader.builtins.include = Include;
  ctx.loader.internal = { version: 'v2', async import(name) {
    assert.ok(modules.has(name), 'unexpected Loader import: ' + name);
    return modules.get(name);
  }};
  const rows = [...modules.keys()].map(name => ({ name,
    ...(name.endsWith('session-persistence-jsonl') ? { config: { root: join(temp, 'sessions'), compression: 'none' }} : {}),
    ...(name.endsWith('agent-loop') ? { config: { agents: [] }} : {}),
  }));
  const path = join(temp, 'cordis.yml');
  await writeFile(path, rows.map(row => '- ' + JSON.stringify(row)).join('\n'));
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href }});
  await ctx.loader.await();
  assert.deepEqual([...ctx.loader.entries()].filter(row => !row.disabled && !row.fiber), []);
  ctx.on('agent/created', () => order.push('published'));
  await assert.rejects(ctx.agents.create({ sessionId: 'denied-built' }), /publication denied/);
  assert.deepEqual(ctx.agents.list(), []);
  assert.deepEqual(order, ['prepare']);
  allowed = true;
  const handle = await ctx.agents.create({ sessionId: 'allowed-built' });
  assert.deepEqual(order, ['prepare', 'prepare', 'commit', 'published']);
  assert.equal(ctx.agents.get(handle.agent.id), handle.agent);
  await handle.dispose();
  console.log('built-loader-publication: passed');
} finally {
  await ctx.fiber.dispose();
  await rm(temp, { recursive: true, force: true });
}
`

it('installs the publication provider through Loader using native built packages', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: root,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
  })
  expect(stdout).toContain('built-loader-publication: passed')
}, 40_000)
