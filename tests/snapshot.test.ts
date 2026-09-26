import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardDocument } from "../src/dashboard.js";
import { createAuditSnapshot } from "../src/snapshot.js";
import type { SessionSummary } from "../src/audit.js";

const session: SessionSummary = {
    file: "session.jsonl",
    sessionId: "private-session-id",
    project: "demo",
    projectPath: "/private/work/demo",
    model: "test-model",
    lastActivity: "2026-01-01T00:00:00Z",
    usageRecords: 1,
    malformedLines: 0,
    turns: [],
    tools: [],
    inputTokens: 10_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 10_000,
};

test("creates a dashboard snapshot without session IDs or project paths", () => {
    const snapshot = createAuditSnapshot([session]);

    assert.equal(snapshot.sessions[0]?.project, "demo");
    assert.doesNotMatch(JSON.stringify(snapshot), /private-session-id|\/private\/work/);
});

test("embeds saved audit data safely in the dashboard document", () => {
    const document = createDashboardDocument(createAuditSnapshot([{
        ...session,
        project: "<script>alert('unsafe')</script>",
    }]));

    assert.match(document, /Codex audit/);
    assert.doesNotMatch(document, /<script>alert\('unsafe'\)<\/script>/);
});
