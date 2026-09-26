import assert from "node:assert/strict";
import test from "node:test";
import { createUsageReport } from "../src/report.js";
import type { SessionSummary } from "../src/audit.js";

const session = (project: string, totalTokens: number): SessionSummary => ({
    file: "session.jsonl",
    sessionId: "session",
    projectPath: `/work/${project}`,
    project,
    model: "test-model",
    lastActivity: "2026-01-01T00:00:00Z",
    usageRecords: 1,
    malformedLines: 0,
    turns: [],
    tools: [],
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
});

test("renders only the requested number of recent sessions", () => {
    const report = createUsageReport([session("first-project", 1_000_000), session("second-project", 2_000_000)], 1);

    assert.match(report, /1 most recently active sessions · 1,000,000 cumulative tokens/);
    assert.match(report, /first-project/);
    assert.doesNotMatch(report, /second-project/);
});

test("labels a session-derived insight with its source session", () => {
    const outputFloodSession = {
        ...session("investigation-repo", 10_000),
        tools: [1, 2, 3].map((number) => ({
            timestamp: `2026-01-01T00:00:0${number}Z`,
            name: "exec",
            callId: String(number),
            fingerprint: `exec:${number}`,
            outputBytes: 13_000,
            failed: false,
            editsFiles: false,
        })),
    };

    assert.match(createUsageReport([outputFloodSession], 1), /Output flood \[investigation-repo\]/);
});
