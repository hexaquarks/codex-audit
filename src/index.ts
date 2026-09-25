#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { readSessionSummaries, type SessionSummary } from "./audit.js";
import { parseCommandArguments, usage } from "./cli.js";
import { createUsageReport } from "./report.js";

const main = async (): Promise<void> => {
    const commandLineArguments: readonly string[] = process.argv.slice(2);
    const command = parseCommandArguments(commandLineArguments);
    if (command.kind === "help") {
        console.log(usage);
        return;
    }

    const sessionsDirectoryPath: string = path.join(os.homedir(), ".codex", "sessions");
    const sessionSummaries: readonly SessionSummary[] = await readSessionSummaries(sessionsDirectoryPath);
    console.log(createUsageReport(sessionSummaries, command.sessionLimit));
};

void main().catch((error: unknown) => {
    console.error(`codex-audit: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
