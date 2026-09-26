import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InsightKind, type Insight, type InsightEvent } from "./insights.js";
import type { AuditSnapshot } from "./snapshot.js";

const DASHBOARD_FILE = path.join(os.homedir(), ".codex-audit", "latest.html");
const number = new Intl.NumberFormat("en-US");

const formatTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "Unknown time";

    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(date);
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

const insightMetric = (insight: Insight): string => {
    if (insight.kind === InsightKind.LargeToolOutputs) return formatSize(totalBytes(insight.events));
    if (insight.kind === InsightKind.CrowdedContext) return `${insight.events.length} sessions`;
    if (insight.kind === InsightKind.HeavyStartup) return `${insight.events.length} sessions`;
    return `${insight.events.length} events`;
};

const insightActivity = (insight: Insight): string => insight.events[0]?.activity ?? "Session activity";

const formatFindingRow = (insight: Insight, index: number): string => `<button class="finding-row" data-finding="${index}" type="button">
  <span class="marker">${index === 0 ? "›" : " "}</span>
  <strong>${escapeHtml(insight.title)}</strong>
  <span>${escapeHtml(insight.events.map((event) => event.session).filter((value, item, all) => all.indexOf(value) === item).join(", "))}</span>
  <span>${escapeHtml(insightMetric(insight))}</span>
  <span>${escapeHtml(insightActivity(insight))}</span>
</button>`;

interface ActivityGroup {
    activity: string; // Human-readable activity category.
    events: InsightEvent[]; // Matching occurrences for this category.
    bytes: number; // Combined logged output size.
}

const groupByActivity = (events: InsightEvent[]): ActivityGroup[] => {
    const groups = new Map<string, ActivityGroup>();

    for (const event of events) {
        const activity = event.activity ?? "Other activity";
        const group = groups.get(activity) ?? { activity, events: [], bytes: 0 };
        group.events.push(event);
        group.bytes += event.recordedBytes ?? 0;
        groups.set(activity, group);
    }

    return [...groups.values()].sort((left, right) => right.bytes - left.bytes);
};

const formatOccurrences = (events: InsightEvent[]): string => `<details class="occurrences">
  <summary>View ${events.length} matching result${events.length === 1 ? "" : "s"}</summary>
  <ol>${events.map((event) => `<li><strong>${escapeHtml(event.detail)}</strong><span>${escapeHtml(formatTime(event.timestamp))} · ${escapeHtml(event.session)}</span></li>`).join("")}</ol>
</details>`;

const formatLargeResultEvidence = (insight: Insight): string => {
    const groups = groupByActivity(insight.events);
    const bytes = totalBytes(insight.events);
    const largest = Math.max(...insight.events.map((event) => event.recordedBytes ?? 0));

    return `<div class="facts"><span>RESULTS <strong>${insight.events.length}</strong></span><span>RECORDED <strong>${formatSize(bytes)}</strong></span><span>LARGEST <strong>${formatSize(largest)}</strong></span></div>
<section class="evidence"><h2>ACTIVITY BREAKDOWN</h2><div class="tree">${groups.map((group, index) => `<details class="activity"><summary>${index === groups.length - 1 ? "└" : "├"}─ ${escapeHtml(group.activity)} <strong>${group.events.length} results · ${formatSize(group.bytes)}</strong></summary><div>${formatOccurrences(group.events)}</div></details>`).join("")}</div></section>`;
};

const formatRankedEvidence = (insight: Insight): string => `<section class="evidence"><h2>WHAT WAS FOUND</h2><ol class="tree ranked">${insight.events.map((event, index) => {
    const metric = event.recordedTokens === undefined ? event.detail : `${number.format(event.recordedTokens)} tokens`;
    const label = event.activity ?? event.session;
    return `<li>${index === insight.events.length - 1 ? "└" : "├"}─ <strong>${escapeHtml(label)}</strong> · ${escapeHtml(metric)}<span>${escapeHtml(formatTime(event.timestamp))} · ${escapeHtml(event.session)}</span></li>`;
}).join("")}</ol></section>`;

const formatDetail = (insight: Insight, index: number): string => {
    const evidence = insight.kind === InsightKind.LargeToolOutputs
        ? formatLargeResultEvidence(insight)
        : formatRankedEvidence(insight);

    return `<article class="selected" data-detail="${index}"${index ? " hidden" : ""}>
  <p class="selected-label">SELECTED FINDING</p>
  <h1>${escapeHtml(insight.title)}</h1>
  <p class="cause">${escapeHtml(insight.cause)}</p>
  ${evidence}
  <section class="next-step"><h2>WHAT TO CHANGE</h2><p>${escapeHtml(insight.action)}</p></section>
  <details class="method"><summary>How this was calculated</summary><p>${escapeHtml(insight.method)}</p><p>${escapeHtml(insight.caveat)}</p></details>
</article>`;
};

const styles = `
:root { color-scheme: dark; background: #101211; color: #e8e5df; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
* { box-sizing: border-box; } body { margin: 0; background: #101211; } main { margin: 0 auto; max-width: 1500px; padding: 18px; }
.status { align-items: center; border-bottom: 1px solid #66655d; display: flex; gap: 18px; padding: 0 0 16px; } .status strong { font-size: 23px; } .status span { color: #aaa79f; font-size: 14px; } .status .local { color: #99c85b; margin-left: auto; }
.workspace { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 710px; } aside { border-right: 1px solid #55554e; padding: 18px 16px 18px 0; } .heading { background: #242625; color: #aba9a2; font-size: 12px; font-weight: 700; margin: 0 0 8px; padding: 7px 10px; } .view { color: #ddd9d1; display: flex; justify-content: space-between; padding: 7px 10px; } .view.active { background: #29282b; color: #b99aff; } .view span { color: #aaa79f; }
.report { min-width: 0; padding: 18px 0 0 18px; } .columns, .finding-row { display: grid; grid-template-columns: 16px minmax(190px, 1.45fr) minmax(120px, .8fr) 115px 155px; gap: 12px; } .columns { background: #888880; color: #171817; font-size: 12px; font-weight: 800; padding: 8px 12px; } .finding-row { background: transparent; border: 0; color: inherit; cursor: pointer; padding: 11px 12px; text-align: left; width: 100%; } .finding-row:hover { background: #222321; } .finding-row.selected { background: #373054; } .finding-row:focus-visible { outline: 2px solid #b99aff; outline-offset: -2px; } .finding-row strong { font-size: 15px; } .finding-row span { color: #b5b2a9; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .finding-row .marker { color: #b99aff; font-size: 20px; line-height: 12px; }
.selected { border-top: 1px solid #66655d; margin-top: 16px; padding: 18px 16px 26px; } .selected-label, h2 { color: #aaa79f; font-size: 12px; font-weight: 800; margin: 0 0 8px; } .selected h1 { color: #e8e5df; font-size: 24px; margin: 0; } .cause { color: #d0cdc5; line-height: 1.55; margin: 10px 0 20px; max-width: 850px; }
.facts { border-bottom: 1px solid #3e403c; border-top: 1px solid #3e403c; display: flex; gap: 0; margin-bottom: 20px; } .facts span { border-right: 1px solid #3e403c; color: #aaa79f; font-size: 11px; padding: 9px 18px 9px 0; margin-right: 18px; } .facts strong { color: #74d1a2; margin-left: 6px; }
.evidence { border-left: 1px solid #66655d; margin-left: 8px; padding-left: 16px; } .tree { margin: 0; padding: 0; } .activity { margin: 10px 0; } .activity summary { cursor: pointer; font-size: 14px; } .activity summary strong { color: #74d1a2; font-weight: 500; margin-left: 8px; } .activity > div { border-left: 1px solid #55554e; margin: 8px 0 0 16px; padding-left: 14px; }
.occurrences summary, .method summary { color: #b99aff; cursor: pointer; font-size: 12px; } .occurrences ol { display: grid; gap: 7px; margin: 10px 0 0; padding-left: 16px; } .occurrences li, .ranked li { display: grid; font-size: 12px; gap: 2px; } .occurrences li span, .ranked li span { color: #aaa79f; font-size: 11px; } .ranked { display: grid; gap: 10px; list-style: none; } .ranked strong { color: #74d1a2; }
.next-step { border-left: 2px solid #b99aff; margin: 22px 0 0 8px; padding-left: 14px; } .next-step h2 { color: #b99aff; } .next-step p { margin: 0; } .method { color: #aaa79f; margin: 20px 0 0 24px; max-width: 800px; } .method p { line-height: 1.5; }
.privacy { border-top: 1px solid #66655d; color: #aaa79f; font-size: 11px; margin: 0; padding: 12px 0; } @media (max-width: 900px) { main { padding: 10px; } .workspace { display: block; } aside { border-bottom: 1px solid #55554e; border-right: 0; display: none; } .report { padding-left: 0; } .columns, .finding-row { grid-template-columns: 16px minmax(150px, 1fr) 100px; } .columns span:last-child, .columns span:nth-last-child(2), .finding-row span:last-child, .finding-row span:nth-last-child(2) { display: none; } }
`;

const selectionScript = `<script>const rows=document.querySelectorAll('.finding-row');const details=document.querySelectorAll('.selected');rows.forEach(row=>row.addEventListener('click',()=>{const index=row.dataset.finding;rows.forEach(item=>{item.classList.toggle('selected',item===row);item.querySelector('.marker').textContent=item===row?'›':' '});details.forEach(detail=>detail.hidden=detail.dataset.detail!==index)}));rows[0]?.classList.add('selected');</script>`;

export const createDashboardDocument = (snapshot: AuditSnapshot): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex audit</title><style>${styles}</style></head><body><main><header class="status"><strong>codex audit</strong><span>report ${escapeHtml(formatTime(snapshot.generatedAt))}</span><span>scope ${snapshot.sessions.length} conversations</span><span>view findings</span><span class="local">● local only</span></header><div class="workspace"><aside><p class="heading">VIEWS</p><div class="view active">▸ Findings <span>${snapshot.insights.length}</span></div><div class="view">▤ Conversations <span>${snapshot.sessions.length}</span></div><div class="view">◷ Token total <span>${number.format(snapshot.totals.totalTokens)}</span></div><p class="heading">REPORT</p><div class="view">Saved locally</div><div class="view">Privacy protected</div></aside><section class="report"><div class="columns"><span></span><span>FINDING</span><span>AFFECTED</span><span>RECORDED</span><span>ACTIVITY</span></div>${snapshot.insights.map(formatFindingRow).join("")}${snapshot.insights.map(formatDetail).join("")}</section></div><p class="privacy">This report does not include prompts, commands, file paths, or result contents.</p></main>${selectionScript}</body></html>`;

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
