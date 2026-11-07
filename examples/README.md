# foreman examples

## `node-service/`: a complete target repository

A dependency-free Node project (`node --test`) with everything foreman needs:

| File | Purpose |
|---|---|
| `foreman.config.yaml` | checks (`npm run lint`, `npm test`), models, limits, CI waiting, issue intake |
| `tasks.yaml` | three tasks with acceptance criteria, file hints, priorities and a per-task model override |
| `.github/workflows/foreman.yml` | runs foreman every 3 hours and on demand (`workflow_dispatch` with task / retry / dry-run inputs) |
| `src/`, `test/`, `scripts/lint.js` | the code foreman works on |

Try it locally:

```bash
cp -r examples/node-service /tmp/foreman-demo && cd /tmp/foreman-demo
git init -b main && git add -A && git commit -m init
gh repo create foreman-demo --private --source . --push   # or add any GitHub remote
export ANTHROPIC_API_KEY=sk-ant-...
npx claude-foreman dry-run --task mean-empty-list         # no push, no PR
export GITHUB_TOKEN=$(gh auth token)
npx claude-foreman run                                     # opens PRs
npx claude-foreman status
```

## `server/foreman.service`: always-on server

A hardened systemd unit (template, one instance per repository) that runs
`foreman watch --tasks-from-remote`, so new tasks merged to the base branch are
picked up without touching the server checkout.
