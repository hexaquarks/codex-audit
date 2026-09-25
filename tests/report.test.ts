import assert from "node:assert/strict";
import test from "node:test";
import { createUsageReport } from "../src/report.js";
import type { SessionSummary } from "../src/audit.js";

const session = (project: string, totalTokens: number): SessionSummary => ({
    file: "session.jsonl",
    project,
    model: "test-model",
    lastActivity: "2026-01-01T00:00:00Z",
    usageRecords: 1,
    malformedLines: 0,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
});

test("renders only the requested number of recent sessions", () => {
    const report = createUsageReport([session("first-project", 1_000_000), session("second-project", 2_000_000)], 1);

    assert.match(report, /3\.00M total tokens · 2 tracked sessions/);
    assert.match(report, /first-project/);
    assert.doesNotMatch(report, /second-project/);
});
