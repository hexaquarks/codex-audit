import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardDocument } from "../src/dashboard.js";
import { createDemoAuditSnapshot } from "../src/demo.js";
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
	const document = createDashboardDocument(
		createAuditSnapshot([
			{
				...session,
				project: "<script>alert('unsafe')</script>",
			},
		]),
	);

	assert.match(document, /Codex audit/);
	assert.doesNotMatch(document, /<script>alert\('unsafe'\)<\/script>/);
});

test("renders escaped local evidence for a selected finding", () => {
	const snapshot = createDemoAuditSnapshot();
	const finding = snapshot.insights[2];
	if (!finding?.events[0]) throw new Error("Expected a demo finding event");

	finding.events[0].toolInput = "<script>unsafe()</script>";
	finding.events[0].requestText = "Inspect the build result.";

	const document = createDashboardDocument(snapshot);

	assert.match(document, /LOCAL EVIDENCE/);
	assert.match(document, /Tool input/);
	assert.match(document, /Request before this result/);
	assert.match(document, /&lt;script&gt;unsafe/);
	assert.doesNotMatch(document, /<script>unsafe/);
});

test("labels the sample dashboard and renders every supported finding", () => {
	const document = createDashboardDocument(createDemoAuditSnapshot());

	assert.match(document, /sample data — not local sessions/);
	assert.match(document, /Retry loop/);
	assert.match(document, /Limited room for the next steps/);
	assert.match(document, /Unusually large tool output/);
	assert.match(document, /ALSO FOUND: REPEATED WORK/);
	assert.doesNotMatch(document, /NO REPEATED WORK FOUND/);
});

test("explains when repeated work was not found", () => {
	const document = createDashboardDocument(
		createAuditSnapshot([
			{
				...session,
				modelContextWindow: 256_000,
				latestActiveContext: {
					inputTokens: 199_680,
					cachedInputTokens: 0,
					cacheWriteInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 199_680,
				},
			},
		]),
	);

	assert.match(document, /NO REPEATED WORK FOUND/);
});
