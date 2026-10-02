import { readFile } from "node:fs/promises";

export type JsonObject = Record<string, unknown>;

export interface ParsedEvent {
	type: string; // Codex event category.
	timestamp: string; // Event timestamp in ISO-8601 UTC.
	payload: JsonObject; // Untyped event data needed by event readers.
}

export interface SessionLog {
	events: ParsedEvent[]; // Valid events in their recorded order.
	malformedLines: number; // Nonblank lines that could not be read as event envelopes.
}

export const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null;

/** Parses one raw JSONL line into the common Codex event envelope. */
const parseEventLine = (line: string): ParsedEvent | undefined => {
	try {
		const value: unknown = JSON.parse(line);
		if (!isJsonObject(value) || !isJsonObject(value.payload)) return undefined;

		return {
			type: typeof value.type === "string" ? value.type : "",
			timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
			payload: value.payload,
		};
	} catch {
		return undefined;
	}
};

/**
 * Reads a session JSONL file while tolerating a partial final line from an
 * active Codex session.
 */
export const readSessionLog = async (file: string): Promise<SessionLog> => {
	const events: ParsedEvent[] = [];
	let malformedLines = 0;
	const lines = (await readFile(file, "utf8")).split(/\r?\n/);

	for (const line of lines) {
		if (!line.trim()) continue;

		const event = parseEventLine(line);
		if (event) events.push(event);
		else malformedLines += 1;
	}

	return { events, malformedLines };
};
