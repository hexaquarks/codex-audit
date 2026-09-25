import { sumUsage, type SessionSummary } from "./audit.js";

const PROJECT_NAME_WIDTH = 28;

const formatNumber = (value: number): string => new Intl.NumberFormat("en-US").format(value);

const formatMillions = (value: number): string => `${(value / 1_000_000).toFixed(2)}M`;

const formatProjectName = (projectName: string): string =>
    projectName.slice(0, PROJECT_NAME_WIDTH).padEnd(PROJECT_NAME_WIDTH);

const formatSession = (session: SessionSummary): string => {
    const activityDate = session.lastActivity.slice(0, 10) || "unknown date";
    const totalTokens = formatMillions(session.totalTokens).padStart(8);

    return `${activityDate}  ${formatProjectName(session.project)} ${totalTokens}  ${session.model}`;
};

export const createUsageReport = (
    sessionSummaries: readonly SessionSummary[],
    sessionLimit: number,
): string => {
    const totals = sumUsage(sessionSummaries);
    const cachedInputPercentage = totals.inputTokens === 0
        ? "0.0"
        : ((totals.cachedInputTokens / totals.inputTokens) * 100).toFixed(1);
    const recentSessions = sessionSummaries.slice(0, sessionLimit).map(formatSession);

    return [
        "Codex usage · local session records",
        `${formatMillions(totals.totalTokens)} total tokens · ${sessionSummaries.length} tracked sessions`,
        `${cachedInputPercentage}% cached input · ${formatNumber(totals.outputTokens)} output tokens`,
        "",
        "Recent sessions",
        ...recentSessions,
    ].join("\n");
};
