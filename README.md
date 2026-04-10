# Yardmaster

Agent orchestration system — autonomous coding, review, and PR creation via Claude Code CLI.

Yardmaster runs one-shot `claude -p` subprocesses to implement code changes, iterates through style and logic review rounds, validates via your project's check command, then commits, pushes, and opens a pull request.

---

## Quick Start

### Prerequisites

- Node.js 22+
- `claude` CLI authenticated (`claude --version`)
- `gh` CLI authenticated (`gh auth status`)
- Redis (required for the queue worker)

### Install

```bash
git clone https://github.com/guiterguy219/yardmaster.git
cd yardmaster
npm install
npm run build
npm link   # makes `ym` available globally
```

### Run a task immediately

```bash
ym task "Add input validation to the user registration endpoint" --repo my-api
```

### Dev mode (no build required)

```bash
npm run dev -- task "Fix the broken unit tests" --repo my-project
```

---

## CLI Commands

### `ym task`

Run a coding task immediately (P0 — bypasses the queue, runs now).

```bash
ym task "<description>" --repo <name>
ym task --file task.md --repo <name>
```

| Option | Description |
|--------|-------------|
| `--repo <name>` | Target repo name from `repos.json` (required) |
| `--file <path>` | Read task description from a file instead of inline |

### `ym queue add`

Add a task to the BullMQ queue for the background worker to process.

```bash
ym queue add "<description>" --repo <name> [--priority <level>]
```

| Option | Description |
|--------|-------------|
| `--repo <name>` | Target repo name (required) |
| `--file <path>` | Read description from file |
| `--priority <level>` | `urgent`, `high`, `normal` (default), `low` |

### `ym queue show`

Display all queued tasks with their priority, age, and job ID.

```bash
ym queue show
```

### `ym bump`

Change the priority of a queued task.

```bash
ym bump <jobId> <priority>
# priority: urgent | high | normal | low
```

### `ym remove`

Remove a task from the queue before it runs.

```bash
ym remove <jobId>
```

### `ym worker`

Start the background worker process. Picks up queued tasks in priority order.

```bash
ym worker
```

Stop with Ctrl+C (graceful shutdown).

### `ym scan`

Scan all repos in `repos.json` for GitHub issues labeled `ym` and enqueue them automatically.

```bash
ym scan
```

### `ym status`

Show recent task history from the SQLite database.

```bash
ym status [-n <count>]
```

Defaults to 10 most recent tasks. Each row shows status, job ID, repo, description, PR URL, and error if any.

### `ym worker-status`

Show systemd service state, Redis connectivity, queue depth, and last task result.

```bash
ym worker-status
```

### `ym capacity`

Check current Claude API rate limit capacity.

```bash
ym capacity
```

### `ym doctor`

Run pre-flight checks: git, gh, claude, SSH, Redis, and all repos in `repos.json`.

```bash
ym doctor
```

---

## `repos.json` Schema

Defines the repositories Yardmaster can target. Lives at the project root.

```json
{
  "repos": [
    {
      "name": "my-api",
      "path": "~/code/my-org/my-api",
      "org": "my-org",
      "repo": "my-api",
      "branch": "main",
      "checkCommand": "npx tsc --noEmit",
      "testCommand": "npx vitest run"
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✓ | Short identifier used in `--repo` flag |
| `path` | ✓ | Absolute or `~`-relative path to local clone |
| `org` | ✓ | GitHub org or username |
| `repo` | ✓ | GitHub repository name |
| `branch` | — | Base branch for PRs. Defaults to `main` if omitted. |
| `checkCommand` | — | Command run after coding to validate the build (e.g. `npx tsc --noEmit`). Inferred by onboarding if absent. |
| `testCommand` | — | Test command run after coding (e.g. `npx vitest run`). |
| `devCommand` | — | Command to start a dev server for browser validation. |
| `devPort` | — | Port the dev server listens on (used with `devCommand`). |
| `readyPattern` | — | Regex pattern matched against dev server stdout to detect when it is ready. |

If `checkCommand` is omitted, Yardmaster runs an onboarding probe on first use to detect the language and infer an appropriate check command.

---

## Architecture

Each task runs through a fixed pipeline inside a dedicated git worktree:

```
task
 └─ worktree created (data/worktrees/ym-<taskId>)
     ├─ tools agent      — read-only; recommends libraries/patterns
     ├─ coder agent      — edits files (does NOT commit)
     ├─ review loop (up to 4 rounds)
     │   ├─ style reviewer   — returns JSON { verdict, issues[] }
     │   ├─ logic reviewer   — returns JSON { verdict, issues[] }
     │   ├─ alignment gate   — haiku call; filters off-topic feedback
     │   └─ coder agent      — applies aligned feedback
     ├─ check command    — e.g. tsc --noEmit; blocks PR on failure
     ├─ git agent        — stages, commits, pushes branch
     ├─ PR created via gh
     └─ worktree cleaned up
```

**Agent contracts:**

- **Coder agent** — edits files only. Its text response is a summary; the actual work is the file diffs.
- **Reviewer agents** — read-only. Return structured JSON. Never edit files.
- **Tools agent** — read-only. Returns plain-text recommendations consumed before round 1.
- **Git agent** — stages, commits, pushes, and opens the PR.
- **Alignment gate** — runs after each review. Filters feedback that drifted off-topic. Fails open (defaults to `aligned=true`).

**Source layout:**

| Path | Purpose |
|------|---------|
| `src/cli.ts` | Commander CLI entry point |
| `src/task-runner.ts` | Top-level task orchestration |
| `src/agent-runner.ts` | Spawns `claude -p` subprocesses |
| `src/agents/` | Thin agent wrappers (coder, reviewer, git, …) |
| `src/prompts/` | Prompt template functions |
| `src/queue/` | BullMQ queue, worker, constants |
| `src/review-loop.ts` | Multi-round review orchestration |
| `src/alignment-gate.ts` | Alignment filtering logic |
| `src/worktree.ts` | Git worktree lifecycle |
| `src/db.ts` | SQLite schema and queries |
| `src/capacity.ts` | Rate limit tracking |
| `data/yardmaster.db` | SQLite state file (task history, capacity, review ledger) |
| `data/worktrees/` | Per-task isolated worktrees (`ym-<taskId>`) |

---

## Background Services

Yardmaster ships two systemd units for unattended operation.

### `yardmaster.service` — the queue worker

Runs `ym worker` as a persistent daemon. Processes queued tasks in priority order, one at a time.

```bash
# Install
sudo cp yardmaster.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yardmaster

# Monitor
journalctl -u yardmaster -f
ym worker-status
```

### `yardmaster-scan.service` + `yardmaster-scan.timer` — issue scanner

Runs `ym scan` every 2 hours (with a randomized ±5 min delay). Picks up GitHub issues labeled `ym` across all repos and enqueues them.

```bash
# Install
sudo cp yardmaster-scan.service yardmaster-scan.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yardmaster-scan.timer

# Check timer
systemctl list-timers yardmaster-scan.timer
```

Both services require Redis to be running for the BullMQ queue.

---

## Priority Model

Tasks are assigned a numeric priority. Lower number = higher priority. `ym task` always runs at P0 (immediate, bypasses queue entirely).

| Level | Name | CLI value | Use case |
|-------|------|-----------|----------|
| P0 | Immediate | — (via `ym task`) | Run right now, no queue |
| P1 | Urgent | `urgent` | Blocking issue, next up |
| P2 | High | `high` | Important but not blocking |
| P3 | Normal | `normal` | Default for queued tasks |
| P4 | Low | `low` | Background / nice-to-have |

GitHub issues labeled `ym` are enqueued at **P3 Normal** by default.

---

## Development

```bash
# Run CLI without building
npm run dev -- task "..." --repo yardmaster

# Type check
npx tsc --noEmit

# Run tests
npm run test

# Build
npm run build
```

State is stored in `data/yardmaster.db` (SQLite). Delete it to reset all task history and capacity tracking.

Yardmaster develops itself — use `ym task` against the `yardmaster` repo to implement new features.
