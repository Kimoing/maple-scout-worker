import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const worker = workerModule.default;
const env = {
  DB: {},
  APP_ORIGINS: 'https://app.example.test,http://localhost:3000',
};

test('health endpoint is public', async () => {
  const response = await worker.fetch(new Request('https://worker.example.test/api/health'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('rejects an unlisted browser origin before authentication', async () => {
  const response = await worker.fetch(new Request('https://worker.example.test/api/groups', {
    headers: { Origin: 'https://attacker.example.test' },
  }), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: '허용되지 않은 웹 출처입니다.' });
});

test('requires a Google access token for protected routes', async () => {
  const response = await worker.fetch(new Request('https://worker.example.test/api/groups'), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Google 로그인이 필요합니다.' });
});

test('rejects expired or invalid Google access tokens', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/groups', {
      headers: { Authorization: 'Bearer invalid-token' },
    }), env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Google 로그인 토큰이 만료되었거나 올바르지 않습니다.' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('blocks an authenticated non-member from a group', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  globalThis.fetch = async () => new Response(JSON.stringify({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  env.DB.prepare = () => ({ bind: () => ({ first: async () => null }) });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/groups/unknown/bosses', {
      headers: { Authorization: 'Bearer valid-token' },
    }), env);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: '그룹이 없거나 그룹 구성원이 아닙니다.' });
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('accepts only a nickname for a multiplier refresh request', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  globalThis.fetch = async () => new Response(JSON.stringify({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  env.DB.prepare = (query) => ({
    bind: () => ({
      first: async () => query.includes('FROM groups') ? {
        id: 'group-1',
        name: 'Test group',
        created_by_sub: 'google-subject',
        created_by_email: 'member@example.test',
        role: 'admin',
      } : null,
    }),
  });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1/multipliers', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: '오잉느', multipliers: [{ bossId: 'hard_kaling', multiplier: 30.67 }] }),
    }), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'nickname만 요청할 수 있습니다.' });
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});

test('adds a group boss to D1', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const statements = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  env.DB.prepare = (query) => ({
    bind: (...values) => {
      statements.push({ query, values });
      return {
        first: async () => ({
          id: 'group-1',
          name: 'Test group',
          created_by_sub: 'google-subject',
          created_by_email: 'member@example.test',
          role: 'admin',
        }),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      };
    },
  });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/groups/group-1/bosses', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ bossId: 'normal_kaling' }),
    }), env);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { bossId: 'normal_kaling', added: true });
    assert.equal(statements.some(({ query }) => query.includes('INSERT INTO bosses')), true);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});