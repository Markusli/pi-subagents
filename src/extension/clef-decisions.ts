import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MODEL = "clef";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_QUESTIONS = 32;

const JsonContainer = Type.Union([
	Type.String(),
	Type.Record(Type.String(), Type.Any()),
	Type.Array(Type.Any()),
]);

const NoulQuestion = Type.Object({
	type: Type.Literal("noul"),
	instructions: JsonContainer,
	criteria: Type.Optional(Type.Record(Type.String(), JsonContainer)),
});

const ChoiceQuestion = Type.Object({
	type: Type.Literal("choice"),
	instructions: JsonContainer,
	criteria: Type.Record(Type.String(), Type.Union([JsonContainer, Type.Null()])),
});

const ScoreQuestion = Type.Object({
	type: Type.Literal("score"),
	instructions: JsonContainer,
	criteria: Type.Array(JsonContainer, { minItems: 2, maxItems: 10 }),
});

const Question = Type.Union([NoulQuestion, ChoiceQuestion, ScoreQuestion]);

type QuestionLike = {
	type: "noul" | "choice" | "score";
	instructions: unknown;
	criteria?: unknown;
};

type ClefResponse = {
	success?: unknown;
	errors?: unknown;
	result?: {
		answers?: Record<string, unknown>;
		usage?: { input_tokens?: unknown; output_tokens?: unknown };
	};
};

function assertQuestions(questions: Record<string, QuestionLike>): void {
	const entries = Object.entries(questions);
	if (entries.length === 0) throw new Error("clef_decide requires at least one question.");
	if (entries.length > MAX_QUESTIONS) {
		throw new Error(`clef_decide accepts at most ${MAX_QUESTIONS} questions per request.`);
	}
	for (const [id, question] of entries) {
		if (!id.trim()) throw new Error("Clef question ids must not be blank.");
		if (question.type === "choice") {
			if (!question.criteria || typeof question.criteria !== "object" || Array.isArray(question.criteria)) {
				throw new Error(`Clef choice question '${id}' requires object criteria.`);
			}
			const count = Object.keys(question.criteria as Record<string, unknown>).length;
			if (count < 1 || count > 255) {
				throw new Error(`Clef choice question '${id}' must have 1-255 options.`);
			}
		}
	}
}

function assertResponse(payload: ClefResponse, questions: Record<string, QuestionLike>): void {
	if (payload.success !== true) throw new Error("Cloudflare Clef response did not report success.");
	const answers = payload.result?.answers;
	if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
		throw new Error("Cloudflare Clef response is missing answers.");
	}
	const expected = Object.keys(questions).sort();
	const actual = Object.keys(answers).sort();
	if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
		throw new Error("Cloudflare Clef response answers do not match the requested question ids.");
	}
	const inputTokens = payload.result?.usage?.input_tokens;
	if (!Number.isInteger(inputTokens) || (inputTokens as number) < 0) {
		throw new Error("Cloudflare Clef response is missing a valid input-token count.");
	}
}

function shouldRetry(status: number): boolean {
	return status === 429 || status === 502 || status === 503 || status === 504;
}

async function callClef(
	accountId: string,
	apiToken: string,
	state: unknown,
	questions: Record<string, QuestionLike>,
	signal?: AbortSignal,
): Promise<ClefResponse> {
	const body = JSON.stringify({ model: MODEL, state, questions });
	if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
		throw new Error(`Clef request exceeds the local ${MAX_REQUEST_BYTES}-byte safety cap.`);
	}
	const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${MODEL}`;

	let lastError: Error | undefined;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiToken}`,
					"Content-Type": "application/json",
				},
				body,
				signal: requestSignal,
			});
			const raw = await response.text();
			let payload: ClefResponse;
			try {
				payload = raw ? JSON.parse(raw) as ClefResponse : {};
			} catch {
				throw new Error(`Cloudflare Clef returned non-JSON HTTP ${response.status}.`);
			}
			if (!response.ok) {
				const error = new Error(`Cloudflare Clef HTTP ${response.status}: ${raw.slice(0, 1000)}`);
				if (attempt === 0 && shouldRetry(response.status)) {
					lastError = error;
					await new Promise((resolve) => setTimeout(resolve, 250));
					continue;
				}
				throw error;
			}
			return payload;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt === 0 && lastError.name !== "AbortError") {
				await new Promise((resolve) => setTimeout(resolve, 250));
				continue;
			}
			throw lastError;
		}
	}
	throw lastError ?? new Error("Cloudflare Clef request failed.");
}

export function registerClefDecisions(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "clef_decide",
		label: "Clef decide",
		description:
			"Ask Cloudflare full Clef narrow typed decision questions over shared text/JSON state. Prefer it for semantic lane-coupling/decision-independence ambiguity; treat results as advisory evidence, not routing authority.",
		parameters: Type.Object({
			state: JsonContainer,
			questions: Type.Record(Type.String(), Question),
		}),
		async execute(_toolCallId, params, signal) {
			const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
			const apiToken = process.env.CLOUDFLARE_WORKERS_API_TOKEN?.trim();
			if (!accountId || !apiToken) {
				throw new Error(
					"Cloudflare Workers AI credentials are unavailable in this Pi process. "
					+ "Ensure CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_WORKERS_API_TOKEN are exported before launching Pi.",
				);
			}
			const questions = params.questions as Record<string, QuestionLike>;
			assertQuestions(questions);
			const payload = await callClef(accountId, apiToken, params.state, questions, signal);
			assertResponse(payload, questions);
			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						model: `@cf/cloudflare/${MODEL}`,
						answers: payload.result?.answers,
						usage: payload.result?.usage,
					}, null, 2),
				}],
				details: {
					model: `@cf/cloudflare/${MODEL}`,
					usage: payload.result?.usage,
				},
			};
		},
	});
}
