# Review: changes since last commit

## Findings

### High: review hook is registered twice and can race itself

`.claude/settings.json:2` registers a `Stop` hook that runs `codex exec ... planning/REVIEW.md`, while `.claude/settings.json:14` also enables `independent-reviewer@ed-tools`; that plugin contains the same `Stop` hook at `independent-reviewer/hooks/hooks.json:2` and the same command at `independent-reviewer/hooks/hooks.json:8`.

If Claude loads enabled plugin hooks in addition to project hooks, every assistant stop will launch two independent Codex review processes. Both processes write the same `planning/REVIEW.md` path, so the result is nondeterministic: one process can overwrite the other, one may review a partially written file from the other, and every stop costs roughly twice the runtime.

Recommendation: keep the hook in exactly one place. Prefer either enabling the plugin and removing the duplicated hook from `.claude/settings.json`, or keeping the local hook and disabling/removing the plugin hook.

### Medium: enabling the reviewer plugin disables previously enabled project plugins

The old `.claude/settings.json` enabled `frontend-design@claude-plugins-official`, `context7@claude-plugins-official`, and `playwright@claude-plugins-official`. The new file replaces the whole `enabledPlugins` map with only `independent-reviewer@ed-tools` at `.claude/settings.json:14`.

That is a behavior regression for future work in this repo: the plan still calls for frontend design work and Playwright E2E coverage, but those project-level plugins are no longer enabled. If this was intended only to add an independent reviewer, the previous plugin entries should be preserved.

Recommendation: merge the new plugin entry into the existing map instead of replacing it.

### Medium: the automatic review command reviews its own output on later runs

The hook command in `.claude/settings.json:8` and `independent-reviewer/hooks/hooks.json:8` asks Codex to review "changes since last commit" and write the result to `planning/REVIEW.md`. After the first hook run, `planning/REVIEW.md` itself is an uncommitted change since the last commit. Subsequent hook runs can therefore review and rewrite their own previous report, producing noisy or self-referential findings unrelated to the user's actual code/doc changes.

Recommendation: either have the reviewer exclude `planning/REVIEW.md` from its diff, write hook output outside the repository, or only run the hook when the previous review file has been committed/cleared.

## Notes

- I did not find issues in the README correction itself; it more accurately reflects that only the market-data backend exists right now.
- `git diff --check HEAD` did not report whitespace errors.
