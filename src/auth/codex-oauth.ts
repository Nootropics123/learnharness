import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	Credential,
	CredentialInfo,
	CredentialStore,
	OAuthAuth,
	Provider,
	AuthResult,
	AuthOperationOptions,
} from "@earendil-works/pi-ai";
import { createModels, type Models, type Model, type Api, type ModelsSimpleStreamOptions, type Context } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

const PROVIDER_ID = "openai-codex";
const DEFAULT_AUTH_FILE = path.join(".pi", "agent", "auth.json");

export interface CodexOAuthOptions {
	/** Pi's auth.json path. Takes precedence over PI_CODING_AGENT_DIR. */
	authFile?: string;
	/** Injectable for integration tests; production uses Pi's provider OAuth. */
	oauth?: OAuthAuth;
}

export function codexAuthFile(authFile?: string): string {
	if (authFile) return path.resolve(authFile);
	if (process.env.PI_CODING_AGENT_DIR) return path.resolve(process.env.PI_CODING_AGENT_DIR, "auth.json");
	return path.join(os.homedir(), DEFAULT_AUTH_FILE);
}

function isCredential(value: unknown): value is Credential {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.type === "api_key") {
		return (candidate.key === undefined || typeof candidate.key === "string") &&
			(candidate.env === undefined || (typeof candidate.env === "object" && candidate.env !== null && !Array.isArray(candidate.env)));
	}
	return candidate.type === "oauth" &&
		typeof candidate.access === "string" &&
		typeof candidate.refresh === "string" &&
		typeof candidate.expires === "number" &&
		Number.isFinite(candidate.expires);
}

/**
 * The Pi coding-agent auth.json format, kept separate from LearnHarness's
 * flat auth.json key store. Writes are serialized per provider like Pi's
 * CredentialStore contract.
 */
export class CodexOAuthCredentialStore implements CredentialStore {
	private readonly file: string;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(authFile?: string) {
		this.file = codexAuthFile(authFile);
	}

	private readFile(): Record<string, Credential> {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
			const result: Record<string, Credential> = {};
			for (const [provider, credential] of Object.entries(parsed)) {
				if (!isCredential(credential)) throw new Error(`invalid credential for ${provider}`);
				result[provider] = credential;
			}
			return result;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error(`Failed to read Codex OAuth credentials: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private write(data: Record<string, Credential>): void {
		const dir = path.dirname(this.file);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const temporary = `${this.file}.tmp-${process.pid}`;
		fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.chmodSync(temporary, 0o600);
		fs.renameSync(temporary, this.file);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const credential = this.readFile()[providerId];
		options?.signal?.throwIfAborted();
		return credential ? structuredClone(credential) : undefined;
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(this.readFile()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const previous = this.chain;
		let result: Credential | undefined;
		const operation = (async () => {
			await previous;
			options?.signal?.throwIfAborted();
			const data = this.readFile();
			const next = await fn(data[providerId] ? structuredClone(data[providerId]) : undefined);
			options?.signal?.throwIfAborted();
			if (next) data[providerId] = next;
			else delete data[providerId];
			this.write(data);
			result = next;
		})();
		this.chain = operation.catch(() => undefined);
		await operation;
		return result;
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.modify(providerId, async () => undefined, options);
	}
}

export interface CodexOAuthAdapter {
	readonly authFile: string;
	readonly credentials: CodexOAuthCredentialStore;
	readonly models: Models;
	getAuth(signal?: AbortSignal): Promise<AuthResult>;
	stream(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): ReturnType<Models["streamSimple"]>;
}

export function createCodexOAuthAdapter(options: CodexOAuthOptions = {}): CodexOAuthAdapter {
	const authFile = codexAuthFile(options.authFile);
	const credentials = new CodexOAuthCredentialStore(authFile);
	const builtin = openaiCodexProvider();
	const provider: Provider = options.oauth
		? { ...builtin, auth: { ...builtin.auth, oauth: options.oauth } }
		: builtin;
	const models = createModels({ credentials });
	models.setProvider(provider);
	return {
		authFile,
		credentials,
		models,
		async getAuth(signal) {
			try {
				const auth = await models.getAuth(PROVIDER_ID, { signal });
				if (!auth) throw new Error("credential file is missing or contains no Codex OAuth credential");
				return auth;
			} catch (error) {
				throw new Error("Codex OAuth unavailable", { cause: error });
			}
		},
		stream(model, context, streamOptions) {
			return models.streamSimple(model, context, streamOptions);
		},
	};
}
