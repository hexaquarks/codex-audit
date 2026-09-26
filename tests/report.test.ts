import assert from "node:assert/strict";
import test from "node:test";
import { createUsageReport } from "../src/report.js";
import { createTerminalStyle } from "../src/terminal.js";
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

    assert.match(report, /1,000,000 cumulative tokens across 1 recent root sessions/);
    assert.match(report, /RECENT SESSIONS · LOCAL TIME/);
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

    const report = createUsageReport([outputFloodSession], 1);

    assert.match(report, /SEVERAL RESULTS WERE LARGE  from investigation-repo/);
});

test("uses ANSI styling only when the terminal style enables it", () => {
    const plainReport = createUsageReport([session("demo", 1_000)], 1, createTerminalStyle(false));
    const coloredReport = createUsageReport([session("demo", 1_000)], 1, createTerminalStyle(true));

    assert.doesNotMatch(plainReport, /\u001B\[/);
    assert.match(coloredReport, /\u001B\[/);
});
