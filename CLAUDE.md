# marketplace-dev-public-authorization

Backend svc 5 of 9. public tier, authorization concern. Port 4028.

**Read parent first** — [`../../../CLAUDE.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/CLAUDE.md)
Tier/concern split, port table, terminology, auth model live there. Not here.

| Need | File |
|---|---|
| what this svc is, its GraphQL surface, its traps | [`README.md`](./README.md) |
| hook internals, gate order, node selection, mutation-gate rationale | [`REPO.md`](./REPO.md) |
| GitNexus rules, CLI, registry name (`marketplace-dev-public-authorization`) | [`AGENTS.md`](./AGENTS.md) |
| anything cross-repo | parent `CLAUDE.md` |

## ⚠️ NEVER run the mutation gate by hand

`yarn test:mutation` is **hook-only** — `pre-push` runs it, nothing else does, and neither a commit nor
a one-file check is a reason to run it or `stryker` directly. To reproduce a survivor, apply the mutant
by hand in the source and run `yarn test`, which takes seconds. Why: [`REPO.md`](./REPO.md).

## Rules

- **Never commit on `main`.** Branch first: `git switch -c <type>/<slug>`. Merge = user decision alone.
- Merged → delete branch: `git branch -d <slug>`. `-d` only. `-D` never.
- **No remote.** Push-on-request: no `git push` unless the user asked for it in that message.
- **Never lower a coverage or mutation threshold, and never remove a gate.** Threshold miss → write the
  missing test. Bypasses (`SKIP_QODANA=1`, `--no-verify`) are gate removals: use only when the user says so.
- Tabs, not spaces. eslint + prettier both enforce.
- English only — identifiers, comments, fixtures. No exception.
- Domain query/mutation → **resource** svc. Token lifecycle → **authorization** svc.

## Gates

commit → secret guard, lint, coverage, Qodana. push → same + semgrep (SAST) + trivy (dependency
advisories) + mutation. All blocking. Why: [`REPO.md`](./REPO.md).

## GitNexus

- **Run `impact({target, repo})` before editing a symbol.**
- **Run `detect_changes()` before committing.** `repo:` is mandatory — always a `marketplace*` registry
  name.

Full CLI, tool reference and cross-repo group setup: [`AGENTS.md`](./AGENTS.md).
