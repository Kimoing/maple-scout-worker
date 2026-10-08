import type { BrowserWorker } from '@cloudflare/puppeteer';

interface Env {
  DB: D1Database;
  BROWSER: BrowserWorker;
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

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

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

async function authenticate(request: Request): Promise<GooglePrincipal> {
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

async function nexonError(response: Response): Promise<string> {
  const result = await response.json().catch(() => ({})) as {
    error?: { name?: unknown; message?: unknown };
  };
  const name = typeof result.error?.name === 'string' ? result.error.name : '';
  const message = typeof result.error?.message === 'string' ? result.error.message : '';
  return [name, message].filter(Boolean).join(': ') || `HTTP ${response.status}`;
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
  const result = await env.DB.prepare(`
    SELECT boss_id FROM bosses WHERE group_id = ? ORDER BY boss_id
  `).bind(groupId).all<{ boss_id: string }>();
  return [...new Set((result.results || [])
    .map(({ boss_id }) => String(boss_id || '').trim())
    .filter((bossId) => bossIdPattern.test(bossId)))];
}

async function verifyCharacter(env: Env, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  if (Object.keys(body).some((key) => key !== 'apiKey')) {
    throw new ApiError(400, 'apiKey만 요청할 수 있습니다.');
  }
  const apiKey = stringField(body, 'apiKey', 256);
  const headers = { 'x-nxopen-api-key': apiKey };
  let nextNexonRequestAt = 0;
  const fetchNexon = async (input: URL): Promise<Response> => {
    const now = Date.now();
    const requestAt = Math.max(now, nextNexonRequestAt);
    nextNexonRequestAt = requestAt + 200;
    if (requestAt > now) {
      await new Promise((resolve) => setTimeout(resolve, requestAt - now));
    }
    return fetch(input, { headers });
  };
  const listUrl = new URL('https://open.api.nexon.com/maplestory/v1/character/list');
  const listResponse = await fetchNexon(listUrl);
  if (!listResponse.ok) {
    throw new ApiError(400, `Nexon 캐릭터 목록 조회 실패: ${await nexonError(listResponse)}`);
  }
  const listResult = await listResponse.json().catch(() => ({})) as {
    account_list?: Array<{
      character_list?: Array<{ ocid?: string; character_name?: string; character_level?: number }>;
    }>;
  };
  const listedCharacters = [...new Map((listResult.account_list || [])
    .flatMap((account) => account.character_list || [])
    .flatMap((character) => {
      const nickname = typeof character.character_name === 'string' ? character.character_name.trim() : '';
      const ocid = typeof character.ocid === 'string' ? character.ocid.trim() : '';
      const level = typeof character.character_level === 'number' ? character.character_level : 0;
      return nickname && nickname.length <= 24 && level >= 260
        ? [[nickname.toLowerCase(), { nickname, ocid }]]
        : [];
    })).values()];
  if (!listedCharacters.length) throw new ApiError(400, 'Nexon API 키 계정에서 260레벨 이상 캐릭터를 찾을 수 없습니다.');

  const characters: Array<{
    nickname: string;
    ocid: string;
    worldName: string;
    characterClass: string;
    level: number;
    image: string;
    scheduler: Record<string, unknown>;
  }> = [];
  const skippedCharacters: string[] = [];
  const schedulerUnavailable: string[] = [];
  for (let offset = 0; offset < listedCharacters.length; offset += 3) {
    const batch = await Promise.allSettled(listedCharacters.slice(offset, offset + 3).map(async ({ nickname, ocid: listedOcid }) => {
      let ocid = listedOcid;
      if (!ocid) {
        const idUrl = new URL('https://open.api.nexon.com/maplestory/v1/id');
        idUrl.searchParams.set('character_name', nickname);
        const idResponse = await fetchNexon(idUrl);
        if (!idResponse.ok) {
          throw new ApiError(502, `${nickname} 캐릭터 OCID 조회 실패: ${await nexonError(idResponse)}`);
        }
        const idResult = await idResponse.json() as { ocid?: string };
        ocid = typeof idResult.ocid === 'string' ? idResult.ocid.trim() : '';
      }
      if (!ocid) throw new ApiError(502, `${nickname} 캐릭터 OCID를 Nexon API 응답에서 찾을 수 없습니다.`);

      const basicUrl = new URL('https://open.api.nexon.com/maplestory/v1/character/basic');
      basicUrl.searchParams.set('ocid', ocid);
      const schedulerUrl = new URL('https://open.api.nexon.com/maplestory/v1/scheduler/character-state');
      schedulerUrl.searchParams.set('ocid', ocid);
      const [basicResponse, schedulerResponse] = await Promise.all([
        fetchNexon(basicUrl),
        fetchNexon(schedulerUrl),
      ]);
      if (!basicResponse.ok) {
        throw new ApiError(502, `${nickname} 캐릭터 기본 정보 조회 실패 (OCID: ${ocid}): ${await nexonError(basicResponse)}`);
      }
      const basic = await basicResponse.json() as {
        world_name?: string;
        character_class?: string;
        character_level?: number;
        character_image?: string;
      };
      let scheduler: Record<string, unknown> = {};
      if (schedulerResponse.ok) {
        try {
          scheduler = await schedulerResponse.json() as Record<string, unknown>;
        } catch {
          schedulerUnavailable.push(nickname);
        }
      } else {
        schedulerUnavailable.push(nickname);
      }
      return {
        nickname,
        ocid,
        worldName: typeof basic.world_name === 'string' ? basic.world_name : '',
        characterClass: typeof basic.character_class === 'string' ? basic.character_class : '',
        level: typeof basic.character_level === 'number' ? basic.character_level : 0,
        image: typeof basic.character_image === 'string' ? basic.character_image : '',
        scheduler,
      };
    }));
    for (const [index, result] of batch.entries()) {
      if (result.status === 'fulfilled') {
        characters.push(result.value);
      } else {
        skippedCharacters.push(listedCharacters[offset + index].nickname);
      }
    }
  }

  if (!characters.length) {
    throw new ApiError(502, `Nexon API에서 캐릭터 기본 정보를 가져오지 못했습니다. 건너뛴 캐릭터: ${skippedCharacters.join(', ')}`);
  }

  const verifiedAt = new Date().toISOString();
  const statements = characters.map((character) => env.DB.prepare(`
    INSERT INTO characters (
      google_sub, nickname, ocid, verified_at, world_name, character_class, character_level, character_image,
      scheduler_json, scheduler_date
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (google_sub, nickname) DO UPDATE SET
      ocid = excluded.ocid,
      verified_at = excluded.verified_at,
      world_name = excluded.world_name,
      character_class = excluded.character_class,
      character_level = excluded.character_level,
      character_image = excluded.character_image,
      scheduler_json = excluded.scheduler_json,
      scheduler_date = excluded.scheduler_date
  `).bind(
    principal.sub,
    character.nickname,
    character.ocid,
    verifiedAt,
    character.worldName,
    character.characterClass,
    character.level,
    character.image,
    JSON.stringify(character.scheduler),
    typeof character.scheduler.date === 'string' ? character.scheduler.date : new Date().toISOString().slice(0, 10),
  ));
  for (let offset = 0; offset < statements.length; offset += 100) {
    await env.DB.batch(statements.slice(offset, offset + 100));
  }

  return json({ characters, skippedCharacters, schedulerUnavailable, verified: true });
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
    SELECT nickname, ocid, verified_at AS verifiedAt, world_name AS worldName,
      character_class AS characterClass, character_level AS level, character_image AS image,
      scheduler_json AS schedulerJson, scheduler_date AS schedulerDate,
      boss380_hexa_score AS boss380HexaScore
    FROM characters WHERE google_sub = ? ORDER BY verified_at DESC
  `).bind(principal.sub).all<{
    nickname: string;
    ocid: string;
    verifiedAt: string;
    worldName: string;
    characterClass: string;
    level: number;
    image: string;
    schedulerJson: string;
    schedulerDate: string;
    boss380HexaScore: number | null;
  }>();
  const characters = (result.results || []).map(({ schedulerJson, ...character }) => ({
    ...character,
    scheduler: JSON.parse(schedulerJson),
  }));
  return json({ characters });
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
  await env.DB.prepare(`
    INSERT INTO bosses (group_id, boss_id, created_at, created_by)
    VALUES (?, ?, ?, ?)
  `).bind(group.id, bossId, new Date().toISOString(), principal.email).run();
  return json({ bossId, added: true }, 201);
}

async function listBosses(env: Env, groupId: string, principal: GooglePrincipal): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  return json({ bossIds: await getBossIds(env, group.id) });
}

async function listMultipliers(env: Env, groupId: string, principal: GooglePrincipal): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  const result = await env.DB.prepare(`
    SELECT nickname, boss_id AS bossId, CAST(multiplier AS TEXT) AS multiplier,
      updated_at AS updatedAt, updated_by AS updatedBy
    FROM multipliers WHERE group_id = ? ORDER BY nickname COLLATE NOCASE, boss_id
  `).bind(group.id).all();
  return json({ multipliers: result.results || [] });
}

type MapleScouterResult = {
  multipliers: Map<string, number>;
  boss380HexaScore: number | null;
};

function logMapleScouterSetupFailure(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('MapleScouter browser setup failed', {
    stage,
    errorName: error instanceof Error ? error.name : 'UnknownError',
    message: message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300),
  });
}

async function scrapeMapleScouterResult(
  page: import('@cloudflare/puppeteer').Page,
  nickname: string,
  bossIds: Set<string>,
): Promise<MapleScouterResult> {
  await page.goto(`https://maplescouter.com/ko/result?name=${encodeURIComponent(nickname)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForSelector('img[src*="/bossIcon/"]', { timeout: 30_000 });
  const scraped = await page.$$eval('img[src*="/bossIcon/"]', (images) => images.flatMap((image) => {
    const src = image.getAttribute('src') || '';
    const filename = new URL(src, location.origin).pathname.split('/').pop() || '';
    const bossId = filename.replace(/\.[^.]+$/, '').trim().toLowerCase();
    const card = image.closest('div.bg-surface-gray-surface-0');
    const infoArea = card?.querySelector('div.relative.z-10');
    const percentages = Array.from(infoArea?.children || []).flatMap((element) => (
      (element.textContent || '').match(/\d+(?:\.\d+)?%/g) || []
    ));
    const multiplier = Number(percentages.at(-1)?.replace('%', ''));
    return bossId && Number.isFinite(multiplier) ? [{ bossId, multiplier }] : [];
  }));
  const multipliers = new Map<string, number>();
  for (const item of scraped) {
    if (bossIds.has(item.bossId)) multipliers.set(item.bossId, item.multiplier);
  }

  const boss380HexaScore = await page.$$eval('div.bg-surface-gray-surface-0', (cards) => {
    for (const card of cards) {
      const badge = Array.from(card.querySelectorAll('span'))
        .find((element) => element.textContent?.trim() === '보스380');
      if (!badge) continue;

      let section = badge.parentElement;
      while (section && card.contains(section)) {
        const hexaLabel = Array.from(section.querySelectorAll('span'))
          .find((element) => element.textContent?.trim() === '헥사');
        const value = hexaLabel && Array.from(hexaLabel.parentElement?.children || [])
          .find((element) => element.tagName === 'SPAN' && element !== hexaLabel);
        if (value) {
          const score = Number((value.textContent || '').replace(/[^\d]/g, ''));
          return Number.isSafeInteger(score) ? score : null;
        }
        section = section.parentElement;
      }
    }
    return null;
  });

  return { multipliers, boss380HexaScore };
}

async function scrapeBossMultipliers(env: Env, nickname: string, bossIds: Set<string>): Promise<MapleScouterResult> {
  try {
    const { default: puppeteer } = await import('@cloudflare/puppeteer');
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(45_000);
      return await scrapeMapleScouterResult(page, nickname, bossIds);
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch {
    throw new ApiError(502, 'MapleScouter에서 보스별 배율을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

async function refreshCharacterScores(
  env: Env,
  principal: GooglePrincipal,
  body: Record<string, unknown>,
): Promise<Response> {
  if (Object.keys(body).length) throw new ApiError(400, '요청 본문은 비워야 합니다.');
  const characters = await env.DB.prepare(`
    SELECT nickname FROM characters WHERE google_sub = ? ORDER BY nickname COLLATE NOCASE
  `).bind(principal.sub).all<{ nickname: string }>();
  const nicknames = characters.results || [];
  if (!nicknames.length) return json({ scores: [], refreshedCount: 0, unavailableCount: 0 });

  let puppeteer;
  try {
    ({ default: puppeteer } = await import('@cloudflare/puppeteer'));
  } catch (error) {
    logMapleScouterSetupFailure('import', error);
    throw new ApiError(502, 'MapleScouter 점수를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
  } catch (error) {
    logMapleScouterSetupFailure('launch', error);
    throw new ApiError(502, 'MapleScouter 점수를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45_000);

    let refreshedCount = 0;
    let unavailableCount = 0;
    for (const { nickname } of nicknames) {
      let boss380HexaScore: number | null;
      try {
        ({ boss380HexaScore } = await scrapeMapleScouterResult(page, nickname, new Set()));
      } catch {
        unavailableCount += 1;
        continue;
      }
      if (boss380HexaScore === null) {
        unavailableCount += 1;
        continue;
      }
      await env.DB.prepare(`
        UPDATE characters SET boss380_hexa_score = ?
        WHERE google_sub = ? AND lower(nickname) = lower(?)
      `).bind(boss380HexaScore, principal.sub, nickname).run();
      refreshedCount += 1;
    }
    const scores = await env.DB.prepare(`
      SELECT nickname, boss380_hexa_score AS boss380HexaScore
      FROM characters WHERE google_sub = ? ORDER BY nickname COLLATE NOCASE
    `).bind(principal.sub).all<{ nickname: string; boss380HexaScore: number | null }>();
    return json({ scores: scores.results || [], refreshedCount, unavailableCount });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function updateMultipliers(env: Env, groupId: string, principal: GooglePrincipal, body: Record<string, unknown>): Promise<Response> {
  const group = await getGroup(env, groupId, principal.email);
  if (Object.keys(body).some((key) => key !== 'nickname')) {
    throw new ApiError(400, 'nickname만 요청할 수 있습니다.');
  }
  const nickname = stringField(body, 'nickname', 24);
  const character = await env.DB.prepare(`
    SELECT ocid FROM characters WHERE google_sub = ? AND lower(nickname) = lower(?)
  `).bind(principal.sub, nickname).first<{ ocid: string }>();
  if (!character) throw new ApiError(403, '이 Google 계정으로 인증한 캐릭터가 아닙니다.');

  const bossIds = new Set((await getBossIds(env, group.id)).map((bossId) => bossId.toLowerCase()));
  if (!bossIds.size) throw new ApiError(400, '그룹에 등록된 보스가 없습니다. 먼저 보스를 등록해 주세요.');
  const scraped = await scrapeBossMultipliers(env, nickname, bossIds);
  if (scraped.boss380HexaScore !== null) {
    await env.DB.prepare(`
      UPDATE characters SET boss380_hexa_score = ?
      WHERE google_sub = ? AND lower(nickname) = lower(?)
    `).bind(scraped.boss380HexaScore, principal.sub, nickname).run();
  }
  if (!scraped.multipliers.size) throw new ApiError(502, 'MapleScouter 결과에서 그룹에 등록된 보스 배율을 찾지 못했습니다.');

  const updatedAt = new Date().toISOString();
  await env.DB.batch([...scraped.multipliers].map(([bossId, multiplier]) => env.DB.prepare(`
    INSERT INTO multipliers (group_id, nickname, boss_id, multiplier, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (group_id, nickname, boss_id) DO UPDATE SET
      multiplier = excluded.multiplier,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).bind(group.id, nickname, bossId, multiplier, updatedAt, principal.email)));
  return json({
    nickname,
    updated: scraped.multipliers.size,
    updatedAt,
    boss380HexaScore: scraped.boss380HexaScore,
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.split('/').filter(Boolean);
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true });
  if (path[0] !== 'api') throw new ApiError(404, '요청한 API를 찾을 수 없습니다.');

  const principal = await authenticate(request);
  if (request.method === 'GET' && path.length === 2 && path[1] === 'groups') return listGroups(env, principal);
  if (request.method === 'GET' && path.length === 2 && path[1] === 'characters') return listCharacters(env, principal);
  if (request.method === 'POST' && path.length === 3 && path[1] === 'characters' && path[2] === 'maplescouter-scores') {
    return refreshCharacterScores(env, principal, await readBody(request));
  }
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