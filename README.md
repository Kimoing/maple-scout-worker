# Maple Scout Worker

사용자 PC에서 크롤링한 `nickname`, `bossId`, 배율을 받아 **하나의 비공개 Google 스프레드시트**에 기록하는 Cloudflare Worker입니다. Worker가 Google Sheets에만 접근하며 그룹 사용자에게 스프레드시트를 공유하지 않습니다.

## 보안 구조

- 브라우저는 Google Identity Services OAuth access token을 보냅니다. Worker는 이를 Google UserInfo endpoint에서 확인하고 Google subject 및 인증된 이메일을 사용합니다.
- Cloudflare D1에는 Google 계정과 인증 캐릭터, 그룹 소유자, 그룹 멤버십을 저장합니다. 이 정보는 사용자에게 공유되지 않습니다.
- 단일 Google 스프레드시트 ID와 소유자 OAuth refresh token은 Worker 환경 설정/비밀값에만 둡니다. 클라이언트 번들에 넣지 않습니다.
- 그룹별 boss 목록은 `Bosses` 탭의 `groupId,bossId` 행으로, 배율은 `Multipliers` 탭의 `groupId,nickname,bossId,multiplier,updatedAt,updatedBy` 행으로 분리합니다.
- 갱신 요청은 그룹 멤버십, 해당 Google 계정으로 인증된 캐릭터, 그룹에 등록된 bossId를 모두 검사합니다.
- Nexon API 키는 캐릭터 인증 요청을 위해 HTTPS로 Worker에 전달되지만 저장하거나 로그에 남기지 않습니다. 키가 사용자 컴퓨터 밖으로 절대 나가면 안 된다면 Worker가 인증을 독립적으로 검증할 수 없습니다.

Google 스프레드시트는 그룹 사용자와 공유하지 않습니다. 그룹 사용자는 앱 API를 통해서만 해당 그룹 데이터에 접근합니다.

## Google Cloud 준비

1. Google Cloud 프로젝트에서 **Google Sheets API**를 활성화합니다. Drive API는 필요하지 않습니다.
2. OAuth 동의 화면을 설정합니다. 외부 사용자가 로그인하는 운영 앱은 Google의 게시/검증 요구사항을 확인합니다.
3. **웹 애플리케이션** OAuth 클라이언트를 만들고, 프런트엔드 주소(개발 예: `http://localhost:3000`)를 승인된 JavaScript 원본에 추가합니다.
4. 로컬 OAuth 갱신 토큰 발급용 승인된 redirect URI로 `http://127.0.0.1:8788/callback`을 추가합니다.
5. 스프레드시트는 소유자 Google 계정에서 직접 만들고, ID를 설정합니다. 문서는 비공개로 유지하고 앱 외부 사용자에게 공유하지 않습니다.

같은 OAuth Client ID를 프런트엔드 로그인과 Worker의 `GOOGLE_CLIENT_ID`에 사용합니다. 서버 측 소유자 동의 범위는 `spreadsheets`이며 그룹 시트 생성·Drive 공유 권한은 요청하지 않습니다.

## Cloudflare 배포

```sh
npm install
npx wrangler login
npm run db:create
```

`npm run db:create` 출력에 있는 D1 `database_id`를 `wrangler.jsonc`의 `REPLACE_WITH_D1_DATABASE_ID` 자리에 입력한 다음 스키마를 적용합니다.

```sh
npm run db:migrate:remote
```

`wrangler.jsonc` 또는 Cloudflare 대시보드의 Worker 변수:

- `GOOGLE_CLIENT_ID`: Google 웹 OAuth Client ID.
- `GOOGLE_SPREADSHEET_ID`: 소유자 계정의 비공개 스프레드시트 ID.
- `APP_ORIGINS`: 허용할 프런트엔드 Origin 목록. 쉼표로 구분하고 끝의 `/`는 뺍니다.

OAuth Client Secret은 Worker secret으로 저장합니다. `VITE_` 접두사 변수로 만들지 마세요.

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 소유자 Google 계정 연결

신뢰할 수 있는 컴퓨터에서 `.dev.vars.example`을 `.dev.vars`로 복사하고 Google Client ID와 Client Secret을 입력합니다. `.dev.vars`는 Git에서 제외됩니다. 스프레드시트 소유자 계정으로 로그인한 상태에서 실행합니다.

```sh
node scripts/authorize-google.mjs
```

스크립트가 출력한 URL을 열어 동의하면 refresh token이 해당 컴퓨터 터미널에 한 번 출력됩니다. 그 값을 Cloudflare secret 입력 프롬프트에 직접 붙여 넣으세요.

```sh
npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

Refresh token, Client Secret, `.dev.vars`를 커밋하지 마세요. Google OAuth 동의 화면이 **Testing** 상태이면 refresh token이 7일 후 만료될 수 있으니, 자동 운영 전에 앱 게시 상태를 확인하세요.

배포 및 상태 확인:

```sh
npm run deploy
curl https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/api/health
```

## API

`GET /api/health` 외 모든 요청에는 `Authorization: Bearer <Google OAuth access token>`이 필요합니다. 프런트엔드는 `openid email profile` 범위로 로그인해야 합니다. 요청 본문은 64 KiB 이하이며, Worker의 `APP_ORIGINS`에 실제 웹 앱 Origin을 등록해야 합니다.

| Method | Route | 기능 |
| --- | --- | --- |
| `GET` | `/api/health` | 공개 상태 확인 |
| `POST` | `/api/characters/verify` | Nexon API로 캐릭터를 확인하고 Google 계정에 연결 |
| `GET` | `/api/characters` | 로그인 사용자의 인증 캐릭터 목록 |
| `GET` | `/api/groups` | 로그인 사용자가 속한 그룹 목록 |
| `POST` | `/api/groups` | D1에 그룹 생성, 요청 사용자를 관리자 지정 |
| `POST` | `/api/groups/:id/members` | 그룹 관리자가 이메일 멤버 추가 |
| `DELETE` | `/api/groups/:id/members` | 그룹 관리자가 멤버 제거 |
| `GET` | `/api/groups/:id/bosses` | 그룹의 bossId 목록 조회 |
| `POST` | `/api/groups/:id/bosses` | 관리자가 중앙 시트의 `Bosses` 탭에 bossId 추가 |
| `GET` | `/api/groups/:id/multipliers` | 그룹 구성원의 중앙 시트 배율 조회 |
| `POST` | `/api/groups/:id/multipliers` | 인증된 캐릭터의 허용 boss 배율을 중앙 시트에 upsert |

배율 등록 예시:

```json
{
  "nickname": "오잉느",
  "multipliers": [
    { "bossId": "hard_kaling", "multiplier": 30.67 }
  ]
}
```

요청자는 그룹 멤버여야 하고 닉네임도 같은 Google 계정으로 인증되어 있어야 합니다. 또한 모든 bossId는 중앙 시트 `Bosses` 탭에 해당 `groupId`와 함께 등록되어 있어야 합니다.

## 검증

```sh
npm test
npm run typecheck
npx wrangler deploy --dry-run
```