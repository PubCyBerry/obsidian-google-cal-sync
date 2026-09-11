import { Platform, requestUrl } from 'obsidian';
import type GCalSync from './main';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks';
const LOGIN_TIMEOUT_MS = 120_000;

export class AuthError extends Error {}

function base64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	window.crypto.getRandomValues(buf);
	return base64url(buf);
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

interface TokenResponse {
	access_token?: string;
	expires_in?: number;
	refresh_token?: string;
	error?: string;
	error_description?: string;
}

export class Auth {
	pending = false;
	private accessToken = '';
	private expiresAt = 0;
	private refreshing: Promise<string> | null = null;

	constructor(private plugin: GCalSync) {}

	get loggedIn(): boolean {
		return !!this.plugin.settings.refreshToken;
	}

	/** Returns a valid access token, refreshing it with the stored refresh token when needed. Works on mobile. */
	async token(force = false): Promise<string> {
		if (!force && this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
		if (!this.refreshing) {
			this.refreshing = this.refresh().finally(() => {
				this.refreshing = null;
			});
		}
		return this.refreshing;
	}

	private async refresh(): Promise<string> {
		const { clientId, clientSecret, refreshToken } = this.plugin.settings;
		if (!clientId || !clientSecret) throw new AuthError('Client ID and secret are missing.');
		if (!refreshToken) throw new AuthError('Not logged in on this device.');
		await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
		return this.accessToken;
	}

	private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
		const { clientId, clientSecret } = this.plugin.settings;
		const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }).toString();
		const res = await requestUrl({ url: TOKEN_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded', body, throw: false });
		const data = (res.text ? JSON.parse(res.text) : {}) as TokenResponse;
		if (res.status >= 400 || !data.access_token) {
			this.accessToken = '';
			if (data.error === 'invalid_grant' && params.grant_type === 'refresh_token') throw new AuthError('Google connection lost. Log in again on desktop.');
			throw new AuthError(data.error_description || data.error || `Token request failed (${res.status})`);
		}
		this.accessToken = data.access_token;
		this.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
		return data;
	}

	/** Desktop only: loopback OAuth with PKCE. Resolves after the refresh token is stored. */
	async login(): Promise<void> {
		if (!Platform.isDesktop) throw new AuthError('Login is only available on desktop.');
		if (this.pending) throw new AuthError('A login is already in progress.');
		const { clientId, clientSecret } = this.plugin.settings;
		if (!clientId || !clientSecret) throw new AuthError('Enter the client ID and secret first.');
		this.pending = true;
		try {
			const verifier = randomToken(48);
			const state = randomToken(16);
			const challenge = await pkceChallenge(verifier);
			const { code, redirectUri } = await this.waitForCode(clientId, challenge, state);
			const data = await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
			if (!data.refresh_token) throw new AuthError('Google did not return a refresh token. Remove the app from your Google account permissions and log in again.');
			this.plugin.settings.refreshToken = data.refresh_token;
			await this.plugin.refreshCalendarList();
			await this.plugin.saveSettings();
			this.plugin.notifyChanged();
		} finally {
			this.pending = false;
		}
	}

	private waitForCode(clientId: string, challenge: string, state: string): Promise<{ code: string; redirectUri: string }> {
		// Node's http exists only on desktop, where Electron exposes require on window. Never referenced on mobile.
		const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
		if (Platform.isDesktop && nodeRequire) {
			const http = nodeRequire('http') as typeof import('http');
			return new Promise((resolve, reject) => {
				let done = false;
				const finish = (err: Error | null, code?: string, redirectUri?: string) => {
					if (done) return;
					done = true;
					window.clearTimeout(timer);
					server.close();
					server.closeAllConnections();
					if (err || !code || !redirectUri) reject(err ?? new AuthError('Login was cancelled.'));
					else resolve({ code, redirectUri });
				};
				const server = http.createServer((req, res) => {
					const url = new URL(req.url ?? '/', 'http://127.0.0.1');
					if (url.pathname !== '/') {
						res.writeHead(404).end();
						return;
					}
					const ok = url.searchParams.get('state') === state && !!url.searchParams.get('code');
					const error = url.searchParams.get('error');
					res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
					res.end(`<!doctype html><title>Google Calendar Tasks Sync</title><body style="font-family:sans-serif;padding:2em"><h2>${ok ? 'Connected. You can close this window and return to Obsidian.' : 'Login failed.'}</h2>${error ? `<p>${error}</p>` : ''}</body>`);
					if (error) finish(new AuthError(error));
					else if (!ok) finish(new AuthError('State mismatch. Try logging in again.'));
					else finish(null, url.searchParams.get('code') ?? '', `http://127.0.0.1:${port}`);
				});
				let port = 0;
				const timer = window.setTimeout(() => finish(new AuthError('Timed out waiting for the browser.')), LOGIN_TIMEOUT_MS);
				server.once('error', (e) => finish(e));
				server.listen(0, '127.0.0.1', () => {
					const addr = server.address();
					port = addr && typeof addr === 'object' ? addr.port : 0;
					const params = new URLSearchParams({
						client_id: clientId,
						redirect_uri: `http://127.0.0.1:${port}`,
						response_type: 'code',
						scope: SCOPES,
						code_challenge: challenge,
						code_challenge_method: 'S256',
						state,
						access_type: 'offline',
						prompt: 'consent',
					});
					window.open(`${AUTH_URL}?${params.toString()}`);
				});
			});
		}
		return Promise.reject(new AuthError('Login is only available on desktop.'));
	}

	/** Revokes the refresh token at Google and forgets it locally, along with cached data. */
	async logout(): Promise<void> {
		const s = this.plugin.settings;
		if (s.refreshToken) {
			try {
				await requestUrl({ url: `${REVOKE_URL}?token=${encodeURIComponent(s.refreshToken)}`, method: 'POST', throw: false });
			} catch {
				// Offline: the token is dropped locally anyway.
			}
		}
		this.accessToken = '';
		this.expiresAt = 0;
		this.plugin.cache.clearAll(Object.keys(s.calendars));
		s.refreshToken = '';
		s.account = '';
		s.calendars = {};
		s.taskLists = {};
		await this.plugin.saveSettings();
		this.plugin.notifyChanged();
	}
}
