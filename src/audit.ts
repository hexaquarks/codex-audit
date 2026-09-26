import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

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

type JsonObject = Record<string, unknown>;
interface ParsedEvent {
    type: string; // Codex event category.
    timestamp: string; // Event timestamp in ISO-8601 UTC.
    payload: JsonObject; // Untyped event data needed by the parser.
}

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

const isJsonObject = (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null;

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

export const sumUsage = (sessions: readonly Pick<SessionSummary, keyof TokenUsage>[]): TokenUsage =>
    sessions.reduce(
        (total, next) => ({
            inputTokens: total.inputTokens + next.inputTokens,
            cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
            cacheWriteInputTokens: total.cacheWriteInputTokens + next.cacheWriteInputTokens,
            outputTokens: total.outputTokens + next.outputTokens,
            reasoningOutputTokens: total.reasoningOutputTokens + next.reasoningOutputTokens,
            totalTokens: total.totalTokens + next.totalTokens,
        }),
        emptyUsage(),
    );

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

const measureOutputBytes = (value: unknown): number =>
    Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "");

const commandMayEditFiles = (name: string, arguments_: string): boolean =>
    /(?:apply_patch|write_file|edit_file|replace|create_file)/i.test(name)
    || (/(?:^|\s)(?:sed\s+-i|perl\s+-i|tee\b|cp\b|mv\b)/.test(arguments_)
        && !/\bcat\b/.test(arguments_));

const toolOutputIndicatesFailure = (output: unknown): boolean =>
    /"exit_code"\s*:\s*[1-9]\d*|\b(command failed|error:|not found|permission denied)\b/i.test(
        typeof output === "string" ? output : JSON.stringify(output) ?? "",
    );

const readToolRecord = (event: ParsedEvent): ToolCall | undefined => {
    if (event.type !== "response_item") return undefined;
    const itemType = event.payload.type;

    if ((itemType === "custom_tool_call" || itemType === "function_call") && typeof event.payload.name === "string") {
        const arguments_ = typeof event.payload.arguments === "string"
            ? event.payload.arguments
            : typeof event.payload.input === "string"
                ? event.payload.input
                : "";
        const callId = typeof event.payload.call_id === "string" ? event.payload.call_id : "";

        return {
            timestamp: event.timestamp,
            name: event.payload.name,
            callId,
            fingerprint: `${event.payload.name}:${arguments_}`,
            failed: event.payload.status === "failed",
            editsFiles: commandMayEditFiles(event.payload.name, arguments_),
        };
    }

    if (
        (itemType === "custom_tool_call_output" || itemType === "function_call_output")
        && typeof event.payload.call_id === "string"
    ) {
        return {
            timestamp: event.timestamp,
            name: "(tool output)",
            callId: event.payload.call_id,
            fingerprint: "",
            outputBytes: measureOutputBytes(event.payload.output),
            failed: toolOutputIndicatesFailure(event.payload.output),
            editsFiles: false,
        };
    }

    return undefined;
};

const attachToolOutputs = (records: readonly ToolCall[]): ToolCall[] => {
    const callIndexesById = new Map<string, number>();
    const calls: ToolCall[] = [];

    for (const record of records) {
        if (record.outputBytes === undefined) {
            callIndexesById.set(record.callId, calls.length);
            calls.push(record);
            continue;
        }

        const callIndex = callIndexesById.get(record.callId);
        if (callIndex === undefined) continue;

        const call = calls[callIndex];
        calls[callIndex] = {
            ...call,
            outputBytes: record.outputBytes,
            failed: call.failed || record.failed,
        };
    }

    return calls;
};

export const parseSession = async (file: string): Promise<SessionSummary | null> => {
    const events: ParsedEvent[] = [];
    let malformedLines = 0;

    for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
        if (!line.trim()) continue;

        try {
            const event: unknown = JSON.parse(line);
            if (!isJsonObject(event) || !isJsonObject(event.payload)) {
                malformedLines += 1;
                continue;
            }

            events.push({
                type: typeof event.type === "string" ? event.type : "",
                timestamp: typeof event.timestamp === "string" ? event.timestamp : "",
                payload: event.payload,
            });
        } catch {
            // Active Codex sessions may end with a partially written line.
            malformedLines += 1;
        }
    }

    let projectPath = "(unknown)";
    let project = "(unknown)";
    let model = "(unknown)";
    let sessionId = path.basename(file);
    let parentSessionId: string | undefined;
    let lastActivity = "";
    let totalUsage: TokenUsage | undefined;
    let latestActiveContext: TokenUsage | undefined;
    let modelContextWindow: number | undefined;
    let userTurn = 0;
    const turns: TurnUsage[] = [];
    const toolRecords: ToolCall[] = [];
    const pendingToolCalls: ToolCall[] = [];

    for (const event of events) {
        if (event.timestamp > lastActivity) lastActivity = event.timestamp;

        if (event.type === "session_meta") {
            if (typeof event.payload.cwd === "string") {
                projectPath = event.payload.cwd;
                project = path.basename(projectPath) || projectPath;
            }

            if (typeof event.payload.id === "string") sessionId = event.payload.id;

            for (const key of ["parent_session_id", "parentSessionId", "forked_from", "source_session_id"]) {
                if (typeof event.payload[key] === "string") {
                    parentSessionId = event.payload[key] as string;
                }
            }
        }

        if (event.type === "turn_context" && typeof event.payload.model === "string") model = event.payload.model;
        if (event.type === "response_item" && event.payload.type === "message" && event.payload.role === "user") userTurn += 1;

        const toolRecord = readToolRecord(event);
        if (toolRecord) {
            toolRecords.push(toolRecord);

            if (toolRecord.outputBytes === undefined) {
                pendingToolCalls.push(toolRecord);
            }
        }

        // Older log format: each record is already a per-response usage snapshot.
        if (event.type === "token_usage_record") {
            const usage = readUsage(event.payload.usage);
            totalUsage = usage;
            latestActiveContext = usage;
            turns.push({ timestamp: event.timestamp, userTurn, usage, tools: pendingToolCalls.splice(0) });
        }

        if (event.type === "event_msg" && event.payload.type === "token_count" && isJsonObject(event.payload.info)) {
            const info = event.payload.info;
            totalUsage = readUsage(info.total_token_usage);
            latestActiveContext = readUsage(info.last_token_usage);

            if (toFiniteNumber(info.model_context_window) > 0) modelContextWindow = toFiniteNumber(info.model_context_window);
            turns.push({ timestamp: event.timestamp, userTurn, usage: latestActiveContext, tools: pendingToolCalls.splice(0) });
        }
    }

    if (!totalUsage) return null;

    const tools = attachToolOutputs(toolRecords);
    const callsById = new Map(tools.map((tool) => [tool.callId, tool]));
    const turnsWithToolResults = turns.map((turn) => ({
        ...turn,
        tools: turn.tools
            .map((tool) => callsById.get(tool.callId) ?? tool),
    }));

    return {
        file: path.basename(file),
        sessionId,
        parentSessionId,
        project,
        projectPath,
        model,
        lastActivity,
        usageRecords: turns.length,
        malformedLines,
        modelContextWindow,
        latestActiveContext,
        turns: turnsWithToolResults,
        tools,
        ...totalUsage,
    };
};

export const readSessionSummaries = async (directory: string): Promise<SessionSummary[]> => {
    const files = await findSessionFiles(directory);
    const summaries = await Promise.all(files.map(parseSession));

    return summaries
        .filter((summary): summary is SessionSummary => summary !== null)
        .filter((summary) => !summary.parentSessionId)
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
};
