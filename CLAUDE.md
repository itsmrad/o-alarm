# [CLAUDE.md](http://CLAUDE.md)

General instructions for coding agents.

## Engineering

- Understand the task before coding.
- Surface important assumptions or ambiguity.
- Prefer the simplest correct implementation.
- Reuse existing code and project patterns where appropriate.
- Make surgical changes only.
- Do not refactor unrelated code.
- Do not add speculative features or abstractions.
- Follow existing architecture, naming, formatting, and conventions.
- Use professional engineering practices without over-engineering.
- Prefer execution over excessive optimization.

## Verification

For non-trivial work:

```
1. Define what success means.
2. Implement the smallest correct change.
3. Run relevant tests/checks.
4. Fix failures.
5. Verify the final diff.
```

Never claim something passed unless it was actually checked.

## Git

Never implement feature work directly on the primary branch.

Normally:

```
main
└── feat/example
```

If already assigned a branch/worktree, use it. Do not create another branch unless instructed.

If the task is part of a larger feature, it may branch from that feature:

```
main
└── feat/parent
    ├── feat/parent-api
    └── feat/parent-ui
```

Rules:

- keep each branch focused;
- commit meaningful checkpoints;
- push completed branches;
- never merge into the primary branch unless explicitly instructed;
- never force-push or perform destructive Git operations without permission.

## Worktrees

Treat each worktree as an isolated responsibility.

When assigned a worktree:

- stay on its assigned branch;
- modify only what the task requires;
- do not interfere with other worktrees;
- do not create sub-worktrees unless acting as an orchestrator.

## Multi-Agent Work

Other agents may be working concurrently.

Therefore:

- avoid unnecessary shared-file edits;
- minimize merge conflicts;
- communicate interface changes clearly;
- stay within your assigned scope.

## Completion

Before finishing:

- implementation works;
- relevant tests/checks pass;
- diff contains only intended changes;
- changes are committed;
- branch is pushed when required.

Report:

```
Changed:
Verified:
Branch:
Commit:
Push status:
```

