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

test('rejects an invalid Nexon API key before database writes', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  const requestedPaths = [];
  let databaseWrites = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'openidconnect.googleapis.com') {
      return new Response(JSON.stringify({
        sub: 'google-subject',
        email: 'member@example.test',
        email_verified: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    requestedPaths.push(url.pathname);
    return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 403 });
  };
  env.DB.prepare = () => {
    databaseWrites += 1;
    throw new Error('Unexpected database access');
  };
  env.DB.batch = async () => {
    databaseWrites += 1;
    throw new Error('Unexpected database access');
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/characters/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'invalid-key' }),
    }), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Nexon 캐릭터 목록 조회 실패: Invalid API key' });
    assert.deepEqual(requestedPaths, ['/maplestory/v1/character/list']);
    assert.equal(databaseWrites, 0);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    env.DB.batch = originalBatch;
  }
});

test('associates every character from the Nexon API key with the Google account', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  const requestedPaths = [];
  let insertedStatements;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'openidconnect.googleapis.com') {
      return new Response(JSON.stringify({
        sub: 'google-subject',
        email: 'member@example.test',
        email_verified: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    requestedPaths.push(url.pathname);
    assert.equal(new Headers(options.headers).get('x-nxopen-api-key'), 'nexon-key');
    if (url.pathname.endsWith('/character/list')) {
      return new Response(JSON.stringify({
        account_list: [
          { account_id: 'account-1', character_list: [{ ocid: 'ocid-1', character_name: 'first-character' }] },
          { account_id: 'account-2', character_list: [{ character_name: 'second-character' }] },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/id')) {
      const nickname = url.searchParams.get('character_name');
      assert.ok(['first-character', 'second-character'].includes(nickname));
      return Response.json({ ocid: `resolved-${nickname}` });
    }
    if (url.pathname.endsWith('/character/basic')) {
      assert.equal(url.searchParams.has('date'), false);
      assert.ok(['resolved-first-character', 'resolved-second-character'].includes(url.searchParams.get('ocid')));
      return Response.json({
        world_name: 'Scania',
        character_class: 'Hero',
        character_level: url.searchParams.get('ocid') === 'resolved-first-character' ? 280 : 260,
        character_image: `https://image.example.test/${url.searchParams.get('ocid')}.png`,
      });
    }
    if (url.pathname.endsWith('/scheduler/character-state')) {
      return Response.json({
        date: '2026-10-08',
        daily_contents: [{ content_name: 'Daily Quest', now_count: 1, max_count: 3 }],
        weekly_contents: [],
        boss_contents: [{ content_name: 'Hard Boss', complete_flag: 'false' }],
      });
    }
    throw new Error(`Unexpected Nexon API request: ${url.pathname}`);
  };
  env.DB.prepare = (query) => ({ bind: (...values) => ({ query, values }) });
  env.DB.batch = async (statements) => { insertedStatements = statements; };
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/characters/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'nexon-key' }),
    }), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.characters, [
      {
        nickname: 'first-character',
        ocid: 'resolved-first-character',
        worldName: 'Scania',
        characterClass: 'Hero',
        level: 280,
        image: 'https://image.example.test/resolved-first-character.png',
        scheduler: {
          date: '2026-10-08',
          daily_contents: [{ content_name: 'Daily Quest', now_count: 1, max_count: 3 }],
          weekly_contents: [],
          boss_contents: [{ content_name: 'Hard Boss', complete_flag: 'false' }],
        },
      },
      {
        nickname: 'second-character',
        ocid: 'resolved-second-character',
        worldName: 'Scania',
        characterClass: 'Hero',
        level: 260,
        image: 'https://image.example.test/resolved-second-character.png',
        scheduler: {
          date: '2026-10-08',
          daily_contents: [{ content_name: 'Daily Quest', now_count: 1, max_count: 3 }],
          weekly_contents: [],
          boss_contents: [{ content_name: 'Hard Boss', complete_flag: 'false' }],
        },
      },
    ]);
    assert.equal(result.verified, true);
    assert.equal(requestedPaths.filter((path) => path === '/maplestory/v1/character/list').length, 1);
    assert.equal(requestedPaths.filter((path) => path === '/maplestory/v1/id').length, 2);
    assert.equal(requestedPaths.filter((path) => path === '/maplestory/v1/character/basic').length, 2);
    assert.equal(requestedPaths.filter((path) => path === '/maplestory/v1/scheduler/character-state').length, 2);
    assert.deepEqual(insertedStatements.map(({ values }) => values.slice(0, 3)), [
      ['google-subject', 'first-character', 'resolved-first-character'],
      ['google-subject', 'second-character', 'resolved-second-character'],
    ]);
    assert.equal(JSON.parse(insertedStatements[0].values[8]).date, '2026-10-08');
    assert.equal(insertedStatements.some(({ values }) => values.includes('nexon-key')), false);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    env.DB.batch = originalBatch;
  }
});

test('skips characters with unavailable basic info and continues syncing the rest', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  const originalBatch = env.DB.batch;
  const statements = [];
  const batches = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'openidconnect.googleapis.com') {
      return Response.json({
        sub: 'google-subject',
        email: 'member@example.test',
        email_verified: true,
      });
    }
    if (url.pathname.endsWith('/character/list')) {
      return Response.json({
        account_list: [{
          character_list: [
            { character_name: 'CeH1O1' },
            { character_name: 'WorkingCharacter' },
          ],
        }],
      });
    }
    if (url.pathname.endsWith('/id')) {
      return Response.json({ ocid: `ocid-${url.searchParams.get('character_name')}` });
    }
    if (url.pathname.endsWith('/character/basic')) {
      if (url.searchParams.get('ocid') === 'ocid-CeH1O1') {
        return Response.json({
          error: { name: 'OPENAPI00004', message: 'Invalid Parameter' },
        }, { status: 400 });
      }
      return Response.json({
        world_name: 'Scania',
        character_class: 'Hero',
        character_level: 280,
        character_image: 'https://image.example.test/working.png',
      });
    }
    if (url.pathname.endsWith('/scheduler/character-state')) {
      return new Response('{}', { status: 429 });
    }
    throw new Error(`Unexpected Nexon API request: ${url.pathname}`);
  };
  env.DB.prepare = (query) => ({
    bind: (...values) => {
      const statement = { query, values };
      statements.push(statement);
      return statement;
    },
  });
  env.DB.batch = async (batch) => { batches.push(batch); };
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/characters/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-access-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'nexon-key' }),
    }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      characters: [{
        nickname: 'WorkingCharacter',
        ocid: 'ocid-WorkingCharacter',
        worldName: 'Scania',
        characterClass: 'Hero',
        level: 280,
        image: 'https://image.example.test/working.png',
        scheduler: {},
      }],
      skippedCharacters: ['CeH1O1'],
      schedulerUnavailable: ['WorkingCharacter'],
      verified: true,
    });
    assert.equal(statements.some(({ query, values }) => (
      query.includes('DELETE FROM characters') && values[1] === 'CeH1O1'
    )), true);
    assert.equal(statements.some(({ query, values }) => (
      query.includes('INSERT INTO characters') && values[1] === 'WorkingCharacter'
    )), true);
    assert.equal(batches.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
    env.DB.batch = originalBatch;
  }
});

test('returns saved character profiles and scheduler data after sign-in', async () => {
  const originalFetch = globalThis.fetch;
  const originalPrepare = env.DB.prepare;
  globalThis.fetch = async () => new Response(JSON.stringify({
    sub: 'google-subject',
    email: 'member@example.test',
    email_verified: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  env.DB.prepare = () => ({
    bind: () => ({
      all: async () => ({
        results: [{
          nickname: 'first-character',
          ocid: 'ocid-1',
          verifiedAt: '2026-10-08T00:00:00.000Z',
          worldName: 'Scania',
          characterClass: 'Hero',
          level: 280,
          image: 'https://image.example.test/ocid-1.png',
          schedulerJson: JSON.stringify({ date: '2026-10-08', daily_contents: [] }),
          schedulerDate: '2026-10-08',
        }],
      }),
    }),
  });
  try {
    const response = await worker.fetch(new Request('https://worker.example.test/api/characters', {
      headers: { Authorization: 'Bearer test-access-token' },
    }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      characters: [{
        nickname: 'first-character',
        ocid: 'ocid-1',
        verifiedAt: '2026-10-08T00:00:00.000Z',
        worldName: 'Scania',
        characterClass: 'Hero',
        level: 280,
        image: 'https://image.example.test/ocid-1.png',
        schedulerDate: '2026-10-08',
        scheduler: { date: '2026-10-08', daily_contents: [] },
      }],
    });
  } finally {
    globalThis.fetch = originalFetch;
    env.DB.prepare = originalPrepare;
  }
});