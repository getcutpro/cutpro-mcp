#!/usr/bin/env node
/**
 * CutPro MCP server.
 *
 * Exposes the full public CutPro v1 API (https://api.cut.pro/api/v1) as MCP tools
 * so AI clients can drive everything: workspace, balance, videos & uploads,
 * clipping, clips, templates, renders, posts and connections.
 *
 * Transports (works everywhere):
 *   - stdio (default): for locally-spawned clients (Claude Code, Claude Desktop,
 *     Cursor, Windsurf, VS Code, Cline, Zed, ...).
 *   - Streamable HTTP: set MCP_TRANSPORT=http (or PORT) for remote / self-host.
 *     Reads the key per request from `Authorization: Bearer` or `X-Api-Key`.
 *
 * Auth (stdio): CUTPRO_API_KEY (+ CUTPRO_WORKSPACE_ID for multi-workspace keys).
 * Generate a key at https://cut.pro/studio/me/api-keys (Pro plan).
 *
 * Every tool declares an input schema with described parameters, an output
 * schema, read-only/write/destructive annotations, and returns both compact text
 * and structured content. Hot paths are projected to the fields that matter.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express, { type Request, type RequestHandler } from "express";
import { z } from "zod";
import { CutproOAuthProvider } from "./oauth.js";
import { createMemoryKV, createRedisKV } from "./store.js";

const BASE_URL = process.env.CUTPRO_API_URL ?? "https://api.cut.pro/api/v1";

type Creds = { apiKey: string; workspaceId?: string };

// ── HTTP client ──────────────────────────────────────────────────────────────

function createApi({ apiKey, workspaceId }: Creds) {
	return async function api(method: string, path: string, body?: unknown): Promise<unknown> {
		const headers: Record<string, string> = { "X-Api-Key": apiKey };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (workspaceId) headers["X-Workspace-Id"] = workspaceId;

		const res = await fetch(`${BASE_URL}${path}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});

		const text = await res.text();
		let data: unknown = null;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = text;
			}
		}
		if (!res.ok) {
			const detail = typeof data === "string" ? data : JSON.stringify(data);
			throw new Error(`CutPro API ${res.status} on ${method} ${path}: ${detail}`);
		}
		return data;
	};
}

// ── Helpers (keep results lean) ──────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
	return typeof v === "number" ? v : 0;
}

/** Build a query string from defined params. */
function qs(params: Record<string, unknown>): string {
	const u = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) u.set(k, String(v));
	}
	const s = u.toString();
	return s ? `?${s}` : "";
}

/** Keep only `keys`, dropping null/undefined. Passes non-objects through. */
function project(data: unknown, keys: readonly string[]): unknown {
	if (!isRecord(data)) return data;
	const out: Record<string, unknown> = {};
	for (const k of keys) {
		const v = data[k];
		if (v !== undefined && v !== null) out[k] = v;
	}
	return out;
}

function leanClips(data: unknown, limit: number, includeUrls: boolean): unknown {
	if (!isRecord(data) || !Array.isArray(data.clips)) return data;
	const keys = includeUrls ? ["id", "title", "rating", "start_time", "end_time", "play_url", "download_url"] : ["id", "title", "rating", "start_time", "end_time"];
	const clips = data.clips
		.filter(isRecord)
		.sort((a, b) => num(b.rating) - num(a.rating))
		.slice(0, limit)
		.map((c) => project(c, keys));
	return { total: data.clips.length, returned: clips.length, clips };
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** Run a fetch, optionally shape it, and return compact JSON text + structured content. */
async function run(fetcher: () => Promise<unknown>, shape?: (d: unknown) => unknown): Promise<ToolResult> {
	try {
		const data = await fetcher();
		const out = shape ? shape(data) : data;
		const structuredContent = isRecord(out) ? out : { result: out };
		return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { content: [{ type: "text", text: message }], isError: true };
	}
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
const WRITES = { readOnlyHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

// Reusable input shape (described, for tool quality).
const PAGE = {
	page: z.number().int().optional().describe("Page number, 1-based."),
	limit: z.number().int().optional().describe("Items per page."),
};

// Reusable output building blocks. Output fields are optional so structured
// output never fails validation; the text content always carries the full result.
const str = z.string().optional();
const numO = z.number().optional();
const boolO = z.boolean().optional();
const VIDEO_OUT = { video_id: str, title: str, duration: numO, credits_cost: numO, current_balance: numO, force_watermark: boolO };
const RESULT_OUT = { result: z.unknown().describe("The raw API response.") };
const OK_OUT = { ok: z.boolean().optional().describe("True when the action succeeded with no body."), result: z.unknown().optional() };
const wrapResult = (d: unknown) => ({ result: d });
const okWrap = (d: unknown) => (d == null ? { ok: true } : { result: d });

// ── Server (one per credential set; stateless in HTTP mode) ──────────────────

function buildServer(creds: Creds): McpServer {
	const api = createApi(creds);
	const server = new McpServer({ name: "cutpro", version: "1.0.2" });

	// ── Workspace & balance ──
	server.registerTool(
		"get_workspace",
		{ title: "Get workspace", description: "The workspace this key resolved to, with its plan, role and seats.", inputSchema: {}, outputSchema: RESULT_OUT, annotations: READ_ONLY },
		() => run(() => api("GET", "/workspace"), wrapResult),
	);

	server.registerTool(
		"get_balance",
		{ title: "Get credit balance", description: "Current credit balance of the workspace.", inputSchema: {}, outputSchema: { balance: numO, credits: numO, current_balance: numO }, annotations: READ_ONLY },
		() => run(() => api("GET", "/balance"), (d) => project(d, ["balance", "credits", "current_balance"])),
	);

	server.registerTool(
		"get_balance_history",
		{
			title: "Get credit history",
			description: "Ledger of credits added and consumed.",
			inputSchema: {
				...PAGE,
				type: z.string().optional().describe("Filter by transaction type."),
				reference_type: z.string().optional().describe("Filter by reference type."),
			},
			outputSchema: RESULT_OUT,
			annotations: READ_ONLY,
		},
		(a) => run(() => api("GET", `/balance/history${qs(a)}`), wrapResult),
	);

	// ── Videos & uploads ──
	server.registerTool(
		"list_videos",
		{
			title: "List videos",
			description: "Your source video library.",
			inputSchema: { ...PAGE, sort: z.string().optional().describe("Sort order, e.g. 'recent'.") },
			outputSchema: RESULT_OUT,
			annotations: READ_ONLY,
		},
		(a) => run(() => api("GET", `/clips${qs(a)}`), wrapResult),
	);

	server.registerTool(
		"delete_video",
		{
			title: "Delete a video",
			description: "Delete a source video and its submissions/clips.",
			inputSchema: { video_id: z.string().describe("Video id to delete.") },
			outputSchema: OK_OUT,
			annotations: DESTRUCTIVE,
		},
		({ video_id }) => run(() => api("DELETE", `/clips/${video_id}`), okWrap),
	);

	server.registerTool(
		"start_upload",
		{
			title: "Start a file upload",
			description: "Get a presigned URL to upload your own video file. PUT the bytes to upload_url (same content_type), then call complete_upload. Max 2 GB; .mp4/.mov/.webm/.mkv.",
			inputSchema: {
				file_name: z.string().describe("Original file name, e.g. 'live.mp4'."),
				file_size: z.number().describe("File size in bytes."),
				content_type: z.string().optional().describe("MIME type. Defaults to video/mp4."),
			},
			outputSchema: { video_id: str, upload_url: str, expires_in: numO },
			annotations: WRITES,
		},
		(a) => run(() => api("POST", "/videos/upload", a), (d) => project(d, ["video_id", "upload_url", "expires_in"])),
	);

	server.registerTool(
		"complete_upload",
		{
			title: "Complete a file upload",
			description: "Register a finished upload (after the PUT) and get its metadata and credit cost. Returns a video_id for submit_clipping.",
			inputSchema: {
				video_id: z.string().describe("The video_id from start_upload."),
				file_name: z.string().describe("Original file name."),
				duration: z.number().describe("Duration in seconds."),
				width: z.number().describe("Width in pixels."),
				height: z.number().describe("Height in pixels."),
			},
			outputSchema: VIDEO_OUT,
			annotations: WRITES,
		},
		(a) => run(() => api("POST", "/videos/upload/complete", a), (d) => project(d, ["video_id", "title", "duration", "credits_cost", "current_balance", "force_watermark"])),
	);

	// ── Clipping ──
	server.registerTool(
		"analyze_video",
		{
			title: "Analyze a video",
			description: "Preview metadata and credit cost of a public video URL (YouTube, Twitch, Kick, TikTok). Free. Returns a video_id for submit_clipping.",
			inputSchema: { url: z.string().describe("Public video URL.") },
			outputSchema: VIDEO_OUT,
			annotations: WRITES,
		},
		({ url }) => run(() => api("POST", "/clips/info", { url }), (d) => project(d, ["video_id", "title", "duration", "credits_cost", "current_balance", "force_watermark"])),
	);

	server.registerTool(
		"submit_clipping",
		{
			title: "Submit for clipping",
			description: "Start AI clipping. Charges credits immediately (call analyze_video first). Returns submission_id to poll with get_submission.",
			inputSchema: {
				video_id: z.string().describe("From analyze_video or complete_upload."),
				strategy_id: z.string().optional().describe("Clipping strategy id (see list_templates for ids)."),
				template_id: z.string().optional().describe("Editing template id to apply to the clips."),
				source_language: z.enum(["auto", "en", "pt"]).optional().describe("Source audio language. Defaults to auto."),
				timeframe: z
					.object({ start: z.number().describe("Start offset in seconds (inclusive)."), end: z.number().describe("End offset in seconds (exclusive).") })
					.optional()
					.describe("Seconds [start, end) to process. Omit for the whole video."),
			},
			outputSchema: { submission_id: str, status: str, credits_charged: numO },
			annotations: WRITES,
		},
		(args) => run(() => api("POST", "/clips", args), (d) => project(d, ["submission_id", "status", "credits_charged"])),
	);

	server.registerTool(
		"list_submissions",
		{
			title: "List submissions",
			description: "Clipping jobs for a video.",
			inputSchema: { video_id: z.string().describe("Video id."), ...PAGE },
			outputSchema: RESULT_OUT,
			annotations: READ_ONLY,
		},
		({ video_id, ...a }) => run(() => api("GET", `/clips/${video_id}/submissions${qs(a)}`), wrapResult),
	);

	server.registerTool(
		"get_submission",
		{
			title: "Get submission status",
			description: "Poll a submission until status is 'completed' or 'failed'.",
			inputSchema: { video_id: z.string().describe("Video id."), submission_id: z.string().describe("Submission id from submit_clipping.") },
			outputSchema: { status: str, clips_count: numO, queue_position: numO, estimated_time: numO, error_code: str },
			annotations: READ_ONLY,
		},
		({ video_id, submission_id }) =>
			run(() => api("GET", `/clips/${video_id}/submissions/${submission_id}`), (d) => project(d, ["status", "clips_count", "queue_position", "estimated_time", "error_code"])),
	);

	server.registerTool(
		"delete_submission",
		{
			title: "Delete a submission",
			description: "Delete a submission and its clips.",
			inputSchema: { video_id: z.string().describe("Video id."), submission_id: z.string().describe("Submission id.") },
			outputSchema: OK_OUT,
			annotations: DESTRUCTIVE,
		},
		({ video_id, submission_id }) => run(() => api("DELETE", `/clips/${video_id}/submissions/${submission_id}`), okWrap),
	);

	// ── Clips ──
	server.registerTool(
		"list_clips",
		{
			title: "List generated clips",
			description: "Clips of a completed submission, rating-sorted. URLs omitted unless include_urls is true (they are long).",
			inputSchema: {
				video_id: z.string().describe("Video id."),
				submission_id: z.string().describe("Submission id."),
				limit: z.number().int().min(1).max(50).optional().describe("Max clips to return. Default 10."),
				min_rating: z.number().optional().describe("Only clips with at least this rating (0-10)."),
				include_urls: z.boolean().optional().describe("Include play/download URLs. Default false."),
			},
			outputSchema: { total: numO, returned: numO, clips: z.array(z.record(z.string(), z.unknown())).optional().describe("Clips, rating-sorted.") },
			annotations: READ_ONLY,
		},
		({ video_id, submission_id, limit, min_rating, include_urls }) =>
			run(() => api("GET", `/clips/${video_id}/submissions/${submission_id}/clips${qs({ min_rating, limit: 50 })}`), (d) => leanClips(d, limit ?? 10, include_urls ?? false)),
	);

	server.registerTool(
		"apply_template",
		{
			title: "Apply a template to clips",
			description: "Apply an editing template to clips of a submission in bulk. Omit clip_ids to apply to all.",
			inputSchema: {
				video_id: z.string().describe("Video id."),
				submission_id: z.string().describe("Submission id."),
				template_id: z.string().describe("Template id from list_templates."),
				clip_ids: z.array(z.string()).optional().describe("Specific clip ids. Omit to apply to all clips."),
			},
			outputSchema: OK_OUT,
			annotations: WRITES,
		},
		({ video_id, submission_id, template_id, clip_ids }) => run(() => api("POST", `/clips/${video_id}/submissions/${submission_id}/apply_template`, { template_id, clip_ids }), okWrap),
	);

	server.registerTool(
		"delete_clip",
		{
			title: "Delete a clip",
			description: "Delete a single generated clip.",
			inputSchema: { video_id: z.string().describe("Video id."), submission_id: z.string().describe("Submission id."), clip_id: z.string().describe("Clip id.") },
			outputSchema: OK_OUT,
			annotations: DESTRUCTIVE,
		},
		({ video_id, submission_id, clip_id }) => run(() => api("DELETE", `/clips/${video_id}/submissions/${submission_id}/clips/${clip_id}`), okWrap),
	);

	// ── Templates ──
	server.registerTool(
		"list_templates",
		{
			title: "List templates",
			description: "Editing templates to apply to clips. Use an id as template_id.",
			inputSchema: { ...PAGE, filter: z.string().optional().describe("Filter, e.g. 'mine' or 'community'."), sort: z.string().optional().describe("Sort order.") },
			outputSchema: { templates: z.array(z.object({ id: str, name: str })).optional().describe("Templates with id and name.") },
			annotations: READ_ONLY,
		},
		(a) =>
			run(
				() => api("GET", `/templates${qs(a)}`),
				(d) => ({ templates: isRecord(d) && Array.isArray(d.templates) ? d.templates.filter(isRecord).map((t) => project(t, ["id", "name"])) : [] }),
			),
	);

	// ── Renders ──
	server.registerTool(
		"render_clip",
		{
			title: "Render a clip",
			description: "Render a clip to a final MP4. Returns render_id (poll with get_render). download_url is included when served from cache.",
			inputSchema: { video_id: z.string().describe("Video id."), submission_id: z.string().describe("Submission id."), clip_id: z.string().describe("Clip id to render.") },
			outputSchema: { render_id: str, status: str, from_cache: boolO, download_url: str },
			annotations: WRITES,
		},
		({ video_id, submission_id, clip_id }) =>
			run(() => api("POST", `/clips/${video_id}/submissions/${submission_id}/clips/${clip_id}/render`), (d) => project(d, ["render_id", "status", "from_cache", "download_url"])),
	);

	server.registerTool(
		"list_renders",
		{
			title: "List renders",
			description: "Your render jobs.",
			inputSchema: { ...PAGE, status: z.string().optional().describe("Filter by status, e.g. 'completed'.") },
			outputSchema: RESULT_OUT,
			annotations: READ_ONLY,
		},
		(a) => run(() => api("GET", `/renders${qs(a)}`), wrapResult),
	);

	server.registerTool(
		"get_render_limits",
		{ title: "Get render quota", description: "Render quota and limits for the workspace.", inputSchema: {}, outputSchema: RESULT_OUT, annotations: READ_ONLY },
		() => run(() => api("GET", "/renders/limits"), wrapResult),
	);

	server.registerTool(
		"get_render",
		{
			title: "Get render status",
			description: "Poll a render until status is 'completed'.",
			inputSchema: { render_id: z.string().describe("Render id from render_clip.") },
			outputSchema: { status: str, progress: numO },
			annotations: READ_ONLY,
		},
		({ render_id }) => run(() => api("GET", `/renders/${render_id}`), (d) => project(d, ["status", "progress"])),
	);

	server.registerTool(
		"get_render_download",
		{
			title: "Get render download URL",
			description: "Signed download URL of a completed render.",
			inputSchema: { render_id: z.string().describe("Render id.") },
			outputSchema: { url: str, filename: str },
			annotations: READ_ONLY,
		},
		({ render_id }) => run(() => api("GET", `/renders/${render_id}/download`), (d) => project(d, ["url", "filename"])),
	);

	server.registerTool(
		"cancel_render",
		{
			title: "Cancel or delete a render",
			description: "Cancel an in-progress render or delete a finished one.",
			inputSchema: { render_id: z.string().describe("Render id.") },
			outputSchema: OK_OUT,
			annotations: DESTRUCTIVE,
		},
		({ render_id }) => run(() => api("DELETE", `/renders/${render_id}`), okWrap),
	);

	server.registerTool(
		"start_bulk_download",
		{
			title: "Start a bulk download",
			description: "Bundle several renders into one download. Returns a jobId to poll with get_bulk_download.",
			inputSchema: { render_ids: z.array(z.string()).describe("Render ids to bundle into one archive.") },
			outputSchema: RESULT_OUT,
			annotations: WRITES,
		},
		({ render_ids }) => run(() => api("POST", "/renders/bulk-download", { render_ids }), wrapResult),
	);

	server.registerTool(
		"get_bulk_download",
		{
			title: "Get bulk download status",
			description: "Poll a bulk download job until ready.",
			inputSchema: { job_id: z.string().describe("Job id from start_bulk_download.") },
			outputSchema: RESULT_OUT,
			annotations: READ_ONLY,
		},
		({ job_id }) => run(() => api("GET", `/renders/bulk-download/${job_id}`), wrapResult),
	);

	// ── Posts (publishing) ──
	server.registerTool(
		"create_post",
		{
			title: "Create a post",
			description: "Publish rendered clips to connected accounts. Each video has an editId (the render's edit_setting_id) and targets (connectionId + per-platform metadata). Set scheduled_at (ISO 8601) to schedule.",
			inputSchema: {
				videos: z
					.array(
						z.object({
							editId: z.string().describe("The render's edit_setting_id."),
							targets: z
								.array(
									z.object({
										connectionId: z.string().describe("Connection id from list_connections."),
										metadata: z.record(z.string(), z.unknown()).describe("Per-platform fields, e.g. { tiktok: { title, privacyLevel } }."),
									}),
								)
								.describe("One target per destination account."),
						}),
					)
					.describe("Clips to publish and where."),
				scheduled_at: z.string().optional().describe("ISO 8601 future time to schedule the post. Omit to publish now."),
			},
			outputSchema: { post_id: str, item_count: numO, status: str, scheduled_at: str },
			annotations: WRITES,
		},
		(args) => run(() => api("POST", "/posts", args), (d) => project(d, ["post_id", "item_count", "status", "scheduled_at"])),
	);

	server.registerTool(
		"list_posts",
		{
			title: "List posts",
			description: "Your posts.",
			inputSchema: { ...PAGE, status: z.string().optional().describe("Filter by status, e.g. 'completed'.") },
			outputSchema: RESULT_OUT,
			annotations: READ_ONLY,
		},
		(a) => run(() => api("GET", `/posts${qs(a)}`), wrapResult),
	);

	server.registerTool(
		"get_post",
		{
			title: "Get a post",
			description: "A post with its per-account items and statuses.",
			inputSchema: { id: z.string().describe("Post id.") },
			outputSchema: RESULT_OUT,
			annotations: READ_ONLY,
		},
		({ id }) => run(() => api("GET", `/posts/${id}`), wrapResult),
	);

	server.registerTool(
		"update_post",
		{
			title: "Update a post",
			description: "Update a pending post, e.g. reschedule or adjust items.",
			inputSchema: {
				id: z.string().describe("Post id."),
				scheduled_at: z.string().optional().describe("New ISO 8601 schedule time."),
				items: z.array(z.record(z.string(), z.unknown())).optional().describe("Updated post items."),
			},
			outputSchema: RESULT_OUT,
			annotations: WRITES,
		},
		({ id, ...body }) => run(() => api("PATCH", `/posts/${id}`, body), wrapResult),
	);

	server.registerTool(
		"publish_post",
		{
			title: "Publish a post now",
			description: "Trigger immediate publishing of a post.",
			inputSchema: { id: z.string().describe("Post id.") },
			outputSchema: OK_OUT,
			annotations: WRITES,
		},
		({ id }) => run(() => api("POST", `/posts/${id}/publish`), okWrap),
	);

	server.registerTool(
		"retry_post_item",
		{
			title: "Retry a failed item",
			description: "Retry a single failed post item without disturbing the others.",
			inputSchema: { id: z.string().describe("Post id."), item_id: z.string().describe("Post item id to retry.") },
			outputSchema: OK_OUT,
			annotations: WRITES,
		},
		({ id, item_id }) => run(() => api("POST", `/posts/${id}/items/${item_id}/retry`), okWrap),
	);

	server.registerTool(
		"delete_post_item",
		{
			title: "Delete a post item",
			description: "Remove a single item from a post.",
			inputSchema: { id: z.string().describe("Post id."), item_id: z.string().describe("Post item id to remove.") },
			outputSchema: OK_OUT,
			annotations: DESTRUCTIVE,
		},
		({ id, item_id }) => run(() => api("DELETE", `/posts/${id}/items/${item_id}`), okWrap),
	);

	server.registerTool(
		"delete_post",
		{
			title: "Delete a post",
			description: "Delete an entire post.",
			inputSchema: { id: z.string().describe("Post id.") },
			outputSchema: OK_OUT,
			annotations: DESTRUCTIVE,
		},
		({ id }) => run(() => api("DELETE", `/posts/${id}`), okWrap),
	);

	// ── Connections ──
	server.registerTool(
		"list_connections",
		{
			title: "List connections",
			description: "Connected social accounts. Use an id as connectionId in create_post.",
			inputSchema: { ...PAGE, platform: z.string().optional().describe("Filter by platform, e.g. 'tiktok'.") },
			outputSchema: RESULT_OUT,
			annotations: READ_ONLY,
		},
		(a) => run(() => api("GET", `/connections${qs(a)}`), wrapResult),
	);

	server.registerTool(
		"get_connection",
		{
			title: "Get a connection",
			description: "A single connected account.",
			inputSchema: { id: z.string().describe("Connection id.") },
			outputSchema: RESULT_OUT,
			annotations: READ_ONLY,
		},
		({ id }) => run(() => api("GET", `/connections/${id}`), wrapResult),
	);

	return server;
}

// ── Transport bootstrap ──────────────────────────────────────────────────────

/** API key for non-OAuth HTTP: Authorization: Bearer / X-Api-Key, env fallback. */
function bearerKey(req: Request): string | undefined {
	const auth = req.header("authorization");
	if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
	return req.header("x-api-key") ?? process.env.CUTPRO_API_KEY;
}

/** API key for OAuth HTTP: from the verified token's attached data. */
function authedKey(req: Request): string | undefined {
	const extra = req.auth?.extra;
	return typeof extra?.apiKey === "string" ? extra.apiKey : undefined;
}

function cors(): RequestHandler {
	return (req, res, next) => {
		res.header("Access-Control-Allow-Origin", req.header("origin") ?? "*");
		res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
		res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-session-id, mcp-protocol-version");
		res.header("Access-Control-Expose-Headers", "mcp-session-id, WWW-Authenticate");
		if (req.method === "OPTIONS") {
			res.sendStatus(204);
			return;
		}
		next();
	};
}

async function startHttp(port: number): Promise<void> {
	const app = express();
	app.use(cors());

	const oauth = process.env.MCP_OAUTH === "1";
	let guard: RequestHandler | undefined;
	if (oauth) {
		// MCP_PUBLIC_URL is the public MCP endpoint, e.g. https://mcp.cut.pro.
		// The resource server is that URL; the authorization server is its origin.
		const resourceServerUrl = new URL(process.env.MCP_PUBLIC_URL ?? `http://localhost:${port}`);
		const issuerUrl = new URL(resourceServerUrl.origin);
		const redisUrl = process.env.MCP_REDIS_URL;
		const kv = redisUrl ? await createRedisKV(redisUrl, "mcp:oauth:") : createMemoryKV();
		process.stderr.write(`CutPro MCP OAuth store: ${redisUrl ? "redis" : "in-memory"}\n`);
		const provider = new CutproOAuthProvider(BASE_URL, kv);
		app.use(mcpAuthRouter({ provider, issuerUrl, resourceServerUrl, resourceName: "CutPro", scopesSupported: ["cutpro"] }));
		app.post("/oauth/consent", express.urlencoded({ extended: false }), (req, res) => void provider.handleConsent(req, res));
		guard = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl) });
	}

	const mcp: RequestHandler = (req, res) => {
		const apiKey = oauth ? authedKey(req) : bearerKey(req);
		if (!apiKey) {
			res.status(401).json({ error: "Missing API key" });
			return;
		}
		const server = buildServer({ apiKey, workspaceId: req.header("x-workspace-id") ?? process.env.CUTPRO_WORKSPACE_ID });
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
		res.on("close", () => {
			void transport.close();
			void server.close();
		});
		server
			.connect(transport)
			.then(() => transport.handleRequest(req, res, req.body))
			.catch((e: unknown) => {
				if (!res.headersSent) res.status(500).json({ error: e instanceof Error ? e.message : "error" });
			});
	};

	const chain: RequestHandler[] = guard ? [express.json(), guard, mcp] : [express.json(), mcp];
	app.post("/", ...chain);

	app.listen(port, () => process.stderr.write(`CutPro MCP (HTTP${oauth ? " + OAuth" : ""}) on http://localhost:${port}/\n`));
}

async function startStdio(): Promise<void> {
	const apiKey = process.env.CUTPRO_API_KEY;
	if (!apiKey) {
		process.stderr.write("CUTPRO_API_KEY is not set. Generate one at https://cut.pro/studio/me/api-keys\n");
		process.exit(1);
	}
	const server = buildServer({ apiKey, workspaceId: process.env.CUTPRO_WORKSPACE_ID });
	await server.connect(new StdioServerTransport());
}

if (process.env.MCP_TRANSPORT === "http" || process.env.PORT) {
	await startHttp(Number(process.env.PORT ?? 8787));
} else {
	await startStdio();
}
