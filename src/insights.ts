import type { SessionSummary, ToolCall, TurnUsage } from "./audit.js";

export const InsightKind = {
    CostliestTurns: "costliest_turns", // Highest per-call usage for each user turn.
    RepeatedToolCalls: "repeated_tool_calls", // Failed calls or file reads repeated without an edit.
    LargeToolOutputs: "large_tool_outputs", // Repeated tool results large enough to crowd context.
    CrowdedContext: "crowded_context", // Active context nearing the model's context window.
    HeavyStartup: "heavy_startup", // Consistently large first calls in one repository.
} as const;

export type InsightKind = typeof InsightKind[keyof typeof InsightKind];

export interface InsightEvent {
    session: string; // Project label of the source session.
    turn?: number; // User turn when the detector can identify one.
    timestamp: string; // Event timestamp used as supporting evidence.
    detail: string; // Privacy-preserving description of the matching event.
}

export interface Insight {
    kind: InsightKind; // Stable detector identity.
    rank: number; // Relative priority used to order the report.
    title: string; // Short presentation heading.
    action: string; // One-line recommended next action.
    events: InsightEvent[]; // Evidence that caused the detector to match.
    calculation: string; // Rule and threshold used by the detector.
    caveat: string; // Limitations of the signal.
}

// Checks a session sample and returns one finding when its rule matches.
type InsightDetector = (sessions: readonly SessionSummary[]) => Insight | undefined;

const format = (value: number): string => new Intl.NumberFormat("en-US").format(value);
const toolSummary = (tools: readonly ToolCall[]): string => {
    if (!tools.length) return "no tool calls logged";

    const names = [...new Set(tools.map((tool) => tool.name))].join(", ");
    return `${tools.length} tool call${tools.length === 1 ? "" : "s"}: ${names}`;
};

const MAX_INSIGHTS = 3;
const MIN_REPEATED_CALLS = 3;
const LARGE_TOOL_OUTPUT_BYTES = 12_000;
const CROWDED_CONTEXT_RATIO = 0.8;
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
        .slice(0, MAX_INSIGHTS);

    if (!candidates.length) return undefined;

    return {
        kind: InsightKind.CostliestTurns,
        rank: 10,
        title: "Highest token use",
        action: "Use this list to see which requests used the most tokens.",
        events: candidates.map(({ session, turn }) => ({
            session: session.project,
            turn: turn.userTurn,
            timestamp: turn.timestamp,
            detail: `${format(turn.usage.totalTokens)} tokens; ${toolSummary(turn.tools)}`,
        })),
        calculation: "Ranks the highest per-call last_token_usage.total_tokens for each user turn; it does not sum repeating token-count events.",
        caveat: "A costly turn is investigation context, not a warning, and does not prove the tools caused the token use.",
    };
};

const isRepeatedFileRead = (tool: ToolCall): boolean =>
    /(?:read_file|readfile)/i.test(tool.name);

const detectRepeatedToolCalls = (sessions: readonly SessionSummary[]): Insight | undefined => {
    for (const session of sessions) {
        const calls = session.tools.filter((tool) => tool.outputBytes !== undefined);
        const groups = new Map<string, {
            tool: ToolCall;
            events: ToolCall[];
            editedSinceLast: boolean;
            revision: number;
        }>();
        let revision = 0;

        for (const tool of calls) {
            if (tool.editsFiles) revision += 1;

            const group = groups.get(tool.fingerprint) ?? {
                tool,
                events: [],
                editedSinceLast: false,
                revision,
            };

            if (group.events.length && group.revision !== revision) group.editedSinceLast = true;
            group.revision = revision;

            group.events.push(tool);
            groups.set(tool.fingerprint, group);
        }

        const match = [...groups.values()].find((group) =>
            group.events.length >= MIN_REPEATED_CALLS
            && !group.editedSinceLast
            && (group.events.every((tool) => tool.failed) || isRepeatedFileRead(group.tool))
        );

        if (match) {
            return {
                kind: InsightKind.RepeatedToolCalls,
                rank: 100,
                title: "The same action was repeated without a change",
                action: "Review the earlier result before trying the same command or reading the same file again.",
                events: match.events.map((tool) => ({
                    session: session.project,
                    timestamp: tool.timestamp,
                    detail: `${tool.name} repeated (same command or file read; contents redacted)`,
                })),
                calculation: `${match.events.length} identical failed calls or file reads with no logged edit between attempts.`,
                caveat: "Edit detection is conservative; an unrecognized or external edit may not be visible in the log.",
            };
        }
    }

    return undefined;
};

const detectLargeToolOutputs = (sessions: readonly SessionSummary[]): Insight | undefined => {
    const outputs = sessions.flatMap((session) =>
        session.tools
            .filter((tool) => (tool.outputBytes ?? 0) >= LARGE_TOOL_OUTPUT_BYTES)
            .map((tool) => ({ session, tool })),
    );

    if (outputs.length < 3) return undefined;

    const top = outputs
        .sort((a, b) => (b.tool.outputBytes ?? 0) - (a.tool.outputBytes ?? 0))
        .slice(0, MAX_INSIGHTS);

    return {
        kind: InsightKind.LargeToolOutputs,
        rank: 80,
        title: "Several results were large",
        action: "If you needed only part of them, next time ask for a file, section, or fewer matches.",
        events: top.map(({ session, tool }) => ({
            session: session.project,
            timestamp: tool.timestamp,
            detail: `${tool.name} produced about ${format(tool.outputBytes ?? 0)} logged bytes`,
        })),
        calculation: `${outputs.length} tool results were at least ${format(LARGE_TOOL_OUTPUT_BYTES)} logged bytes.`,
        caveat: "Logged tool-output size is only a proxy for what entered model context, not a token count.",
    };
};

const detectCrowdedContext = (sessions: readonly SessionSummary[]): Insight | undefined => {
    const matches = sessions
        .map((session) => ({
            session,
            used: session.latestActiveContext?.inputTokens ?? 0,
            window: session.modelContextWindow ?? 0,
        }))
        .filter(({ used, window }) => window > 0 && used / window >= CROWDED_CONTEXT_RATIO)
        .sort((a, b) => b.used / b.window - a.used / a.window);

    if (!matches.length) return undefined;

    return {
        kind: InsightKind.CrowdedContext,
        rank: 90,
        title: "This conversation is nearly full",
        action: "Before continuing, save a short handoff and start a new conversation soon.",
        events: matches.slice(0, MAX_INSIGHTS).map(({ session, used, window }) => ({
            session: session.project,
            timestamp: session.lastActivity,
            detail: `${format(used)} active input tokens of ${format(window)} (${Math.round((used / window) * 100)}%)`,
        })),
        calculation: "Latest active input context divided by that model's logged context window; warning threshold is approximately 80%.",
        caveat: "This is current context occupancy, not cumulative session tokens; cached input is already included and is not added again.",
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
        const heavy = starts.filter(({ turn }) =>
            turn.usage.inputTokens >= HEAVY_STARTUP_INPUT_TOKENS,
        );

        if (
            heavy.length >= MIN_HEAVY_STARTUP_SESSIONS
            && heavy.length / starts.length >= HEAVY_STARTUP_RATIO
        ) {
            return {
                kind: InsightKind.HeavyStartup,
                rank: 50,
                title: "New conversations use many tokens before work begins",
                action: "If this is unexpected, review the instructions and tools loaded when a conversation starts.",
                events: heavy.slice(0, MAX_INSIGHTS).map(({ session, turn }) => ({
                    session: session.project,
                    turn: turn.userTurn,
                    timestamp: turn.timestamp,
                    detail: `${format(turn.usage.inputTokens)} input tokens on the first logged call`,
                })),
                calculation: `${heavy.length} of ${starts.length} sampled root sessions began with at least 20,000 input tokens.`,
                caveat: "This suggests a possible startup cause; it does not identify which instructions or tools were responsible.",
            };
        }
    }

    return undefined;
};

const detectorByKind: Record<InsightKind, InsightDetector> = {
    [InsightKind.CostliestTurns]: detectCostliestTurns,
    [InsightKind.RepeatedToolCalls]: detectRepeatedToolCalls,
    [InsightKind.LargeToolOutputs]: detectLargeToolOutputs,
    [InsightKind.CrowdedContext]: detectCrowdedContext,
    [InsightKind.HeavyStartup]: detectHeavyStartup,
};

const insightOrder: InsightKind[] = [
    InsightKind.RepeatedToolCalls,
    InsightKind.CrowdedContext,
    InsightKind.LargeToolOutputs,
    InsightKind.HeavyStartup,
    InsightKind.CostliestTurns,
] satisfies InsightKind[];

export const findInsights = (sessions: readonly SessionSummary[]): Insight[] =>
    insightOrder
        .map((kind) => detectorByKind[kind](sessions))
        .filter((insight): insight is Insight => insight !== undefined)
        .sort((a, b) => b.rank - a.rank)
        .slice(0, MAX_INSIGHTS);
