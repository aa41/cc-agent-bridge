# Review checklist

Go through this before `bridge apply`. Facts come from the diff and from commands you run, not from the worker's report.

## Scope
- [ ] `touched_files` matches the brief; nothing unexpected (lockfiles, config, generated files, unrelated reformatting).
- [ ] No deleted tests, skipped tests (`.skip`, `xit`, `@Ignore`) or weakened assertions.
- [ ] No debugging leftovers (console.log, print, commented-out code, TODOs the brief did not ask for).

## Correctness
- [ ] Each acceptance criterion is met; trace the code path for at least the main case.
- [ ] Edge cases: empty input, errors, concurrency, nulls, boundaries named in the brief.
- [ ] Error handling follows the codebase's existing pattern.

## Verification (run yourself, inside `workdir`)
- [ ] The verification commands from the brief pass.
- [ ] Build / type-check / lint pass where the project has them.
- [ ] The worker's `tests` claims match what you observed; note any mismatch to the user.

## Fit
- [ ] Follows the conventions of surrounding code (naming, structure, comment density).
- [ ] No new dependencies, secrets, network calls or permissions that the brief did not ask for.

## Decision
- All good → `bridge apply <run_id>`.
- Fixable issues → write findings (file:line, expected behaviour, check that must pass) → `bridge resume`.
- Wrong approach → discard (`bridge clean`), sharpen the brief, rerun or do it yourself.
