import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface TokenUsage {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
    readonly totalTokens: number;
}

export interface SessionSummary extends TokenUsage {
    readonly file: string;
    readonly project: string;
    readonly model: string;
    readonly lastActivity: string;
    readonly usageRecords: number;
    readonly malformedLines: number;
}

const createEmptyTokenUsage = (): TokenUsage => ({
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
});

type JsonObject = Record<string, unknown>;

const toFiniteNumber = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

const readTokenUsage = (usageRecord: JsonObject): TokenUsage => ({
    inputTokens: toFiniteNumber(usageRecord.input_tokens),
    cachedInputTokens: toFiniteNumber(usageRecord.cached_input_tokens),
    cacheWriteInputTokens: toFiniteNumber(usageRecord.cache_write_input_tokens),
    outputTokens: toFiniteNumber(usageRecord.output_tokens),
    reasoningOutputTokens: toFiniteNumber(usageRecord.reasoning_output_tokens),
    totalTokens: toFiniteNumber(usageRecord.total_tokens),
});

const addTokenUsage = (current: TokenUsage, additional: TokenUsage): TokenUsage => ({
    inputTokens: current.inputTokens + additional.inputTokens,
    cachedInputTokens: current.cachedInputTokens + additional.cachedInputTokens,
    cacheWriteInputTokens: current.cacheWriteInputTokens + additional.cacheWriteInputTokens,
    outputTokens: current.outputTokens + additional.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens + additional.reasoningOutputTokens,
    totalTokens: current.totalTokens + additional.totalTokens,
});

const isJsonObject = (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null;

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

const createUsageRecordKey = (payload: JsonObject): string | undefined => {
    const identifier = [payload.session_id, payload.thread_id, payload.turn_id, payload.response_id]
        .map((value) => String(value ?? ""))
        .join("|");

    return identifier === "|||" ? undefined : identifier;
};

export const parseSession = async (file: string): Promise<SessionSummary | null> => {
    const text = await readFile(file, "utf8");
    let totalUsage = createEmptyTokenUsage();
    const seenUsage = new Set<string>();
    let project = "(unknown)";
    let model = "(unknown)";
    let lastActivity = "";
    let usageRecords = 0;
    let malformedLines = 0;

    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;

        let parsedEvent: unknown;
        try {
            parsedEvent = JSON.parse(line);
        } catch {
            // Active Codex sessions may end with a partially written line.
            malformedLines += 1;
            continue;
        }

        if (!isJsonObject(parsedEvent)) {
            malformedLines += 1;
            continue;
        }

        const event: JsonObject = parsedEvent;

        const timestamp = event.timestamp;
        if (typeof timestamp === "string" && timestamp > lastActivity) lastActivity = timestamp;

        if (!isJsonObject(event.payload)) continue;
        const payload: JsonObject = event.payload;

        if (event.type === "session_meta" && typeof payload.cwd === "string") {
            project = path.basename(payload.cwd) || payload.cwd;
        }

        if (event.type === "turn_context" && typeof payload.model === "string") {
            model = payload.model;
        }

        if (event.type !== "token_usage_record") continue;
        const usageRecordKey = createUsageRecordKey(payload);
        if (usageRecordKey && seenUsage.has(usageRecordKey)) continue;
        if (usageRecordKey) seenUsage.add(usageRecordKey);

        if (!isJsonObject(payload.usage)) continue;
        const usageRecord: JsonObject = payload.usage;
        usageRecords += 1;
        totalUsage = addTokenUsage(totalUsage, readTokenUsage(usageRecord));
    }

    if (!usageRecords) return null;
    return {
        file: path.basename(file),
        project,
        model,
        lastActivity,
        usageRecords,
        malformedLines,
        ...totalUsage,
    };
};

export const readSessionSummaries = async (
    directory: string,
): Promise<readonly SessionSummary[]> => {
    const files = await findSessionFiles(directory);
    const summaries = await Promise.all(files.map(parseSession));
    return summaries
        .filter((summary): summary is SessionSummary => summary !== null)
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
};

export const sumUsage = (sessions: readonly SessionSummary[]): TokenUsage =>
    sessions.reduce(addTokenUsage, createEmptyTokenUsage());
