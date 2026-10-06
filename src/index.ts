interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  GOOGLE_SPREADSHEET_ID: string;
  APP_ORIGINS: string;
}

interface GooglePrincipal {
  sub: string;
  email: string;
}

interface GroupRow {
  id: string;
  name: string;
  created_by_sub: string;
  created_by_email: string;
  role: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
}

interface GoogleAccessTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let accessTokenCache: { token: string; expiresAt: number } | undefined;
let initializedSpreadsheetId: string | undefined;

const bossIdPattern = /^[a-z]+_[A-Za-z]+$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set('Vary', 'Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Max-Age', '600');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function allowedOrigins(env: Env): Set<string> {
  return new Set(env.APP_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean));
}

async function authenticate(request: Request, env: Env): Promise<GooglePrincipal> {
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) throw new ApiError(401, 'Google 로그인이 필요합니다.');
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ApiError(401, 'Google 로그인 토큰이 만료되었거나 올바르지 않습니다.');
  const profile = await response.json() as GoogleUserInfo;
  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    throw new ApiError(401, 'Google 계정의 인증 상태를 확인할 수 없습니다.');
  }
  return { sub: profile.sub, email: profile.email.toLowerCase() };
}

async function getGoogleAccessToken(env: Env): Promise<string> {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) return accessTokenCache.token;
  if (!env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new ApiError(503, 'Worker에 Google 계정 연결 정보가 설정되지 않았습니다.');
  }

  const form = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!response.ok) throw new ApiError(503, 'Worker의 Google 계정 연결을 갱신하지 못했습니다.');
  const result = await response.json() as GoogleAccessTokenResponse;
  accessTokenCache = { token: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  return result.access_token;
}

async function googleApi<T>(env: Env, url: string, init: RequestInit = {}): Promise<T> {
  const accessToken = await getGoogleAccessToken(env);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body) headers.set('Content-Type', 'application/json');

  const response = await fetch(url, { ...init, headers });
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } } & T;
  if (!response.ok) {
    const message = response.status === 403
      ? 'Google 계정의 Drive 또는 Sheets 권한을 확인해 주세요.'
      : 'Google Drive/Sheets 요청에 실패했습니다.';
    throw new ApiError(502, body.error?.message ? `${message} (${body.error.message})` : message);
  }
  return body;
}

function spreadsheetUrl(env: Env, suffix = ''): string {
  if (!env.GOOGLE_SPREADSHEET_ID) throw new ApiError(503, 'Worker에 중앙 Google 스프레드시트 ID가 설정되지 않았습니다.');
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SPREADSHEET_ID)}${suffix}`;
}

async function ensureCentralSheets(env: Env): Promise<void> {
  if (initializedSpreadsheetId === env.GOOGLE_SPREADSHEET_ID) return;
  const metadata = await googleApi<{ sheets?: Array<{ properties: { title: string } }> }>(
    env,
    `${spreadsheetUrl(env)}?fields=sheets.properties.title`,
  );
  const existing = new Set((metadata.sheets || []).map((sheet) => sheet.properties.title));
  const headers: Record<string, string[]> = {
    Bosses: ['groupId', 'bossId'],
    Multipliers: ['groupId', 'nickname', 'bossId', 'multiplier', 'updatedAt', 'updatedBy'],
  };
  const missing = Object.keys(headers).filter((title) => !existing.has(title));
  if (missing.length) {
    await googleApi(env, `${spreadsheetUrl(env)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }),
    });
    const valuesUrl = `${spreadsheetUrl(env)}/values:batchUpdate`;
    await googleApi(env, valuesUrl, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: missing.map((title) => ({ range: `${title}!A1`, values: [headers[title]] })),
      }),
    });
  }
  initializedSpreadsheetId = env.GOOGLE_SPREADSHEET_ID;
}

async function readSheet(env: Env, range: string): Promise<string[][]> {
  await ensureCentralSheets(env);
  const url = new URL(`${spreadsheetUrl(env, `/values/${encodeURIComponent(range)}`)}`);
  const result = await googleApi<{ values?: string[][] }>(env, url.toString());
  return result.values || [];
}

async function appendSheetRows(env: Env, range: string, values: unknown[][]): Promise<void> {
  await ensureCentralSheets(env);
  const url = new URL(spreadsheetUrl(env, `/values/${encodeURIComponent(range)}:append`));
  url.searchParams.set('valueInputOption', 'USER_ENTERED');
  url.searchParams.set('insertDataOption', 'INSERT_ROWS');
  await googleApi(env, url.toString(), { method: 'POST', body: JSON.stringify({ values }) });
}

async function updateSheetRows(
  env: Env,
  data: Array<{ range: string; values: unknown[][] }>,
): Promise<void> {
  if (!data.length) return;
  await ensureCentralSheets(env);
  const url = `${spreadsheetUrl(env)}/values:batchUpdate`;
  await googleApi(env, url, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 64 * 1024) throw new ApiError(413, '요청 데이터가 너무 큽니다.');
  try {
    return JSON.parse(text || '{}') as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'JSON 요청 본문을 확인해 주세요.');
  }
}

function stringField(body: Record<string, unknown>, name: string, maxLength: number): string {
  const value = typeof body[name] === 'string' ? body[name].trim() : '';
  if (!value || value.length > maxLength) throw new ApiError(400, `${name} 값을 확인해 주세요.`);
  return value;
}

async function getGroup(env: Env, groupId: string, email: string): Promise<GroupRow> {
  const group = await env.DB.prepare(`
    SELECT g.id, g.name, g.created_by_sub, g.created_by_email, m.role
    FROM groups g JOIN group_members m ON m.group_id = g.id
    WHERE g.id = ? AND lower(m.email) = lower(?)
  `).bind(groupId, email).first<GroupRow>();
  if (!group) throw new ApiError(404, '그룹이 없거나 그룹 구성원이 아닙니다.');
  return group;
}

async function requireGroupAdmin(env: Env, groupId: string, principal: GooglePrincipal): Promise<GroupRow> {
  const group = await getGroup(env, groupId, principal.email);
  if (group.created_by_sub !== principal.sub || group.role !== 'admin') {
    throw new ApiError(403, '그룹 관리자만 이 작업을 할 수 있습니다.');
  }
  return group;
}

async function getBossIds(env: Env, groupId: string): Promise<string[]> {
  const rows = await readSheet(env, 'Bosses!A2:B');
  return [...new Set(rows
    .filter(([rowGroupId]) => rowGroupId === groupId)
    .map(([, bossId]) => String(bossId || '').trim())
    .filter((bossId) => bossIdPattern.test(bossId)))];
}

async function verifyCharacter(env: Env, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const nickname = stringField(body, 'nickname', 24);
  const apiKey = stringField(body, 'apiKey', 256);
  const headers = { 'x-nxopen-api-key': apiKey };
  const idUrl = new URL('https://open.api.nexon.com/maplestory/v1/id');
  idUrl.searchParams.set('character_name', nickname);
  const idResponse = await fetch(idUrl, { headers });
  const idResult = await idResponse.json().catch(() => ({})) as { ocid?: string };
  if (!idResponse.ok || !idResult.ocid) throw new ApiError(400, 'Nexon API 키 또는 캐릭터 닉네임을 확인할 수 없습니다.');

  const basicUrl = new URL('https://open.api.nexon.com/maplestory/v1/character/basic');
  basicUrl.searchParams.set('ocid', idResult.ocid);
  basicUrl.searchParams.set('date', new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
  const basicResponse = await fetch(basicUrl, { headers });
  const basicResult = await basicResponse.json().catch(() => ({})) as { character_name?: string };
  if (!basicResponse.ok || basicResult.character_name !== nickname) {
    throw new ApiError(400, '입력한 닉네임과 Nexon API에서 확인한 캐릭터가 일치하지 않습니다.');
  }

  await env.DB.prepare(`
    INSERT INTO characters (google_sub, nickname, ocid, verified_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (google_sub, nickname) DO UPDATE SET ocid = excluded.ocid, verified_at = excluded.verified_at
  `).bind(principal.sub, nickname, idResult.ocid, new Date().toISOString()).run();

  return json({ nickname, ocid: idResult.ocid, verified: true });
}

async function createGroup(env: Env, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const name = stringField(body, 'name', 80);
  const groupId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO groups (id, name, created_by_sub, created_by_email, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(groupId, name, principal.sub, principal.email, now),
    env.DB.prepare(`INSERT INTO group_members (group_id, email, role, joined_at) VALUES (?, ?, 'admin', ?)`)
      .bind(groupId, principal.email, now),
  ]);
  return json({ id: groupId, name }, 201);
}

async function listGroups(env: Env, principal: GooglePrincipal): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT g.id, g.name, m.role
    FROM groups g JOIN group_members m ON m.group_id = g.id
    WHERE lower(m.email) = lower(?) ORDER BY g.created_at DESC
  `).bind(principal.email).all();
  return json({ groups: result.results || [] });
}

async function listCharacters(env: Env, principal: GooglePrincipal): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT nickname, ocid, verified_at AS verifiedAt
    FROM characters WHERE google_sub = ? ORDER BY verified_at DESC
  `).bind(principal.sub).all();
  return json({ characters: result.results || [] });
}

async function addGroupMember(env: Env, groupId: string, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const group = await requireGroupAdmin(env, groupId, principal);
  const email = stringField(body, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Google 이메일 형식을 확인해 주세요.');
  const existing = await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND lower(email) = lower(?)')
    .bind(groupId, email).first();
  if (existing) return json({ email, added: false });

  await env.DB.prepare(`INSERT INTO group_members (group_id, email, role, joined_at) VALUES (?, ?, 'member', ?)`)
    .bind(groupId, email, new Date().toISOString()).run();
  return json({ email, added: true }, 201);
}

async function removeGroupMember(env: Env, groupId: string, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const group = await requireGroupAdmin(env, groupId, principal);
  const email = stringField(body, 'email', 254).toLowerCase();
  if (email === group.created_by_email.toLowerCase()) throw new ApiError(400, '그룹 생성자는 그룹에서 제거할 수 없습니다.');
  await env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND lower(email) = lower(?)').bind(groupId, email).run();
  return json({ email, removed: true });
}

async function addBoss(env: Env, groupId: string, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const group = await requireGroupAdmin(env, groupId, principal);
  const bossId = stringField(body, 'bossId', 80);
  if (!bossIdPattern.test(bossId)) throw new ApiError(400, 'bossId 형식이 올바르지 않습니다. 예: hard_kaling');
  const bossIds = await getBossIds(env, group.id);
  if (bossIds.includes(bossId)) return json({ bossId, added: false });
  await appendSheetRows(env, 'Bosses!A:B', [[group.id, bossId]]);
  return json({ bossId, added: true }, 201);
}

async function listBosses(env: Env, groupId: string, principal: GooglePrincipal): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  return json({ bossIds: await getBossIds(env, group.id) });
}

async function listMultipliers(env: Env, groupId: string, principal: GooglePrincipal): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  const rows = await readSheet(env, 'Multipliers!A2:F');
  const multipliers = rows.flatMap(([rowGroupId, nickname, bossId, multiplier, updatedAt, updatedBy]) => (
    rowGroupId === group.id && nickname && bossId
      ? [{ nickname, bossId, multiplier: String(multiplier || '').replace(/%$/, ''), updatedAt, updatedBy }]
      : []
  ));
  return json({ multipliers });
}

async function updateMultipliers(env: Env, groupId: string, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  const nickname = stringField(body, 'nickname', 24);
  const character = await env.DB.prepare(`
    SELECT ocid FROM characters WHERE google_sub = ? AND lower(nickname) = lower(?)
  `).bind(principal.sub, nickname).first<{ ocid: string }>();
  if (!character) throw new ApiError(403, '이 Google 계정으로 인증한 캐릭터가 아닙니다.');

  if (!Array.isArray(body.multipliers) || body.multipliers.length < 1 || body.multipliers.length > 100) {
    throw new ApiError(400, '배율 목록은 1개 이상 100개 이하로 보내야 합니다.');
  }
  const bossIds = new Set(await getBossIds(env, group.id));
  const incoming = new Map<string, number>();
  for (const item of body.multipliers) {
    if (!item || typeof item !== 'object') throw new ApiError(400, '배율 항목 형식이 올바르지 않습니다.');
    const row = item as { bossId?: unknown; multiplier?: unknown };
    const bossId = typeof row.bossId === 'string' ? row.bossId.trim() : '';
    const multiplier = Number(row.multiplier);
    if (!bossIdPattern.test(bossId) || !bossIds.has(bossId)) {
      throw new ApiError(403, `그룹에 등록되지 않은 bossId입니다: ${bossId || '(empty)'}`);
    }
    if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 1000) {
      throw new ApiError(400, `배율 값이 올바르지 않습니다: ${bossId}`);
    }
    incoming.set(bossId, multiplier);
  }

  const existingRows = await readSheet(env, 'Multipliers!A2:F');
  const updates: Array<{ range: string; values: unknown[][] }> = [];
  const additions: unknown[][] = [];
  const updatedAt = new Date().toISOString();
  for (const [bossId, multiplier] of incoming) {
    const matchingIndexes = existingRows.flatMap(([existingGroupId = '', existingNickname = '', existingBossId = ''], index) => (
      existingGroupId === group.id && existingNickname.toLowerCase() === nickname.toLowerCase() && existingBossId === bossId ? [index] : []
    ));
    const values = [[group.id, nickname, bossId, `${multiplier}%`, updatedAt, principal.email]];
    if (matchingIndexes.length) {
      for (const index of matchingIndexes) {
        updates.push({ range: `Multipliers!A${index + 2}:F${index + 2}`, values });
      }
    } else {
      additions.push(values[0]);
    }
  }
  await updateSheetRows(env, updates);
  await appendSheetRows(env, 'Multipliers!A:F', additions);
  return json({ nickname, updated: incoming.size, updatedAt });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.split('/').filter(Boolean);
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true });
  if (path[0] !== 'api') throw new ApiError(404, '요청한 API를 찾을 수 없습니다.');

  const principal = await authenticate(request, env);
  if (request.method === 'GET' && path.length === 2 && path[1] === 'groups') return listGroups(env, principal);
  if (request.method === 'GET' && path.length === 2 && path[1] === 'characters') return listCharacters(env, principal);
  if (request.method === 'POST' && path.length === 2 && path[1] === 'groups') {
    return createGroup(env, principal, await readBody(request));
  }
  if (request.method === 'POST' && path.length === 3 && path[1] === 'characters' && path[2] === 'verify') {
    return verifyCharacter(env, principal, await readBody(request));
  }
  if (path.length >= 3 && path[1] === 'groups') {
    const groupId = path[2];
    if (path.length === 4 && path[3] === 'members' && request.method === 'POST') {
      return addGroupMember(env, groupId, principal, await readBody(request));
    }
    if (path.length === 4 && path[3] === 'members' && request.method === 'DELETE') {
      return removeGroupMember(env, groupId, principal, await readBody(request));
    }
    if (path.length === 4 && path[3] === 'bosses' && request.method === 'GET') {
      return listBosses(env, groupId, principal);
    }
    if (path.length === 4 && path[3] === 'bosses' && request.method === 'POST') {
      return addBoss(env, groupId, principal, await readBody(request));
    }
    if (path.length === 4 && path[3] === 'multipliers' && request.method === 'GET') {
      return listMultipliers(env, groupId, principal);
    }
    if (path.length === 4 && path[3] === 'multipliers' && request.method === 'POST') {
      return updateMultipliers(env, groupId, principal, await readBody(request));
    }
  }
  throw new ApiError(404, '요청한 API를 찾을 수 없습니다.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const origins = allowedOrigins(env);
    if (origin && !origins.has(origin)) return json({ error: '허용되지 않은 웹 출처입니다.' }, 403);
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), origin);

    try {
      return withCors(await route(request, env), origin);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, '요청을 처리하지 못했습니다.');
      return withCors(json({ error: apiError.message }, apiError.status), origin);
    }
  },
};