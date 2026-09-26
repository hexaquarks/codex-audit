# codex-audit

A local, read-only CLI for finding actionable token-usage patterns in Codex session logs.

```sh
npm run build
node dist/index.js --sessions 5
node dist/index.js explain 1 --sessions 5
```

It reports the most recently active root sessions and at most three ranked insights:

- costliest turns with adjacent tool activity;
- repeated failed commands or identical file reads without an intervening edit;
- repeated large tool results;
- active context at roughly 80% of the model context window; and
- consistently heavy first calls across sessions in a repository.

It never prints prompt, command, path, or tool-output content. Cached input is already part of input usage, and cumulative session usage is read from the latest snapshot rather than summed from repeatable per-call events. Logged tool-output bytes are treated only as a context-size proxy.
