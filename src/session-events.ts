import type { TokenUsage, ToolCall } from "./audit.js";
import { isJsonObject, type JsonObject, type ParsedEvent } from "./session-log.js";

export interface SessionMetadata {
	projectPath?: string; // Working directory recorded when the session began.
	sessionId?: string; // Stable Codex identifier for the session.
	parentSessionId?: string; // Identifier of the session this one was forked from.
}

export interface ToolResult {
	callId: string; // ID of the earlier tool call that produced this result.
	outputBytes: number; // Size of the recorded result text in bytes.
	failed: boolean; // Whether the result contains a recognizable failure signal.
}

export interface ToolCallEvent {
	kind: "call"; // Distinguishes this record from a later tool result.
	call: ToolCall; // Tool invocation recorded before its result arrives.
}

export interface ToolResultEvent {
	kind: "result"; // Distinguishes this record from the preceding tool call.
	result: ToolResult; // Result that belongs to an earlier tool call.
}

export type ToolEvent = ToolCallEvent | ToolResultEvent;

export interface UsageSnapshot {
	usage: TokenUsage; // Cumulative token counts at the time of this event.
	activeContext: TokenUsage; // Context use for the latest model response.
	modelContextWindow?: number; // Maximum context capacity, when reported.
}

const fileEditingToolNames = new Set([
	"apply_patch",
	"write_file",
	"edit_file",
	"replace",
	"create_file",
]);

const emptyUsage = (): TokenUsage => ({
	inputTokens: 0,
	cachedInputTokens: 0,
	cacheWriteInputTokens: 0,
	outputTokens: 0,
	reasoningOutputTokens: 0,
	totalTokens: 0,
});

const toFiniteNumber = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;

const readUsage = (value: unknown): TokenUsage => {
	if (!isJsonObject(value)) return emptyUsage();

	return {
		inputTokens: toFiniteNumber(value.input_tokens),
		cachedInputTokens: toFiniteNumber(value.cached_input_tokens),
		cacheWriteInputTokens: toFiniteNumber(value.cache_write_input_tokens),
		outputTokens: toFiniteNumber(value.output_tokens),
		reasoningOutputTokens: toFiniteNumber(value.reasoning_output_tokens),
		totalTokens: toFiniteNumber(value.total_tokens),
	};
};

const isResponseItem = (event: ParsedEvent): boolean => event.type === "response_item";

/** Identifies messages that advance the user-turn count. */
export const isUserMessage = (event: ParsedEvent): boolean =>
	isResponseItem(event) && event.payload.type === "message" && event.payload.role === "user";

/** Extracts readable user text from the message blocks used in current logs. */
export const readUserRequest = (event: ParsedEvent): string | undefined => {
	if (!isUserMessage(event) || !Array.isArray(event.payload.content)) return undefined;

	const requestText = event.payload.content
		.filter(isJsonObject)
		.filter((part) => part.type === "input_text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");

	return requestText || undefined;
};

const readToolInput = (payload: JsonObject): string => {
	if (typeof payload.arguments === "string") return payload.arguments;
	if (typeof payload.input === "string") return payload.input;

	return "";
};

const isToolCall = (itemType: unknown): boolean =>
	itemType === "custom_tool_call" || itemType === "function_call";

const isToolResult = (itemType: unknown): boolean =>
	itemType === "custom_tool_call_output" || itemType === "function_call_output";

const isInPlaceEditor = (command: string): boolean => /(?:^|\s)(?:sed|perl)\s+-i\b/.test(command);

const copiesOrMovesFiles = (command: string): boolean => /(?:^|\s)(?:tee|cp|mv)\b/.test(command);

const commandMayEditFiles = (name: string, input: string): boolean => {
	if (fileEditingToolNames.has(name.toLowerCase())) return true;

	const readsWithCat = /\bcat\b/.test(input);
	const changesFiles = isInPlaceEditor(input) || copiesOrMovesFiles(input);

	return changesFiles && !readsWithCat;
};

const outputText = (output: unknown): string =>
	typeof output === "string" ? output : (JSON.stringify(output) ?? "");

const hasNonZeroExitCode = (output: string): boolean => /"exit_code"\s*:\s*[1-9]\d*/.test(output);

const containsFailureMessage = (output: string): boolean =>
	/\b(command failed|error:|not found|permission denied)\b/i.test(output);

const toolOutputIndicatesFailure = (output: unknown): boolean => {
	const text = outputText(output);

	return hasNonZeroExitCode(text) || containsFailureMessage(text);
};

/** Reads either side of a tool call/result pair from a response-item event. */
export const readToolEvent = (event: ParsedEvent, requestText: string): ToolEvent | undefined => {
	if (!isResponseItem(event)) return undefined;

	const { payload } = event;
	if (isToolCall(payload.type) && typeof payload.name === "string") {
		const input = readToolInput(payload);
		const callId = typeof payload.call_id === "string" ? payload.call_id : "";

		return {
			kind: "call",
			call: {
				timestamp: event.timestamp,
				name: payload.name,
				callId,
				fingerprint: `${payload.name}:${input}`,
				input,
				requestText,
				failed: payload.status === "failed",
				editsFiles: commandMayEditFiles(payload.name, input),
			},
		};
	}

	if (isToolResult(payload.type) && typeof payload.call_id === "string") {
		return {
			kind: "result",
			result: {
				callId: payload.call_id,
				outputBytes: Buffer.byteLength(outputText(payload.output)),
				failed: toolOutputIndicatesFailure(payload.output),
			},
		};
	}

	return undefined;
};

const readParentSessionId = (payload: JsonObject): string | undefined => {
	const parentIdKeys = [
		"parent_session_id",
		"parentSessionId",
		"forked_from",
		"source_session_id",
	];

	for (const key of parentIdKeys) {
		if (typeof payload[key] === "string") return payload[key];
	}

	return undefined;
};

/** Reads project and lineage metadata from the session's opening event. */
export const readSessionMetadata = (event: ParsedEvent): SessionMetadata | undefined => {
	if (event.type !== "session_meta") return undefined;

	return {
		projectPath: typeof event.payload.cwd === "string" ? event.payload.cwd : undefined,
		sessionId: typeof event.payload.id === "string" ? event.payload.id : undefined,
		parentSessionId: readParentSessionId(event.payload),
	};
};

/** Reads the model name from a turn-context event. */
export const readModel = (event: ParsedEvent): string | undefined => {
	if (event.type !== "turn_context") return undefined;

	return typeof event.payload.model === "string" ? event.payload.model : undefined;
};

/** Supports both legacy usage records and current token-count events. */
export const readUsageSnapshot = (event: ParsedEvent): UsageSnapshot | undefined => {
	if (event.type === "token_usage_record") {
		const usage = readUsage(event.payload.usage);

		return { usage, activeContext: usage };
	}

	const isTokenCount = event.type === "event_msg" && event.payload.type === "token_count";
	if (!isTokenCount || !isJsonObject(event.payload.info)) return undefined;

	const contextWindow = toFiniteNumber(event.payload.info.model_context_window);

	return {
		usage: readUsage(event.payload.info.total_token_usage),
		activeContext: readUsage(event.payload.info.last_token_usage),
		modelContextWindow: contextWindow > 0 ? contextWindow : undefined,
	};
};
