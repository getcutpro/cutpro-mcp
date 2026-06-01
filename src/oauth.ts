/**
 * OAuth 2.1 layer for the HTTP transport.
 *
 * Lets browser MCP clients (ChatGPT connectors, Claude.ai) connect without the
 * user pasting a key into a config file. Flow:
 *   1. Client does Dynamic Client Registration + /authorize (PKCE).
 *   2. We render a consent page where the user pastes their CutPro API key.
 *   3. We validate the key against the API, then issue an OAuth code -> token.
 *   4. The access token maps (server-side) to that key; the /mcp handler reads
 *      it from req.auth.extra.apiKey.
 *
 * State (clients, codes, tokens) is kept in a KV store — Redis when configured
 * (survives restarts, multi-instance), otherwise in-memory.
 */
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { KV } from "./store.js";

const CLIENT_TTL_S = 90 * 24 * 3600;
const CODE_TTL_S = 600;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;

function token(): string {
	return randomBytes(32).toString("base64url");
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

type CodeEntry = { clientId: string; redirectUri: string; codeChallenge: string; scopes: string[]; apiKey: string; expiresAt: number };
type TokenEntry = { clientId: string; scopes: string[]; apiKey: string; expiresAt: number };
type Pending = { clientId: string; redirectUri: string; codeChallenge: string; scopes: string[]; state?: string; expiresAt: number };

export class CutproOAuthProvider implements OAuthServerProvider {
	constructor(
		private apiBase: string,
		private kv: KV,
	) {}

	get clientsStore(): OAuthRegisteredClientsStore {
		return {
			getClient: async (id) => {
				const raw = await this.kv.get(`client:${id}`);
				if (!raw) return undefined;
				const client: OAuthClientInformationFull = JSON.parse(raw);
				return client;
			},
			registerClient: async (client) => {
				const full: OAuthClientInformationFull = { ...client, client_id: token(), client_id_issued_at: Math.floor(Date.now() / 1000) };
				await this.kv.set(`client:${full.client_id}`, JSON.stringify(full), CLIENT_TTL_S);
				return full;
			},
		};
	}

	/** Render the consent page that collects the user's CutPro API key. */
	async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
		const pendingId = token();
		const pending: Pending = {
			clientId: client.client_id,
			redirectUri: params.redirectUri,
			codeChallenge: params.codeChallenge,
			scopes: params.scopes ?? [],
			state: params.state,
			expiresAt: Date.now() + CODE_TTL_S * 1000,
		};
		await this.kv.set(`pending:${pendingId}`, JSON.stringify(pending), CODE_TTL_S);
		res.set("Content-Type", "text/html").send(this.consentHtml(pendingId));
	}

	/** Handle the consent form POST: validate the key, issue a code, redirect back. */
	async handleConsent(req: Request, res: Response): Promise<void> {
		const body: Record<string, unknown> = req.body ?? {};
		const pendingId = typeof body.pending === "string" ? body.pending : "";
		const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
		const raw = await this.kv.get(`pending:${pendingId}`);
		if (!raw) {
			res.status(400).set("Content-Type", "text/html").send(this.errorHtml("Sessão expirada. Recomece a conexão pelo seu cliente de IA."));
			return;
		}
		const p: Pending = JSON.parse(raw);
		if (p.expiresAt < Date.now()) {
			await this.kv.del(`pending:${pendingId}`);
			res.status(400).set("Content-Type", "text/html").send(this.errorHtml("Sessão expirada. Recomece a conexão pelo seu cliente de IA."));
			return;
		}
		if (!apiKey || !(await this.validateKey(apiKey))) {
			res.status(401).set("Content-Type", "text/html").send(this.consentHtml(pendingId, "Chave inválida. Confira em cut.pro/studio/me/api-keys."));
			return;
		}
		await this.kv.del(`pending:${pendingId}`);
		const code = token();
		const entry: CodeEntry = {
			clientId: p.clientId,
			redirectUri: p.redirectUri,
			codeChallenge: p.codeChallenge,
			scopes: p.scopes,
			apiKey,
			expiresAt: Date.now() + CODE_TTL_S * 1000,
		};
		await this.kv.set(`code:${code}`, JSON.stringify(entry), CODE_TTL_S);
		const url = new URL(p.redirectUri);
		url.searchParams.set("code", code);
		if (p.state) url.searchParams.set("state", p.state);
		res.redirect(url.toString());
	}

	async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
		const raw = await this.kv.get(`code:${authorizationCode}`);
		if (!raw) throw new Error("invalid_grant");
		const entry: CodeEntry = JSON.parse(raw);
		return entry.codeChallenge;
	}

	async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
		const raw = await this.kv.take(`code:${authorizationCode}`);
		if (!raw) throw new Error("invalid_grant");
		const entry: CodeEntry = JSON.parse(raw);
		if (entry.clientId !== client.client_id || entry.expiresAt < Date.now()) throw new Error("invalid_grant");
		return this.issueTokens(entry.clientId, entry.scopes, entry.apiKey);
	}

	async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
		const raw = await this.kv.take(`rt:${refreshToken}`);
		if (!raw) throw new Error("invalid_grant");
		const entry: TokenEntry = JSON.parse(raw);
		if (entry.clientId !== client.client_id) throw new Error("invalid_grant");
		return this.issueTokens(entry.clientId, scopes && scopes.length ? scopes : entry.scopes, entry.apiKey);
	}

	async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
		const raw = await this.kv.get(`at:${accessToken}`);
		if (!raw) throw new Error("invalid_token");
		const entry: TokenEntry = JSON.parse(raw);
		if (entry.expiresAt < Date.now()) throw new Error("invalid_token");
		return { token: accessToken, clientId: entry.clientId, scopes: entry.scopes, expiresAt: Math.floor(entry.expiresAt / 1000), extra: { apiKey: entry.apiKey } };
	}

	async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
		await this.kv.del(`at:${request.token}`);
		await this.kv.del(`rt:${request.token}`);
	}

	private async issueTokens(clientId: string, scopes: string[], apiKey: string): Promise<OAuthTokens> {
		const access = token();
		const refresh = token();
		const accessEntry: TokenEntry = { clientId, scopes, apiKey, expiresAt: Date.now() + ACCESS_TTL_S * 1000 };
		const refreshEntry: TokenEntry = { clientId, scopes, apiKey, expiresAt: Date.now() + REFRESH_TTL_S * 1000 };
		await this.kv.set(`at:${access}`, JSON.stringify(accessEntry), ACCESS_TTL_S);
		await this.kv.set(`rt:${refresh}`, JSON.stringify(refreshEntry), REFRESH_TTL_S);
		return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(" ") };
	}

	private async validateKey(apiKey: string): Promise<boolean> {
		try {
			const res = await fetch(`${this.apiBase}/workspace`, { headers: { "X-Api-Key": apiKey } });
			return res.ok;
		} catch {
			return false;
		}
	}

	private consentHtml(pendingId: string, error?: string): string {
		const err = error ? `<p style="color:#e5484d;margin:0 0 12px">${escapeHtml(error)}</p>` : "";
		return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar CutPro</title></head>
<body style="margin:0;background:#0C0C0E;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<form method="post" action="/oauth/consent" style="background:#1A1A24;padding:32px;border-radius:16px;max-width:380px;width:90%">
<h1 style="font-size:20px;margin:0 0 8px">Conectar ao CutPro</h1>
<p style="color:#a1a1aa;margin:0 0 20px;font-size:14px">Cole sua chave de API para autorizar o acesso. Gere uma em <a href="https://cut.pro/studio/me/api-keys" style="color:#A78BFA">cut.pro/studio/me/api-keys</a> (plano Pro).</p>
${err}
<input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
<input name="api_key" type="password" placeholder="Sua chave de API" autocomplete="off" required style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #333;background:#0C0C0E;color:#fff;margin:0 0 16px">
<button type="submit" style="width:100%;padding:12px;border:0;border-radius:10px;background:#7C3AED;color:#fff;font-weight:600;cursor:pointer">Autorizar</button>
</form></body></html>`;
	}

	private errorHtml(message: string): string {
		return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Erro</title></head>
<body style="margin:0;background:#0C0C0E;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<p style="max-width:360px;text-align:center">${escapeHtml(message)}</p></body></html>`;
	}
}
