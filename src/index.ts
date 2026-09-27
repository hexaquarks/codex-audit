#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { readSessionSummaries, type SessionSummary } from "./audit.js";
import { parseCommandArguments, usage } from "./cli.js";
import { openDashboard } from "./dashboard.js";
import { createDemoAuditSnapshot } from "./demo.js";
import { createUsageReport } from "./report.js";
import {
  createAuditSnapshot,
  loadLatestAuditSnapshot,
  saveAuditSnapshot,
} from "./snapshot.js";
import { startLoadingIndicator } from "./terminal.js";

const main = async (): Promise<void> => {
  const commandLineArguments: string[] = process.argv.slice(2);
  const command = parseCommandArguments(commandLineArguments);
  if (command.kind === "help") {
    console.log(usage);
    return;
  }

  if (command.kind === "open") {
    const snapshot = await loadLatestAuditSnapshot();
    if (!snapshot)
      throw new Error(
        "No saved report yet. Run codex-audit first, then try codex-audit open.",
      );

    await openDashboard(snapshot);
    console.log("Opened the latest audit in your browser.");
    return;
  }

  if (command.kind === "demo") {
    await openDashboard(createDemoAuditSnapshot());
    console.log(
      "Opened a sample dashboard with every currently supported finding.",
    );
    return;
  }

  const sessionsDirectoryPath: string = path.join(
    os.homedir(),
    ".codex",
    "sessions",
  );
  const loadingIndicator = startLoadingIndicator(
    "Reading local Codex sessions…",
  );
  let sessionSummaries: SessionSummary[];

  try {
    sessionSummaries = await readSessionSummaries(sessionsDirectoryPath);
  } finally {
    loadingIndicator.stop();
  }

  const selectedSessions = sessionSummaries.slice(0, command.sessionLimit);
  await saveAuditSnapshot(createAuditSnapshot(selectedSessions));
  console.log(createUsageReport(selectedSessions, selectedSessions.length));
  console.log(
    "\nOpen this report in your browser for more context: codex-audit open",
  );
};

void main().catch((error: unknown) => {
  console.error(
    `codex-audit: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
