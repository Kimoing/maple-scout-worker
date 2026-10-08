# Maple Scout Worker

이 저장소는 MapleStory 그룹 앱의 API를 제공하는 Cloudflare Worker입니다. 클라이언트는 캐릭터 닉네임만 보내고, Worker가 MapleScouter를 브라우저 렌더링으로 조회해 그룹 보스 배율을 Cloudflare D1에 저장합니다. 그룹, 멤버, 인증 캐릭터, 보스 목록, 배율은 모두 D1에 저장됩니다.

## 보안 구조

- 브라우저는 Google Identity Services access token을 보냅니다. Worker는 Google UserInfo에서 토큰과 인증된 이메일을 확인합니다. Google API, client secret, refresh token은 사용하지 않습니다.
- Cloudflare D1에는 Google 계정 subject, 인증 캐릭터, 그룹 소유자, 그룹 멤버십, 보스 목록, 배율을 저장합니다.
- 배율 갱신은 그룹 멤버십과 해당 Google 계정에 연결된 캐릭터인지 확인한 뒤, Worker의 Browser Rendering으로 MapleScouter를 열어 처리합니다.
- Nexon API 키는 캐릭터 인증 요청을 위해 HTTPS로 Worker에 전달되지만 저장하거나 로그에 남기지 않습니다. 키가 사용자 컴퓨터 밖으로 절대 나가면 안 된다면 Worker가 인증을 독립적으로 검증할 수 없습니다.

## 앱 구조

- **프런트엔드**: Google 로그인, 캐릭터 인증, 그룹/멤버 관리, 보스 배율 새로고침 UI를 담당합니다. 프런트엔드 코드는 이 저장소에 포함되어 있지 않습니다.
- **Cloudflare Worker (`src/index.ts`)**: CORS와 Google 로그인 토큰을 확인하고 API 요청을 처리합니다. 캐릭터 인증은 Nexon Open API에, 배율 수집은 Browser Rendering을 통해 MapleScouter에 요청합니다.
- **Cloudflare D1 (`migrations/`)**: `groups`, `group_members`, `characters`, `bosses`, `multipliers` 테이블에 앱 데이터를 보관합니다.
- **Browser Rendering**: Worker가 MapleScouter 페이지를 실제 Chromium DOM으로 렌더링합니다. 단순 HTTP HTML 응답에는 보스별 결과가 포함되지 않아 이 바인딩이 필요합니다.

로그인된 사용자는 본인이 속한 그룹만 조회할 수 있습니다. 관리자만 멤버와 보스 목록을 관리하고, 사용자는 자기 Google 계정에 인증된 캐릭터의 배율만 갱신할 수 있습니다.

## Google 로그인 준비

1. Google Cloud 프로젝트에서 OAuth 동의 화면을 설정합니다. 외부 사용자가 로그인하는 운영 앱은 Google의 게시/검증 요구사항을 확인합니다.
2. **웹 애플리케이션** OAuth Client ID를 만들고, 프런트엔드 주소(예: `http://localhost:3000`)를 승인된 JavaScript 원본에 추가합니다.
3. 프런트엔드 Google Identity Services 설정에 Client ID를 넣고 `openid email profile` 범위로 로그인합니다.

Client ID는 프런트엔드 로그인용이며 Worker secret으로 등록하지 않습니다. 로그인 access token만 Worker에 전달합니다.

## Cloudflare 배포

```sh
npm install
npx wrangler login
npm run db:create
```

`npm run db:create` 출력에 있는 D1 `database_id`를 `wrangler.jsonc`의 `REPLACE_WITH_D1_DATABASE_ID` 자리에 입력한 다음 스키마를 적용합니다.

```sh
`npm run db:migrate:remote`
```

`wrangler.jsonc`의 `APP_ORIGINS`에 실제 프런트엔드 주소를 쉼표로 구분해 등록합니다. 주소 끝에 `/`는 붙이지 않습니다. 그 외 Google 관련 Worker 변수나 secret은 없습니다.

Cloudflare 대시보드에서 **Browser Rendering**을 활성화합니다. `wrangler.jsonc`의 `BROWSER` binding이 이 서비스를 연결합니다.

기존 Google Sheet에 보스 목록이나 배율 데이터가 있다면 자동 이전되지는 않습니다. 새 D1 배포 후 그룹 관리자가 보스를 다시 등록해야 하고, 각 캐릭터의 배율도 새로고침해야 합니다.

배포 및 상태 확인:

```sh
npm run deploy
curl https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/api/health
```

## GitHub에 push

변경사항을 커밋한 뒤 `main` 브랜치에 push합니다.

```sh
git add <파일>
git commit -m "변경 내용"
git push origin main
```

Codespaces에서 `Write access to repository not granted` 오류가 나면, 환경의 제한된 `GITHUB_TOKEN` 대신 저장된 GitHub 인증을 사용해 push합니다.

```sh
env -u GITHUB_TOKEN git push origin main
```

이 명령은 해당 push에만 `GITHUB_TOKEN`을 제외합니다. 그래도 거부되면 현재 GitHub 계정에 저장소 쓰기 권한이 있는지 확인합니다.

## API

`GET /api/health` 외 모든 요청에는 `Authorization: Bearer <Google OAuth access token>`이 필요합니다. 프런트엔드는 `openid email profile` 범위로 로그인해야 합니다. 요청 본문은 64 KiB 이하이며, Worker의 `APP_ORIGINS`에 실제 웹 앱 Origin을 등록해야 합니다.

| Method | Route | 기능 |
| --- | --- | --- |
| `GET` | `/api/health` | 공개 상태 확인 |
| `POST` | `/api/characters/verify` | Nexon API 키 계정의 전체 캐릭터를 Google 계정에 연결 |
| `GET` | `/api/characters` | 로그인 사용자의 인증 캐릭터 목록 |
| `GET` | `/api/groups` | 로그인 사용자가 속한 그룹 목록 |
| `POST` | `/api/groups` | D1에 그룹 생성, 요청 사용자를 관리자 지정 |
| `POST` | `/api/groups/:id/members` | 그룹 관리자가 이메일 멤버 추가 |
| `DELETE` | `/api/groups/:id/members` | 그룹 관리자가 멤버 제거 |
| `GET` | `/api/groups/:id/bosses` | 그룹의 bossId 목록 조회 |
| `POST` | `/api/groups/:id/bosses` | 관리자가 D1에 bossId 추가 |
| `GET` | `/api/groups/:id/multipliers` | 그룹 배율을 D1에서 조회 |
| `POST` | `/api/groups/:id/multipliers` | 인증된 캐릭터의 MapleScouter 배율을 크롤링해 D1에 upsert |

캐릭터 연결 요청에는 Nexon API 키만 전달합니다. Worker는 응답에 포함된 모든 캐릭터를 Google 계정에 연결하고, API 키는 저장하지 않습니다.

```json
{
  "apiKey": "NEXON_OPEN_API_KEY"
}
```

배율 새로고침 요청 예시:

```json
{
  "nickname": "오잉느"
}
```

요청자는 그룹 멤버여야 하고 닉네임도 같은 Google 계정으로 인증되어 있어야 합니다. 등록된 그룹 bossId에 해당하는 배율만 저장합니다.

## 검증

```sh
npm test
npm run typecheck
npx wrangler deploy --dry-run
```