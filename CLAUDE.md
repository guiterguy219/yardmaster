# Yardmaster

Agent orchestration system — autonomous coding, review, and PR creation via Claude Code CLI.

## Stack

- TypeScript, Node.js (ESM), `tsx` for dev
- SQLite (`better-sqlite3`) for task state, capacity tracking, review ledger
- Commander for CLI
- Claude Code CLI (`claude -p`) as the agent runtime — one-shot invocations, not API calls

## Commands

- `ym task "description" --repo name` — run a coding task
- `ym status` — show recent task history
- `ym capacity` — check rate limit status
- `npm run dev` — run CLI via tsx (dev mode)
- `npx tsc --noEmit` — type check

## Architecture

Agents are one-shot `claude -p` child processes spawned by `src/agent-runner.ts`. Each task:
1. Creates a git worktree for isolation
2. Tools agent advises on libraries/patterns (once, before round 1)
3. Runs the coder agent (writes code)
4. Runs style + logic reviewers (up to 4 rounds with diminishing severity)
5. Alignment gate (haiku call) filters off-topic reviewer feedback after each review
6. Runs check command (e.g. `tsc --noEmit`) before PR creation
7. Commits, pushes, creates PR via `gh` with review summary
8. Cleans up worktree

Key contracts:
- **Coder agent**: edits files, does NOT stage or commit. Its response text is a summary — real work is in file edits.
- **Reviewers**: read-only, return JSON `{ verdict, issues[] }`
- **Alignment gate**: runs on reviewer output ONLY (not coder output). Coder summaries look misaligned but the file changes are what matter.
- **Tools agent**: read-only, returns plain text recommendations
- **Git agent**: stages, commits, pushes, creates PR
- **Alignment gate**: fail-open (defaults to aligned=true on failure)

## Conventions

- Agent prompts live in `src/prompts/` as exported template literal functions
- Agent modules live in `src/agents/` and are thin wrappers around `runAgent()`
- All state goes to SQLite (`data/yardmaster.db`) — no external database
- One Claude CLI process at a time (8GB RAM constraint)
- Worktrees are created in `data/worktrees/`, named `ym-<taskId>`

## Dogfooding Protocol

Yardmaster develops itself. When making changes:

1. **Use `ym task` to implement features on the yardmaster repo whenever possible.** If yardmaster can't successfully code, review, and PR its own changes, it's not ready.

2. **After each session of using yardmaster**, evaluate what worked well and what didn't:
   - Update the "Dogfooding Observations" section in the plan file (`~/.claude/plans/mutable-seeking-tarjan.md`) with specific findings
   - **Reinforce what works**: note patterns, prompt styles, or architectural choices that produced good results — so they're repeated
   - **Improve what doesn't**: for each problem, add a concrete improvement with priority (high/medium/low) and a brief plan for how to fix it
   - Look at: task success rate, review loop round counts, oscillation frequency, time per task, manual fixes needed after merge

3. **Regression signal**: if a change to yardmaster breaks its ability to process tasks against itself, that's a blocking regression — revert or fix before proceeding.

4. **Track metrics over time**: success rate, avg rounds to convergence, avg time per task, oscillation rate. These tell you if changes are actually improvements.
