# codex-audit

A local, read-only CLI for finding actionable token-usage patterns in Codex session logs.

> Work in progress. The reports and insights are still evolving.

```sh
npm run build
node dist/index.js --sessions 5
node dist/index.js open
node dist/index.js demo
```

It reports the most recently active root sessions and at most three ranked insights:

- repeated failed commands or identical file reads without an intervening edit;
- active context at 75% or more of the model context window; and
- repeated unusually long tool outputs.

Each audit saves a privacy-preserving local snapshot. Run `node dist/index.js open` to view the latest snapshot as an expandable browser report. The saved report contains no prompts, commands, paths, or tool-output content.
