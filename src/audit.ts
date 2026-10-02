import { readdir } from "node:fs/promises";
import path from "node:path";
import { parseSession } from "./session-parser.js";

export interface TokenUsage {
	inputTokens: number; // Tokens supplied to the model, including cached input.
	cachedInputTokens: number; // Input tokens served from the cache.
	cacheWriteInputTokens: number; // Input tokens written to the cache.
	outputTokens: number; // Tokens generated for the response.
	reasoningOutputTokens: number; // Reasoning tokens generated for the response.
	totalTokens: number; // Provider-reported total token usage.
}

export interface ToolCall {
	timestamp: string; // When Codex recorded the tool call.
	name: string; // Tool name without its arguments.
	callId: string; // ID shared by the call and its output record.
	fingerprint: string; // Stable name-and-arguments key used for repeat detection.
	input?: string; // Exact local tool input, such as a command or file target.
	requestText?: string; // Nearest preceding local user request when the log provides it.
	outputBytes?: number; // Logged result size, when a result was recorded.
	failed: boolean; // Whether the call or its output indicates failure.
	editsFiles: boolean; // Whether the call is likely to edit workspace files.
}

export interface TurnUsage {
	timestamp: string; // When this usage snapshot was recorded.
	userTurn: number; // One-based user message number within the session.
	usage: TokenUsage; // Token usage for this model call.
	tools: ToolCall[]; // Tool calls observed since the preceding usage snapshot.
}

export interface SessionSummary extends TokenUsage {
	file: string; // JSONL filename, without exposing its full path.
	sessionId: string; // Codex session identifier.
	parentSessionId?: string; // Parent ID when this session was forked.
	project: string; // Display name derived from the session working directory.
	projectPath: string; // Working directory used to group related sessions.
	model: string; // Last model identifier recorded for the session.
	lastActivity: string; // Most recent event timestamp.
	usageRecords: number; // Number of usage snapshots found in the log.
	malformedLines: number; // JSONL records skipped because they could not be parsed.
	modelContextWindow?: number; // Reported model context capacity.
	latestActiveContext?: TokenUsage; // Usage from the latest model call.
	turns: TurnUsage[]; // Usage snapshots with nearby tool activity.
	tools: ToolCall[]; // Normalized tool calls for the entire session.
}

const emptyUsage = (): TokenUsage => ({
	inputTokens: 0,
	cachedInputTokens: 0,
	cacheWriteInputTokens: 0,
	outputTokens: 0,
	reasoningOutputTokens: 0,
	totalTokens: 0,
});

/** Combines cumulative usage totals from separate sessions. */
export const sumUsage = (sessions: Pick<SessionSummary, keyof TokenUsage>[]): TokenUsage =>
	sessions.reduce(
		(total, session) => ({
			inputTokens: total.inputTokens + session.inputTokens,
			cachedInputTokens: total.cachedInputTokens + session.cachedInputTokens,
			cacheWriteInputTokens: total.cacheWriteInputTokens + session.cacheWriteInputTokens,
			outputTokens: total.outputTokens + session.outputTokens,
			reasoningOutputTokens: total.reasoningOutputTokens + session.reasoningOutputTokens,
			totalTokens: total.totalTokens + session.totalTokens,
		}),
		emptyUsage(),
	);

/** Finds session logs below Codex's date-based directory structure. */
const findSessionFiles = async (directory: string): Promise<string[]> => {
	const entries = await readdir(directory, { withFileTypes: true });
	const filesByEntry = await Promise.all(
		entries.map(async (entry) => {
			const entryPath = path.join(directory, entry.name);

			if (entry.isDirectory()) return findSessionFiles(entryPath);
			return entry.isFile() && entry.name.endsWith(".jsonl") ? [entryPath] : [];
		}),
	);

	return filesByEntry.flat();
};

/** Reads root sessions in reverse activity order, excluding forked child logs. */
export const readSessionSummaries = async (directory: string): Promise<SessionSummary[]> => {
	const files = await findSessionFiles(directory);
	const summaries = await Promise.all(files.map(parseSession));

	return summaries
		.filter((summary): summary is SessionSummary => summary !== null)
		.filter((summary) => !summary.parentSessionId)
		.sort((first, second) => second.lastActivity.localeCompare(first.lastActivity));
};

export { parseSession };
