import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InsightKind, type Insight, type InsightEvent } from "./insights.js";
import type { AuditSnapshot, SavedSession } from "./snapshot.js";

const DASHBOARD_FILE = path.join(os.homedir(), ".codex-audit", "latest.html");
const number = new Intl.NumberFormat("en-US");

const formatTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "Unknown time";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
};

const formatSize = (value: number): string => value < 1_000
    ? `${number.format(value)} bytes`
    : `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)} KB`;

const escapeHtml = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const totalBytes = (events: InsightEvent[]): number =>
    events.reduce((total, event) => total + (event.recordedBytes ?? 0), 0);

const insightSubtitle = (insight: Insight): string => {
    if (insight.kind === InsightKind.LargeToolOutputs) {
        return `${insight.events.length} results · ${formatSize(totalBytes(insight.events))}`;
    }
    if (insight.kind === InsightKind.CrowdedContext) return `${insight.events.length} conversations near their limit`;
    if (insight.kind === InsightKind.HeavyStartup) return `${insight.events.length} conversations affected`;
    if (insight.kind === InsightKind.RepeatedToolCalls) return `${insight.events.length} matching attempts`;
    return `${insight.events.length} highest-use requests`;
};

const formatFinding = (insight: Insight, index: number): string => `<button class="finding" data-finding="${index}" type="button">
  <span class="finding-dot"></span>
  <span><strong>${escapeHtml(insight.title)}</strong><small>${escapeHtml(insightSubtitle(insight))}</small></span>
</button>`;

const formatKpi = (label: string, value: string): string => `<div class="kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;

const activityGroups = (events: InsightEvent[]): { activity: string; count: number; bytes: number }[] => {
    const groups = new Map<string, { count: number; bytes: number }>();
    for (const event of events) {
        const activity = event.activity ?? "Other activity";
        const existing = groups.get(activity) ?? { count: 0, bytes: 0 };
        existing.count += 1;
        existing.bytes += event.recordedBytes ?? 0;
        groups.set(activity, existing);
    }
    return [...groups].map(([activity, group]) => ({ activity, ...group }))
        .sort((left, right) => right.bytes - left.bytes || right.count - left.count);
};

const formatOccurrences = (events: InsightEvent[]): string => `<details class="occurrences">
  <summary>View ${events.length} matching result${events.length === 1 ? "" : "s"}</summary>
  <ol>${events.map((event) => `<li><span>${escapeHtml(event.activity ?? "Activity")}</span><strong>${escapeHtml(event.detail)}</strong><time>${escapeHtml(formatTime(event.timestamp))} · ${escapeHtml(event.session)}</time></li>`).join("")}</ol>
</details>`;

const formatLargeResultEvidence = (insight: Insight): string => {
    const groups = activityGroups(insight.events);
    const bytes = totalBytes(insight.events);
    const largest = Math.max(...insight.events.map((event) => event.recordedBytes ?? 0));
    const lead = groups[0];
    const leadSentence = lead && bytes > 0
        ? `${lead.activity} produced ${lead.count} of ${insight.events.length} results and ${Math.round((lead.bytes / bytes) * 100)}% of the recorded size.`
        : "These results account for a meaningful share of the recorded activity.";

    return `<div class="kpis">${formatKpi("Large results", String(insight.events.length))}${formatKpi("Recorded size", formatSize(bytes))}${formatKpi("Largest result", formatSize(largest))}</div>
<section class="evidence"><h2>Where the size came from</h2><p class="lead">${escapeHtml(leadSentence)}</p>
<div class="breakdown">${groups.map((group) => `<div class="breakdown-row"><span>${escapeHtml(group.activity)}</span><span class="bar"><i style="width:${bytes ? (group.bytes / bytes) * 100 : 0}%"></i></span><strong>${group.count} results</strong><em>${formatSize(group.bytes)}</em></div>`).join("")}</div>
${formatOccurrences(insight.events)}</section>`;
};

const formatRankedEvidence = (insight: Insight): string => `<section class="evidence"><h2>What was found</h2><ol class="ranked-events">${insight.events.map((event) => {
    const metric = event.recordedTokens === undefined ? event.detail : `${number.format(event.recordedTokens)} tokens`;
    return `<li><span>${escapeHtml(event.activity ?? event.session)}</span><strong>${escapeHtml(metric)}</strong><time>${escapeHtml(formatTime(event.timestamp))} · ${escapeHtml(event.session)}</time></li>`;
}).join("")}</ol></section>`;

const formatContextEvidence = (insight: Insight): string => `<section class="evidence"><h2>Conversations closest to the limit</h2><ol class="ranked-events">${insight.events.map((event) => {
    const used = event.recordedTokens ?? 0;
    const limit = event.contextWindowTokens ?? 1;
    return `<li><span>${escapeHtml(event.session)}</span><strong>${Math.round((used / limit) * 100)}% full</strong><time>${number.format(used)} of ${number.format(limit)} tokens</time></li>`;
}).join("")}</ol></section>`;

const formatDetail = (insight: Insight, index: number): string => {
    const evidence = insight.kind === InsightKind.LargeToolOutputs
        ? formatLargeResultEvidence(insight)
        : insight.kind === InsightKind.CrowdedContext
            ? formatContextEvidence(insight)
            : formatRankedEvidence(insight);

    return `<article class="detail" data-detail="${index}"${index ? " hidden" : ""}>
  <p class="breadcrumb">Findings <span>/</span> ${escapeHtml(insight.title)}</p>
  <h1>${escapeHtml(insight.title)}</h1><p class="conclusion">${escapeHtml(insight.cause)}</p>
  ${evidence}
  <section class="change"><h2>What to change</h2><p>${escapeHtml(insight.action)}</p></section>
  <details class="method"><summary>How this was calculated</summary><p>${escapeHtml(insight.method)}</p><p>${escapeHtml(insight.caveat)}</p></details>
</article>`;
};

const formatSession = (session: SavedSession): string => `<tr><td>${escapeHtml(formatTime(session.lastActivity))}</td><td>${escapeHtml(session.project)}</td><td>${number.format(session.totalTokens)}</td></tr>`;

const styles = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#111827;color:#edf2f7}*{box-sizing:border-box}body{margin:0;background:#111827}main{max-width:1440px;margin:auto;padding:32px}.app{display:grid;grid-template-columns:320px minmax(0,1fr);min-height:720px;border:1px solid #273449;border-radius:12px;overflow:hidden;background:#151d2b}.sidebar{border-right:1px solid #273449;padding:20px 12px}.eyebrow,.breadcrumb{color:#8ca0bd;font-size:12px;margin:0 0 8px}.sidebar h1{font-size:22px;letter-spacing:-.03em;margin:0}.saved{color:#8ca0bd;font-size:12px;margin:8px 0 24px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:28px}.metric{background:#1c2738;border:1px solid #2b3a51;border-radius:7px;padding:10px 8px}.metric strong{display:block;font-size:15px}.metric span{color:#8ca0bd;font-size:10px}.section-label{color:#8ca0bd;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0 8px 8px}.finding{width:100%;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;display:flex;gap:10px;padding:12px 10px;text-align:left}.finding:hover,.finding.selected{background:#263752}.finding:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}.finding-dot{background:#fbbf24;border-radius:99px;height:7px;margin-top:6px;width:7px}.finding span:last-child{display:grid;gap:4px}.finding strong{font-size:13px;line-height:1.25}.finding small{color:#aab7ca;font-size:11px}.detail-pane{padding:52px 56px;min-width:0}.detail{max-width:850px}.breadcrumb span{margin:0 6px}.detail h1{font-size:32px;letter-spacing:-.04em;margin:0}.conclusion{color:#cbd5e1;font-size:17px;line-height:1.5;margin:12px 0 28px}.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:28px}.kpi{border-left:2px solid #497ca7;padding:8px 12px}.kpi span{color:#8ca0bd;display:block;font-size:12px}.kpi strong{font-size:18px}.evidence,.change,.method{border-top:1px solid #2b3a51;margin-top:28px;padding:24px 0 0}.evidence h2,.change h2{font-size:14px;margin:0 0 8px}.lead{color:#aab7ca;line-height:1.5;margin:0 0 18px}.breakdown{display:grid;gap:10px;margin-left:16px}.breakdown-row{display:grid;grid-template-columns:150px minmax(50px,1fr) 74px 75px;align-items:center;gap:10px;font-size:13px}.bar{background:#253247;border-radius:99px;height:6px;overflow:hidden}.bar i{background:#54b4e9;display:block;height:100%}.breakdown-row strong,.breakdown-row em{font-size:12px;font-style:normal;text-align:right}.breakdown-row em{color:#8ca0bd}.occurrences{margin:22px 0 0 16px}.occurrences summary,.method summary{color:#8dc8eb;cursor:pointer;font-size:13px}.occurrences ol,.ranked-events{border-left:1px solid #32435c;display:grid;gap:10px;margin:16px 0 0 8px;padding-left:22px}.occurrences li,.ranked-events li{display:grid;gap:3px;padding-left:2px}.occurrences li span,.ranked-events li span{font-size:13px}.occurrences li strong,.ranked-events li strong{font-size:12px;font-weight:500}.occurrences time,.ranked-events time{color:#8ca0bd;font-size:11px}.change{border-left:2px solid #54b4e9;padding-left:16px}.change p,.method p{color:#cbd5e1;line-height:1.5}.method{margin-left:16px}.sessions{margin-top:32px;width:100%;border-collapse:collapse}.sessions th,.sessions td{border-bottom:1px solid #2b3a51;padding:10px 0;text-align:left}.sessions th{color:#8ca0bd;font-size:11px}.privacy{color:#8ca0bd;font-size:11px;margin:28px 0 0}@media(max-width:850px){main{padding:0}.app{border:0;border-radius:0;display:block}.sidebar{border-bottom:1px solid #273449;border-right:0}.detail-pane{padding:32px 22px}.breakdown-row{grid-template-columns:110px minmax(30px,1fr) 55px 60px}.kpis{grid-template-columns:1fr}}
`;

const selectionScript = `<script>const buttons=document.querySelectorAll('.finding');const details=document.querySelectorAll('.detail');buttons.forEach(button=>button.addEventListener('click',()=>{const index=button.dataset.finding;buttons.forEach(item=>item.classList.toggle('selected',item===button));details.forEach(detail=>detail.hidden=detail.dataset.detail!==index)}));buttons[0]?.classList.add('selected');</script>`;

export const createDashboardDocument = (snapshot: AuditSnapshot): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex audit</title><style>${styles}</style></head><body><main><div class="app"><aside class="sidebar"><p class="eyebrow">SAVED ONLY ON THIS COMPUTER</p><h1>Codex audit</h1><p class="saved">Saved ${escapeHtml(formatTime(snapshot.generatedAt))}</p><div class="metrics">${formatKpi("Conversations",String(snapshot.sessions.length))}${formatKpi("Tokens",number.format(snapshot.totals.totalTokens))}${formatKpi("Findings",String(snapshot.insights.length))}</div><p class="section-label">Findings</p>${snapshot.insights.map(formatFinding).join("")}</aside><section class="detail-pane">${snapshot.insights.map(formatDetail).join("")}</section></div><table class="sessions"><thead><tr><th>Recent conversations</th><th>Project</th><th>Tokens</th></tr></thead><tbody>${snapshot.sessions.map(formatSession).join("")}</tbody></table><p class="privacy">This report does not include prompts, commands, file paths, or result contents.</p></main>${selectionScript}</body></html>`;

const browserLaunch = (file: string): { command: string; arguments_: string[] } => process.platform === "darwin"
    ? { command: "open", arguments_: [file] }
    : process.platform === "win32"
        ? { command: "cmd", arguments_: ["/c", "start", "", file] }
        : { command: "xdg-open", arguments_: [file] };

const launchBrowser = (file: string): Promise<void> => new Promise((resolve, reject) => {
    const { command, arguments_ } = browserLaunch(file);
    const browser = spawn(command, arguments_, { detached: true, stdio: "ignore" });
    browser.once("error", reject);
    browser.once("spawn", () => { browser.unref(); resolve(); });
});

export const openDashboard = async (snapshot: AuditSnapshot): Promise<void> => {
    await writeFile(DASHBOARD_FILE, createDashboardDocument(snapshot), { encoding: "utf8", mode: 0o600 });
    await launchBrowser(DASHBOARD_FILE);
};
