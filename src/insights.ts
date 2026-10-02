import type { SessionSummary, ToolCall, TurnUsage } from "./audit.js";

export const InsightKind = {
	/**
	 * Ranks the most token-heavy requests for investigation only.
	 * Useful when comparing sessions; for example, finding a request that used far more tokens than nearby work.
	 */
	CostliestTurns: "costliest_turns",
	/**
	 * Detects an identical failed tool action repeated without a detected file edit.
	 * Useful for spotting stuck work; for example, running the same failing test command three times unchanged.
	 */
	RetryLoop: "retry_loop",
	/**
	 * Detects an identical file read repeated without a detected file edit.
	 * Useful for avoiding duplicate context; for example, reading the same configuration file three times unchanged.
	 */
	RedundantRead: "redundant_read",
	/**
	 * Identifies output much larger than other recorded output in the same session.
	 * Useful as experimental evidence; for example, one command returning a full build log among small results.
	 */
	LargeToolOutputs: "large_tool_outputs",
	/**
	 * Measures the active conversation context against the model's logged context window.
	 * Useful before continuing a long investigation; for example, a request using 80% of available context.
	 */
	CrowdedContext: "crowded_context",
	/**
	 * Finds projects where most conversations begin with unusually large input context.
	 * Useful for investigating startup overhead; for example, three new conversations loading 20,000 input tokens each.
	 */
	HeavyStartup: "heavy_startup",
} as const;

export type InsightKind = (typeof InsightKind)[keyof typeof InsightKind];

export interface InsightEvent {
	session: string; // Project label of the source session.
	turn?: number; // User turn when the detector can identify one.
	timestamp: string; // Event timestamp used as supporting evidence.
	activity?: string; // Plain-language category of the activity that produced this event.
	recordedBytes?: number; // Result size when this event represents tool output.
	recordedTokens?: number; // Token total when this event represents a model request.
	contextWindowTokens?: number; // Model context capacity when this event represents context use.
	detail: string; // Privacy-preserving description of the matching event.
	toolInput?: string; // Exact local command, file target, or search query that produced the event.
	requestText?: string; // Nearest preceding local user request when available.
}

export interface Insight {
	kind: InsightKind; // Stable detector identity.
	rank: number; // Relative priority used to order the report.
	title: string; // Short presentation heading.
	cause: string; // Plain-language reason this finding appeared.
	action: string; // One-line recommended next action.
	events: InsightEvent[]; // Evidence that caused the detector to match.
	method: string; // Rule and threshold used to generate the finding.
	caveat: string; // Limitations of the signal.
}

// Checks a session sample and returns one finding when its rule matches.
type InsightDetector = (sessions: readonly SessionSummary[]) => Insight | undefined;

const format = (value: number): string => new Intl.NumberFormat("en-US").format(value);
const isTerminalCommand = (name: string): boolean => name.includes("exec");
const isFileRead = (name: string): boolean =>
	name.includes("read_file") || name.includes("readfile");
const isProjectSearch = (name: string): boolean => name.includes("search") || name.includes("find");
const isFileEdit = (name: string): boolean =>
	name.includes("patch") || name.includes("edit") || name.includes("write");

const describeTool = (name: string): string => {
	const normalizedName = name.toLowerCase();
	if (isTerminalCommand(normalizedName)) return "Terminal command";
	if (isFileRead(normalizedName)) return "File read";
	if (isProjectSearch(normalizedName)) return "Project search";
	if (isFileEdit(normalizedName)) return "File edit";
	return "Tool action";
};

const toolSummary = (tools: readonly ToolCall[]): string => {
	if (!tools.length) return "no tool calls logged";

	const activities = [...new Set(tools.map((tool) => describeTool(tool.name)))].join(", ");
	return `${tools.length} action${tools.length === 1 ? "" : "s"}: ${activities}`;
};

const MAX_FINDINGS = 3;
const MAX_HIGHEST_TOKEN_REQUESTS = 3;
const MIN_REPEATED_CALLS = 3;
const MIN_OUTPUTS_FOR_COMPARISON = 3;
const OUTPUT_OUTLIER_MULTIPLIER = 4;
const CONTEXT_REVIEW_RATIO = 0.75;
const CONTEXT_ACTION_RATIO = 0.8;
const HEAVY_STARTUP_INPUT_TOKENS = 20_000;
const MIN_HEAVY_STARTUP_SESSIONS = 3;
const HEAVY_STARTUP_RATIO = 0.75;

const detectCostliestTurns = (sessions: readonly SessionSummary[]): Insight | undefined => {
	const mostCostlyByTurn = new Map<string, { session: SessionSummary; turn: TurnUsage }>();

	for (const session of sessions) {
		for (const turn of session.turns) {
			if (turn.usage.totalTokens <= 0) continue;

			const key = `${session.sessionId}:${turn.userTurn}`;
			const existing = mostCostlyByTurn.get(key);

			if (!existing || turn.usage.totalTokens > existing.turn.usage.totalTokens) {
				mostCostlyByTurn.set(key, { session, turn });
			}
		}
	}

	const candidates = [...mostCostlyByTurn.values()]
		.sort((a, b) => b.turn.usage.totalTokens - a.turn.usage.totalTokens)
		.slice(0, MAX_HIGHEST_TOKEN_REQUESTS);

	if (!candidates.length) return undefined;

	return {
		kind: InsightKind.CostliestTurns,
		rank: 10,
		title: "Highest token use",
		cause: "These requests used more tokens than the other requests in the sessions reviewed.",
		action: "Use this list to see which requests used the most tokens.",
		events: candidates.map(({ session, turn }) => ({
			session: session.project,
			turn: turn.userTurn,
			timestamp: turn.timestamp,
			activity: toolSummary(turn.tools),
			recordedTokens: turn.usage.totalTokens,
			detail: `${format(turn.usage.totalTokens)} tokens; ${toolSummary(turn.tools)}`,
		})),
		method: "Ranks the highest token total recorded for each request. Repeated token snapshots within one request are not added together.",
		caveat: "A costly turn is investigation context, not a warning, and does not prove the tools caused the token use.",
	};
};

interface RepeatedToolGroup {
	tool: ToolCall; // First call in the repeated sequence.
	events: ToolCall[]; // Every matching call in the sequence.
	changedSinceFirstCall: boolean; // Whether a detected file edit separated matching calls.
	revision: number; // File-edit count at the latest matching call.
}

const findUnchangedRepeatedGroups = (
	sessions: readonly SessionSummary[],
): { session: SessionSummary; group: RepeatedToolGroup }[] => {
	const matches: { session: SessionSummary; group: RepeatedToolGroup }[] = [];

	for (const session of sessions) {
		const groups = new Map<string, RepeatedToolGroup>();
		let revision = 0;

		for (const tool of session.tools) {
			if (tool.editsFiles) revision += 1;
			if (tool.outputBytes === undefined) continue;

			const group = groups.get(tool.fingerprint) ?? {
				tool,
				events: [],
				changedSinceFirstCall: false,
				revision,
			};

			if (group.events.length && group.revision !== revision) {
				group.changedSinceFirstCall = true;
			}
			group.revision = revision;
			group.events.push(tool);
			groups.set(tool.fingerprint, group);
		}

		for (const group of groups.values()) {
			const repeatedWithoutChange =
				group.events.length >= MIN_REPEATED_CALLS && !group.changedSinceFirstCall;
			if (repeatedWithoutChange) matches.push({ session, group });
		}
	}

	return matches;
};

const detectRetryLoop = (sessions: readonly SessionSummary[]): Insight | undefined => {
	const match = findUnchangedRepeatedGroups(sessions).find(({ group }) =>
		group.events.every((tool) => tool.failed),
	);
	if (!match) return undefined;

	const activity = describeTool(match.group.tool.name);
	return {
		kind: InsightKind.RetryLoop,
		rank: 100,
		title: "Retry loop",
		cause: `The same failed ${activity.toLowerCase()} was repeated ${match.group.events.length} times without a detected file edit between attempts.`,
		action: "Check the first failure before trying again. Change the command, its inputs, or the relevant files first.",
		events: match.group.events.map((tool) => ({
			session: match.session.project,
			timestamp: tool.timestamp,
			activity,
			detail: "Failed again without a detected file edit between attempts.",
			...toolEvidence(tool),
		})),
		method: "Matches identical failed actions when the session log does not show a file edit between attempts.",
		caveat: "Edit detection is conservative; an unrecognized or external change may not be visible in the log.",
	};
};

const detectRedundantRead = (sessions: readonly SessionSummary[]): Insight | undefined => {
	const match = findUnchangedRepeatedGroups(sessions).find(({ group }) =>
		isFileRead(group.tool.name),
	);
	if (!match) return undefined;

	return {
		kind: InsightKind.RedundantRead,
		rank: 95,
		title: "Redundant read",
		cause: `The same file read was repeated ${match.group.events.length} times without a detected file edit between reads.`,
		action: "Use the earlier result while it is still current. Read the file again after it, or the relevant inputs, change.",
		events: match.group.events.map((tool) => ({
			session: match.session.project,
			timestamp: tool.timestamp,
			activity: "File read",
			detail: "Read again without a detected file edit between reads.",
			...toolEvidence(tool),
		})),
		method: "Matches identical file reads when the session log does not show a file edit between reads.",
		caveat: "Edit detection is conservative; an unrecognized or external change may not be visible in the log.",
	};
};

const median = (values: number[]): number => {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2) return sorted[middle] ?? 0;
	return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const actionForLargeOutput = (tool: ToolCall): string => {
	if (isTerminalCommand(tool.name)) {
		return "Run a narrower command or limit its output to the lines you need.";
	}
	if (isFileRead(tool.name)) {
		return "Read only the relevant section instead of the whole file.";
	}
	if (isProjectSearch(tool.name)) {
		return "Search a smaller folder or use a more specific search term.";
	}
	return "Ask for the smallest useful section instead of the full result.";
};

const toolEvidence = (tool: ToolCall) => ({
	toolInput: tool.input,
	requestText: tool.requestText,
});

const detectLargeToolOutputs = (sessions: readonly SessionSummary[]): Insight | undefined => {
	const outputs = sessions.flatMap((session) => {
		const measuredOutputs = session.tools.filter((tool) => (tool.outputBytes ?? 0) > 0);
		if (measuredOutputs.length < MIN_OUTPUTS_FOR_COMPARISON) return [];

		const typicalBytes = median(measuredOutputs.map((tool) => tool.outputBytes ?? 0));
		if (!typicalBytes) return [];

		return measuredOutputs
			.filter((tool) => (tool.outputBytes ?? 0) >= typicalBytes * OUTPUT_OUTLIER_MULTIPLIER)
			.map((tool) => ({ session, tool, typicalBytes }));
	});

	if (!outputs.length) return undefined;

	const largestResults = outputs.sort(
		(left, right) => (right.tool.outputBytes ?? 0) - (left.tool.outputBytes ?? 0),
	);
	const largest = largestResults[0];
	if (!largest) return undefined;

	const activity = describeTool(largest.tool.name);
	const sizeRatio = Math.round((largest.tool.outputBytes ?? 0) / largest.typicalBytes);

	return {
		kind: InsightKind.LargeToolOutputs,
		rank: 80,
		title: "Unusually large tool output",
		cause: `${format(largest.tool.outputBytes ?? 0)} bytes from a ${activity.toLowerCase()} was about ${sizeRatio} times larger than the typical recorded output in that session. If later included in requests, that much text can use substantial conversation room.`,
		action: actionForLargeOutput(largest.tool),
		events: largestResults.map(({ session, tool }) => ({
			session: session.project,
			timestamp: tool.timestamp,
			activity: describeTool(tool.name),
			recordedBytes: tool.outputBytes,
			detail: `About ${format(tool.outputBytes ?? 0)} bytes recorded.`,
			...toolEvidence(tool),
		})),
		method: `Compares recorded output sizes within each session and flags results at least ${OUTPUT_OUTLIER_MULTIPLIER} times the session median. Codex logs do not record per-result token use or whether later requests included the result.`,
		caveat: "Recorded bytes measure text volume, not token use or cost. This finding cannot confirm how much of the result later entered model context.",
	};
};

const detectCrowdedContext = (sessions: readonly SessionSummary[]): Insight | undefined => {
	const matches = sessions
		.map((session) => ({
			session,
			used: session.latestActiveContext?.inputTokens ?? 0,
			window: session.modelContextWindow ?? 0,
		}))
		.filter(({ used, window }) => window > 0 && used / window >= CONTEXT_REVIEW_RATIO)
		.sort((a, b) => b.used / b.window - a.used / a.window);

	if (!matches.length) return undefined;

	const mostCrowded = matches[0];
	const occupancy = Math.round((mostCrowded.used / mostCrowded.window) * 100);
	const remaining = 100 - occupancy;
	const needsHandoff = occupancy >= CONTEXT_ACTION_RATIO * 100;

	return {
		kind: InsightKind.CrowdedContext,
		rank: 90,
		title: needsHandoff ? "Context is getting tight" : "Limited room for the next steps",
		cause: `The latest request in ${matches.length} recent conversation${matches.length === 1 ? " is" : "s are"} using up to ${occupancy}% of its model context window. That leaves about ${remaining}% for further messages, tool results, and replies.`,
		action: needsHandoff
			? "Save a short handoff and start a follow-up conversation before continuing substantial investigation."
			: "If more investigation is ahead, save a short handoff before adding large results or changing topics.",
		events: matches.map(({ session, used, window }) => ({
			session: session.project,
			timestamp: session.lastActivity,
			recordedTokens: used,
			contextWindowTokens: window,
			detail: `${format(used)} active input tokens of ${format(window)} (${Math.round((used / window) * 100)}%)`,
		})),
		method: `${needsHandoff ? "80%" : "75%"} is this tool's working-room guardrail. It compares the input tokens logged for the latest request with that model's logged context window; it is not a model limit.`,
		caveat: "A conversation can still continue normally at this level. Context use changes with each request, and this report cannot predict answer quality or when the window will fill.",
	};
};

const detectHeavyStartup = (sessions: readonly SessionSummary[]): Insight | undefined => {
	const byProject = new Map<string, { session: SessionSummary; turn: TurnUsage }[]>();

	for (const session of sessions) {
		const turn = session.turns[0];
		if (!turn) continue;

		byProject.set(session.projectPath, [
			...(byProject.get(session.projectPath) ?? []),
			{ session, turn },
		]);
	}

	for (const starts of byProject.values()) {
		const heavy = starts.filter(
			({ turn }) => turn.usage.inputTokens >= HEAVY_STARTUP_INPUT_TOKENS,
		);

		if (
			heavy.length >= MIN_HEAVY_STARTUP_SESSIONS &&
			heavy.length / starts.length >= HEAVY_STARTUP_RATIO
		) {
			return {
				kind: InsightKind.HeavyStartup,
				rank: 50,
				title: "New conversations use many tokens before work begins",
				cause: `${heavy.length} of ${starts.length} reviewed conversations in this project began with at least ${format(HEAVY_STARTUP_INPUT_TOKENS)} input tokens.`,
				action: "If this is unexpected, review the instructions and tools loaded when a conversation starts.",
				events: heavy.map(({ session, turn }) => ({
					session: session.project,
					turn: turn.userTurn,
					timestamp: turn.timestamp,
					recordedTokens: turn.usage.inputTokens,
					detail: `${format(turn.usage.inputTokens)} input tokens on the first logged call`,
				})),
				method: `Requires at least ${MIN_HEAVY_STARTUP_SESSIONS} conversations in one project, with at least ${Math.round(HEAVY_STARTUP_RATIO * 100)}% beginning above ${format(HEAVY_STARTUP_INPUT_TOKENS)} input tokens.`,
				caveat: "This suggests a possible startup cause; it does not identify which instructions or tools were responsible.",
			};
		}
	}

	return undefined;
};

const detectorByKind: Record<InsightKind, InsightDetector> = {
	[InsightKind.CostliestTurns]: detectCostliestTurns,
	[InsightKind.RetryLoop]: detectRetryLoop,
	[InsightKind.RedundantRead]: detectRedundantRead,
	[InsightKind.LargeToolOutputs]: detectLargeToolOutputs,
	[InsightKind.CrowdedContext]: detectCrowdedContext,
	[InsightKind.HeavyStartup]: detectHeavyStartup,
};

const insightOrder: InsightKind[] = [
	InsightKind.RetryLoop,
	InsightKind.RedundantRead,
	InsightKind.CrowdedContext,
	InsightKind.LargeToolOutputs,
] satisfies InsightKind[];

export const findInsights = (sessions: readonly SessionSummary[]): Insight[] =>
	insightOrder
		.map((kind) => detectorByKind[kind](sessions))
		.filter((insight): insight is Insight => insight !== undefined)
		.sort((a, b) => b.rank - a.rank)
		.slice(0, MAX_FINDINGS);
