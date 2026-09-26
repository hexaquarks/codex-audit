import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary, TokenUsage, ToolCall, TurnUsage } from "../src/audit.js";
import { findInsights, InsightKind } from "../src/insights.js";

const createUsage = (inputTokens: number, totalTokens = inputTokens): TokenUsage => ({
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
});

const createToolCall = (overrides: Partial<ToolCall> = {}): ToolCall => ({
    timestamp: "2026-01-01T00:00:00Z",
    name: "exec",
    callId: "call-1",
    fingerprint: "exec:redacted",
    failed: false,
    editsFiles: false,
    ...overrides,
});

const createSession = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
    file: "session.jsonl",
    sessionId: "session",
    project: "demo",
    projectPath: "/work/demo",
    model: "test-model",
    lastActivity: "2026-01-01T00:00:00Z",
    usageRecords: 1,
    malformedLines: 0,
    modelContextWindow: 100_000,
    latestActiveContext: createUsage(10_000),
    turns: [],
    tools: [],
    ...createUsage(10_000),
    ...overrides,
});

test("uses active context rather than cumulative session usage for crowded context", () => {
    const insights = findInsights([
        createSession({
            latestActiveContext: createUsage(81_000),
            totalTokens: 9_000_000,
        }),
    ]);

    assert.equal(insights[0]?.kind, InsightKind.CrowdedContext);
    assert.equal(insights[0]?.title, "This conversation is nearly full");
    assert.match(insights[0]?.calculation ?? "", /Latest active input context/);
});

test("flags repeated large tool outputs with a context-size caveat", () => {
    const tools = [1, 2, 3].map((number) => createToolCall({
        timestamp: `2026-01-01T00:00:0${number}Z`,
        callId: `call-${number}`,
        fingerprint: `exec:${number}`,
        outputBytes: 13_000,
    }));

    const insight = findInsights([createSession({ tools })])
        .find((item) => item.kind === InsightKind.LargeToolOutputs);

    assert.ok(insight);
    assert.equal(insight.title, "Several results were large");
    assert.equal(
        insight.action,
        "If you needed only part of them, next time ask for a file, section, or fewer matches.",
    );
    assert.match(insight.caveat, /proxy/);
});

test("flags repeated failed commands when no edit separates them", () => {
    const tools = [1, 2, 3].map((number) => createToolCall({
        timestamp: `2026-01-01T00:00:0${number}Z`,
        callId: `call-${number}`,
        outputBytes: 20,
        failed: true,
    }));

    const insight = findInsights([createSession({ tools })])
        .find((item) => item.kind === InsightKind.RepeatedToolCalls);

    assert.ok(insight);
    assert.equal(insight.title, "The same action was repeated without a change");
    assert.match(insight.calculation, /3 identical failed calls/);
});

test("does not flag repeated calls when a file edit separates them", () => {
    const tools = [
        createToolCall({ callId: "call-1", outputBytes: 20, failed: true }),
        createToolCall({ callId: "call-2", outputBytes: 20, failed: true }),
        createToolCall({
            callId: "call-3",
            fingerprint: "apply_patch:redacted",
            editsFiles: true,
            outputBytes: 20,
        }),
        createToolCall({ callId: "call-4", outputBytes: 20, failed: true }),
    ];

    const insight = findInsights([createSession({ tools })])
        .find((item) => item.kind === InsightKind.RepeatedToolCalls);

    assert.equal(insight, undefined);
});

test("reports each user turn at most once among the costliest turns", () => {
    const turns: TurnUsage[] = [
        { timestamp: "2026-01-01T00:00:01Z", userTurn: 1, usage: createUsage(20), tools: [] },
        { timestamp: "2026-01-01T00:00:02Z", userTurn: 1, usage: createUsage(25), tools: [] },
        { timestamp: "2026-01-01T00:00:03Z", userTurn: 2, usage: createUsage(24), tools: [] },
    ];

    const insight = findInsights([createSession({ turns })])
        .find((item) => item.kind === InsightKind.CostliestTurns);

    assert.deepEqual(insight?.events.map((event) => event.turn), [1, 2]);
    assert.equal(insight?.title, "Highest token use");
    assert.match(insight?.events[0]?.detail ?? "", /25 tokens/);
});

test("describes high initial token use without claiming a cause", () => {
    const sessions = [1, 2, 3].map((number) => createSession({
        sessionId: `session-${number}`,
        turns: [{
            timestamp: `2026-01-01T00:00:0${number}Z`,
            userTurn: 1,
            usage: createUsage(20_000),
            tools: [],
        }],
    }));

    const insight = findInsights(sessions)
        .find((item) => item.kind === InsightKind.HeavyStartup);

    assert.equal(insight?.title, "New conversations use many tokens before work begins");
    assert.equal(
        insight?.action,
        "If this is unexpected, review the instructions and tools loaded when a conversation starts.",
    );
});
