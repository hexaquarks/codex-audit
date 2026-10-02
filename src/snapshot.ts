import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sumUsage, type SessionSummary, type TokenUsage } from "./audit.js";
import { findInsights, type Insight } from "./insights.js";

const SNAPSHOT_DIRECTORY = path.join(os.homedir(), ".codex-audit");
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIRECTORY, "latest.json");

export interface SavedSession {
	project: string; // Project label without its working-directory path.
	lastActivity: string; // Most recent event time recorded for the session.
	totalTokens: number; // Cumulative provider-reported token usage.
	activeContextTokens?: number; // Latest input context when the log includes it.
	contextWindowTokens?: number; // Model context capacity when the log includes it.
}

export interface AuditSnapshot {
	generatedAt: string; // Time when this saved audit was created.
	isDemo?: boolean; // Whether this snapshot contains built-in sample data rather than local sessions.
	sessions: SavedSession[]; // Recent sessions included in the audit.
	totals: TokenUsage; // Combined token usage across the included sessions.
	insights: Insight[]; // Findings and their local supporting evidence for the dashboard.
}

const toSavedSession = (session: SessionSummary): SavedSession => ({
	project: session.project,
	lastActivity: session.lastActivity,
	totalTokens: session.totalTokens,
	activeContextTokens: session.latestActiveContext?.inputTokens,
	contextWindowTokens: session.modelContextWindow,
});

export const createAuditSnapshot = (sessions: SessionSummary[]): AuditSnapshot => ({
	generatedAt: new Date().toISOString(),
	sessions: sessions.map(toSavedSession),
	totals: sumUsage(sessions),
	insights: findInsights(sessions),
});

export const saveAuditSnapshot = async (snapshot: AuditSnapshot): Promise<void> => {
	await mkdir(SNAPSHOT_DIRECTORY, { recursive: true, mode: 0o700 });

	const temporaryFile = path.join(SNAPSHOT_DIRECTORY, `latest-${process.pid}.json`);
	await writeFile(temporaryFile, JSON.stringify(snapshot), {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporaryFile, SNAPSHOT_FILE);
};

export const loadLatestAuditSnapshot = async (): Promise<AuditSnapshot | undefined> => {
	try {
		const contents = await readFile(SNAPSHOT_FILE, "utf8");
		return JSON.parse(contents) as AuditSnapshot;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
};
