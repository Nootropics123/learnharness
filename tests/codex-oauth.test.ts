import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { OAuthAuth } from "@earendil-works/pi-ai";
import { createCodexOAuthAdapter } from "../src/auth/codex-oauth.ts";
import { catalogProviders, modelCatalog } from "../src/server/model-catalog.ts";

function tempAuth(credential?: Record<string, unknown>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-codex-oauth-"));
	const file = path.join(dir, "auth.json");
	if (credential) fs.writeFileSync(file, JSON.stringify({ "openai-codex": credential }));
	return { dir, file };
}

function codexToken(value: string) {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" }, value })).toString("base64url")}.signature`;
}

describe("Codex OAuth adapter", () => {
	it("reads Pi credentials, refreshes expired OAuth, persists it, and authenticates a mocked fetch", async () => {
		const { dir, file } = tempAuth({ type: "oauth", access: codexToken("expired"), refresh: "refresh-1", expires: 0 });
		let refreshes = 0;
		const oauth: OAuthAuth = {
			name: "fake Codex",
			async login() { throw new Error("not used"); },
			async refresh(credential) {
				refreshes++;
				return { ...credential, access: codexToken("fresh"), refresh: "refresh-2", expires: Date.now() + 60 * 60_000 };
			},
			async toAuth(credential) { return { apiKey: credential.access }; },
		};
		const adapter = createCodexOAuthAdapter({ authFile: file, oauth });
		const auth = await adapter.getAuth();
		assert.equal(auth.auth.apiKey, codexToken("fresh"));
		assert.equal(refreshes, 1);
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["openai-codex"].access, codexToken("fresh"));
		const model = adapter.models.getModel("openai-codex", "gpt-6-luna");
		assert.ok(model);
		let request: Request | undefined;
		const fetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			request = new Request(input, init);
			return new Response('{"error":{"message":"fixture"}}', { status: 400, headers: { "content-type": "application/json" } });
		};
		const result = await adapter.stream(model!, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }).result();
		globalThis.fetch = fetch;
		assert.ok(request, "Codex request should use the mocked fetch");
		assert.equal(request.headers.get("chatgpt-account-id"), "fixture-account");
		assert.equal(result.stopReason, "error");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("resolves auth.json from PI_CODING_AGENT_DIR unless an explicit path is supplied", () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-coding-agent-fixture";
		try {
			assert.equal(createCodexOAuthAdapter().authFile, "/tmp/pi-coding-agent-fixture/auth.json");
			assert.equal(createCodexOAuthAdapter({ authFile: "/tmp/explicit-codex-auth.json" }).authFile, "/tmp/explicit-codex-auth.json");
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});

	it("federates Codex models into the picker when Pi OAuth is present", () => {
		const { dir, file } = tempAuth({ type: "oauth", access: "access", refresh: "refresh", expires: 0 });
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			assert.equal(catalogProviders().find((provider) => provider.id === "openai-codex")?.keyPresent, true);
			assert.ok(modelCatalog().models.some((model) => model.provider === "openai-codex"));
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
		void file;
	});

	it("reports the same clear error for a missing or unrefreshable credential file", async () => {
		const missing = tempAuth();
		await assert.rejects(createCodexOAuthAdapter({ authFile: missing.file }).getAuth(), /Codex OAuth unavailable/);
		const expired = tempAuth({ type: "oauth", access: "expired", refresh: "refresh", expires: 0 });
		const oauth: OAuthAuth = {
			name: "fake Codex",
			async login() { throw new Error("not used"); },
			async refresh() { throw new Error("refresh rejected"); },
			async toAuth(credential) { return { apiKey: credential.access }; },
		};
		await assert.rejects(createCodexOAuthAdapter({ authFile: expired.file, oauth }).getAuth(), /Codex OAuth unavailable/);
		fs.rmSync(missing.dir, { recursive: true, force: true });
		fs.rmSync(expired.dir, { recursive: true, force: true });
	});
});
