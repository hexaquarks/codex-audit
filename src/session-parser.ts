import path from "node:path";
import type { SessionSummary, TokenUsage, ToolCall, TurnUsage } from "./audit.js";
import {
	isUserMessage,
	readModel,
	readSessionMetadata,
	readToolEvent,
	readUsageSnapshot,
	readUserRequest,
	type ToolResult,
} from "./session-events.js";
import { readSessionLog, type ParsedEvent } from "./session-log.js";

/** Builds one normalized audit summary from the chronological raw event stream. */
class SessionAccumulator {
	private projectPath = "(unknown)";
	private project = "(unknown)";
	private model = "(unknown)";
	private sessionId: string;
	private parentSessionId: string | undefined;
	private lastActivity = "";
	private totalUsage: TokenUsage | undefined;
	private latestActiveContext: TokenUsage | undefined;
	private modelContextWindow: number | undefined;
	private userTurn = 0;
	private latestUserRequest = "";
	private turns: TurnUsage[] = [];
	private tools: ToolCall[] = [];
	private callsById = new Map<string, ToolCall>();
	private pendingToolCalls: ToolCall[] = [];

	constructor(private file: string) {
		this.sessionId = path.basename(file);
	}

	/** Records every relevant fact from one raw event. */
	add(event: ParsedEvent): void {
		this.recordActivity(event);
		this.recordMetadata(event);
		this.recordModel(event);
		this.recordUserRequest(event);
		this.recordToolEvent(event);
		this.recordUsageSnapshot(event);
	}

	/** Produces the public summary after every event has been recorded. */
	toSummary(malformedLines: number): SessionSummary | null {
		if (!this.totalUsage) return null;

		return {
			file: path.basename(this.file),
			sessionId: this.sessionId,
			parentSessionId: this.parentSessionId,
			project: this.project,
			projectPath: this.projectPath,
			model: this.model,
			lastActivity: this.lastActivity,
			usageRecords: this.turns.length,
			malformedLines,
			modelContextWindow: this.modelContextWindow,
			latestActiveContext: this.latestActiveContext,
			turns: this.turns.map((turn) => this.attachResultsToTurn(turn)),
			tools: this.tools.map((tool) => this.callsById.get(tool.callId) ?? tool),
			...this.totalUsage,
		};
	}

	private recordActivity(event: ParsedEvent): void {
		if (event.timestamp > this.lastActivity) this.lastActivity = event.timestamp;
	}

	private recordMetadata(event: ParsedEvent): void {
		const metadata = readSessionMetadata(event);
		if (!metadata) return;

		if (metadata.projectPath) {
			this.projectPath = metadata.projectPath;
			this.project = path.basename(metadata.projectPath) || metadata.projectPath;
		}

		if (metadata.sessionId) this.sessionId = metadata.sessionId;
		if (metadata.parentSessionId) this.parentSessionId = metadata.parentSessionId;
	}

	private recordModel(event: ParsedEvent): void {
		const model = readModel(event);
		if (model) this.model = model;
	}

	private recordUserRequest(event: ParsedEvent): void {
		if (!isUserMessage(event)) return;

		this.userTurn += 1;
		const request = readUserRequest(event);
		if (request) this.latestUserRequest = request;
	}

	private recordToolEvent(event: ParsedEvent): void {
		const toolEvent = readToolEvent(event, this.latestUserRequest);
		if (!toolEvent) return;

		if (toolEvent.kind === "result") {
			this.attachToolResult(toolEvent.result);
			return;
		}

		this.tools.push(toolEvent.call);
		this.pendingToolCalls.push(toolEvent.call);

		if (toolEvent.call.callId) this.callsById.set(toolEvent.call.callId, toolEvent.call);
	}

	private attachToolResult(result: ToolResult): void {
		const call = this.callsById.get(result.callId);
		if (!call) return;

		this.callsById.set(result.callId, {
			...call,
			outputBytes: result.outputBytes,
			failed: call.failed || result.failed,
		});
	}

	private recordUsageSnapshot(event: ParsedEvent): void {
		const snapshot = readUsageSnapshot(event);
		if (!snapshot) return;

		this.totalUsage = snapshot.usage;
		this.latestActiveContext = snapshot.activeContext;
		if (snapshot.modelContextWindow) this.modelContextWindow = snapshot.modelContextWindow;

		this.turns.push({
			timestamp: event.timestamp,
			userTurn: this.userTurn,
			usage: snapshot.activeContext,
			tools: this.pendingToolCalls.splice(0),
		});
	}

	private attachResultsToTurn(turn: TurnUsage): TurnUsage {
		return {
			...turn,
			tools: turn.tools.map((tool) => this.callsById.get(tool.callId) ?? tool),
		};
	}
}

/** Parses one Codex session file into the normalized audit model. */
export const parseSession = async (file: string): Promise<SessionSummary | null> => {
	const { events, malformedLines } = await readSessionLog(file);
	const session = new SessionAccumulator(file);

	for (const event of events) session.add(event);

	return session.toSummary(malformedLines);
};
