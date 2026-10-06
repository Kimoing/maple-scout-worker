import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const redirectUri = 'http://127.0.0.1:8788/callback';
const state = randomBytes(32).toString('base64url');

try {
  const localVars = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
  for (const line of localVars.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {
  // Environment variables may be supplied by the shell instead.
}

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .dev.vars first.');
  process.exit(1);
}

const server = createServer(async (request, response) => {
  const callbackUrl = new URL(request.url || '/', redirectUri);
  if (callbackUrl.pathname !== '/callback') {
    response.writeHead(404).end('Not found');
    return;
  }
  if (callbackUrl.searchParams.get('state') !== state) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('OAuth state mismatch. You can close this tab.');
    server.close();
    return;
  }
  const code = callbackUrl.searchParams.get('code');
  if (!code) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Google did not return an authorization code.');
    server.close();
    return;
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenResult = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenResult.refresh_token) {
      console.error('Google OAuth did not return a refresh token. Revoke the app grant and run the consent flow again.');
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Authorization failed. Check the terminal for instructions.');
      server.close();
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Connected</title><p>Google account connected. You can close this tab and return to the terminal.</p>');
    console.log('\nGoogle account authorization succeeded. Copy the refresh token below into the Cloudflare secret prompt.\n');
    console.log(tokenResult.refresh_token);
    console.log('\nRun: npx wrangler secret put GOOGLE_REFRESH_TOKEN\n');
  } catch {
    response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Could not exchange the authorization code. Check the terminal.');
    console.error('Google OAuth token exchange failed.');
  } finally {
    server.close();
  }
});

server.listen(8788, '127.0.0.1', () => {
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'openid email profile https://www.googleapis.com/auth/spreadsheets',
    state,
  }).toString();
  console.log(`Open this URL in a browser signed into the spreadsheet owner account:\n\n${authorizationUrl}\n`);
  console.log('Waiting for the Google OAuth callback on http://127.0.0.1:8788/callback ...');
});