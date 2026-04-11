# Yardmaster

Agent orchestration system — autonomous coding, review, and PR creation via Claude Code CLI. Runs on Claude Code Max (subscription, not API).

## Quick Start

**Prerequisites:** Node.js, Redis (for BullMQ queue), Docker (for integration tests), `gh` CLI authenticated, `claude` CLI installed.

```bash
npm install
npm run dev -- task "fix the bug" --repo myrepo    # run task via tsx
npm run dev -- status                               # show recent tasks
npx tsc --noEmit                                    # type check
npm run test                                        # vitest
```

## Stack

- TypeScript, Node.js (ESM), `tsx` for dev, `vitest` for tests
- SQLite (`better-sqlite3`) for task state, capacity tracking, review ledger
- BullMQ + Redis for priority task queue
- Commander for CLI
- Claude Code CLI (`claude -p`) as the agent runtime — one-shot invocations with `--output-format stream-json`

## CLI Reference

All commands are defined in `src/cli.ts`. Do NOT modify cli.ts without explicit instruction.

| Command | Description |
|---|---|
| `ym task "desc" --repo name` | Run a coding task immediately (P0). Supports `--file <path>` for long descriptions |
| `ym pr <github-url>` | Take over an existing PR — apply review feedback and push fixes. Optional `--description` |
| `ym queue add "desc" --repo name` | Add task to queue. `--priority urgent\|high\|normal\|low` (default: normal) |
| `ym queue show` | Show queued tasks |
| `ym bump <jobId> <priority>` | Change a queued task's priority |
| `ym remove <jobId>` | Remove a task from the queue |
| `ym worker` | Start background worker (processes queue). Ctrl+C to stop |
| `ym scan` | Scan all repos for `ym`-labeled GitHub issues and queue them |
| `ym status` | Show recent task history. `-n <count>` for limit |
| `ym capacity` | Check current rate limit capacity |
| `ym doctor` | Pre-flight checks (git, gh, claude, ssh, redis, repos) |
| `ym worker-status` | Show systemd service, Redis, queue depth, last task |
| `ym recover` | Detect dead workers, recover interrupted tasks. `--gc` to remove orphaned worktrees |
| `ym ingest --repo name` | Ingest CLAUDE.md and config files into context store |
| `ym context search --repo name <query>` | Search context entries. Optional `--kind` filter |
| `ym context lookup` | Look up entry by `--id` or by `--repo`/`--kind`/`--key` |
| `ym context ingest --repo name` | Same as `ym ingest` |
| `ym context ingest-docs --repo name --lib name <urls...>` | Fetch and chunk web documentation pages |
| `ym context docs --repo name --lib name <query>` | Search web for docs, then ingest |
| `ym context prune-docs --repo name` | Remove stale doc entries. `--days N` (default: 30) |
| `ym context purge --repo name` | Purge stale web docs and raw content hashes |
| `ym context stats --repo name` | Show context budget usage per agent role |
| `ym context history --repo name` | Analyze completed task history and extract insights |
| `ym context maintenance` | Run all maintenance tasks. Optional `--repo` or all repos |
| `ym integration setup --repo name` | Set up integration test infrastructure |
| `ym integration start --repo name` | Start Docker services |
| `ym integration stop --repo name` | Stop Docker services |
| `ym integration test --repo name` | Run integration tests manually |
| `ym helper oidc-auth` | Get OIDC token. Requires `--issuer`, `--client-id`, `--username` |

## Configuration

### repos.json

Located at `~/code/gibson-ops/yardmaster/repos.json`. Defines all managed repositories:

```jsonc
{
  "repos": [
    {
      "name": "myrepo",           // identifier used in --repo flag
      "path": "~/code/myrepo",    // local checkout path (~ expanded)
      "org": "github-org",        // GitHub org
      "repo": "repo-name",       // GitHub repo name
      "branch": "main",          // default branch (optional, default: "main")
      "checkCommand": "npx tsc --noEmit",  // run after review loop (optional)
      "testCommand": "npm test",  // triggers test quality agent + test loop (optional)
      "devCommand": "npm run dev", // for browser validation (optional)
      "devPort": 3000,            // dev server port (optional)
      "readyPattern": "ready"     // stdout pattern indicating dev server is ready (optional)
    }
  ],
  "maxConcurrentAgents": 1       // set to 2 for parallel style+logic reviewers (optional)
}
```

### Integration Config

Per-repo YAML files at `data/integration/<repo-name>.yml`. Defines Docker services (postgres, redis, keycloak), auth strategies, test commands, and migrations. Secrets stored in `data/integration/.secrets/`.

Service types: `neon`, `docker-postgres`, `docker-redis`, `docker-keycloak`. Auth strategies: `keycloak`, `mock-jwt`.

### Global Config

- `config.defaultModel`: `"sonnet"` (overridden per-agent)
- `config.claudeBinary`: `"claude"`
- Timeouts: coder 10min, reviewer 5min, git agent 3min
- Data dir: `~/code/gibson-ops/yardmaster/data/`
- Worktrees: `data/worktrees/ym-<taskId>`

## Pipeline

Defined in `src/task-runner.ts`. Each task runs through these stages:

1. **Capacity check** → create task record in SQLite
2. **Create worktree** — git worktree for isolation (`data/worktrees/ym-<taskId>`)
3. **Ingest repo context** — scan config files, deps into context store
4. **Review loop** (`src/review-loop.ts`):
   - **Tools agent** (haiku) — one-shot library/pattern advice
   - **Planner** (sonnet) — decompose task into sub-tasks with file hints
   - **Per sub-task**: coder → style + logic reviewers → alignment gate → repeat (up to 4 rounds)
   - Convergence: both reviewers approve, OR only minor/nit issues after round 2, OR judge resolves
5. **Check command** — e.g. `tsc --noEmit` (if configured)
6. **Test quality agent** (sonnet) — writes unit tests for the diff (if `testCommand` configured)
7. **Test loop** — run tests, up to 2 coder fix attempts on failure
8. **Integration tests** — Docker services, migrations, test agent, fix loop (if configured)
9. **Browser validation** — dev server + Playwright (if `devCommand`/`devPort` configured, best-effort)
10. **Commit + push + PR** — git agent stages, commits, pushes, creates PR via `gh`
11. **Cleanup** — remove worktree

On failure at any stage: WIP work is saved (stash or temp branch), failure is analyzed and classified.

## Agent Contracts

All agents are one-shot `claude -p` child processes spawned by `src/agent-runner.ts`. Prompts live in `src/prompts/`, agent modules in `src/agents/`.

| Agent | Model | Timeout | Tools | Output |
|---|---|---|---|---|
| **Coder** | opus | 10min | All (Bash, Edit, Read, Write, Glob, Grep) | Edits files in worktree. Response text is summary only — real work is file edits. Does NOT stage/commit |
| **Style reviewer** | sonnet | 5min | All | JSON `{ verdict: "approve"\|"revise", issues: [...] }`. Read-only |
| **Logic reviewer** | opus | 5min | All | JSON `{ verdict: "approve"\|"revise", issues: [...] }`. Read-only |
| **Tools agent** | haiku | 90s | Read, Glob, Grep | Plain text recommendations. Returns `"NO_ADVICE_NEEDED"` if none |
| **Planner** | sonnet | 90s | Read, Glob, Grep | JSON `SubTask[]` — `{ description, files, reason }`. Falls back to single task |
| **Judge** | sonnet | 2min | Read, Glob, Grep | `{ decisions[], overallVerdict: "ship"\|"fix_and_ship", summary }` |
| **Test quality** | sonnet | 5min | All | Writes test files. Returns `"NO_TESTS_NEEDED"` if none needed |
| **Integration test** | sonnet | 5min | All | Writes integration test files. Returns `"NO_INTEGRATION_TESTS_NEEDED"` if none |
| **Git agent** | N/A | N/A | N/A | Shell commands (`git add/commit/push`, `gh pr create`). Not a Claude agent |
| **Alignment gate** | haiku | 60s | None | `{ aligned, filteredOutput?, concern? }`. Fail-open (defaults aligned=true) |

### Key Contracts

- **Coder**: edits files, does NOT stage or commit. Its response text is a summary — real work is in file edits.
- **Reviewers**: read-only, return JSON `{ verdict, issues[] }`. Issues have severity: critical, major, minor, nit.
- **Alignment gate**: runs on reviewer output ONLY (not coder output). Filters off-topic feedback using diff context. Fail-open.
- **Judge**: called on oscillation or max rounds. Can override reviewers with "ship" or "fix_and_ship".

## Review Loop Details

Defined in `src/review-loop.ts`:

- **Severity escalation**: rounds 1-2 surface all issues; round 3 filters to major+critical; round 4 critical only
- **Parallel reviewers**: when `maxConcurrentAgents >= 2`, style and logic reviewers run concurrently via `Promise.all`
- **Per-file approval tracking**: if a reviewer approves and the coder doesn't touch those files next round, the reviewer is skipped for those files
- **Smart convergence**: after round 2, if only minor/nit issues remain, auto-approve
- **Oscillation detection** (`src/oscillation.ts`): detects flip-flopping diffs, escalates to judge instead of halting
- **Judge escalation**: on oscillation OR max rounds, judge makes final call — "ship" or "fix_and_ship" with specific fixes
- **Cumulative context**: each reviewer gets a summary of prior rounds so they don't re-raise resolved issues
- **Alignment gate**: runs after EACH reviewer, filters issues that are off-topic relative to the task description

## Context Store

SQLite-backed context storage (`src/context-store.ts`) with per-agent routing (`src/context/router.ts`).

**Context kinds:** `file`, `dependency`, `convention`, `snippet`, `note`

**Per-agent character budgets:**

| Role | Budget |
|---|---|
| coder | 4,096 |
| logic-reviewer | 3,072 |
| integration-test | 3,072 |
| style-reviewer | 2,048 |
| planner | 2,048 |
| test-quality | 2,048 |
| tools-agent | 1,024 |

Priority order: convention → snippet → note → file → dependency

**Ingestion sources:** CLAUDE.md parsing, config file scanning, web documentation fetching, task history analysis.

## Queue System

BullMQ + Redis priority queue (`src/queue/`).

| Priority | Value | Label |
|---|---|---|
| Immediate | 0 | P0 (bypass queue via `ym task`) |
| Urgent | 1 | P1 |
| High | 2 | P2 |
| Normal | 3 | P3 (default) |
| Low | 4 | P4 |

`ym worker` polls the queue and processes tasks in priority order. `ym scan` discovers GitHub issues labeled for yardmaster and enqueues them.

## Integration Testing

Configured per-repo via `data/integration/<repo>.yml`. Pipeline position: after unit tests, before browser validation.

1. Load config → check Docker availability
2. Resolve secrets from `data/integration/.secrets/`
3. Start Docker services (postgres, redis, keycloak)
4. Run database migrations
5. Scaffold test utilities
6. Integration test agent writes tests
7. Run tests with fix loop (up to 2 coder fix attempts)

Supports Keycloak OIDC authentication via `src/helpers/oidc-auth.ts`.

## Writing Good Task Specs

- **Be specific**: detailed specs produce better results than vague ones
- **Use `--file`** for complex, multi-paragraph task descriptions
- **Reference existing patterns**: "follow the pattern in src/agents/coder.ts"
- **Prefer 2-3 sub-tasks**: the planner decomposes automatically, but explicit structure helps
- **Include constraints**: "do NOT modify src/cli.ts", "only change X"
- **Mention test expectations**: if testCommand is configured, the agent will write and run tests

## Conventions

- Agent prompts in `src/prompts/` as exported template literal functions
- Agent modules in `src/agents/` as thin wrappers around `runAgent()`
- All state in SQLite (`data/yardmaster.db`) — no external database
- ESM throughout (`"type": "module"` in package.json)
- TypeScript strict mode, target ES2022, Node16 module resolution
- Source in `src/`, output to `dist/`, tests colocated or in `src/__tests__/`
- One Claude CLI process at a time by default (8GB RAM constraint). Set `maxConcurrentAgents: 2` for parallel reviewers.

## Dogfooding Protocol

Yardmaster develops itself. When making changes:

1. **Use `ym task` to implement features** whenever possible. If yardmaster can't code, review, and PR its own changes, it's not ready.
2. **After each session**, evaluate results:
   - Update dogfooding observations in the plan file (`~/.claude/plans/mutable-seeking-tarjan.md`)
   - Reinforce what works, improve what doesn't
   - Track: task success rate, review loop rounds, oscillation frequency, time per task
3. **Regression signal**: if a change breaks yardmaster's ability to process tasks against itself, that's a blocking regression — revert or fix first.
4. **Never manually fix pipeline output** — if the pipeline produces bad code, fix the pipeline.
