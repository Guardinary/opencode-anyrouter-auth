# Project Agent Instructions

## Workflow

Use the current system/developer instructions and maintained user-level engineering workflow. This project no longer uses Trellis as its execution framework.

- Inspect the actual target, current source and relevant existing records before acting.
- Handle small, clear changes directly. Use task-specific engineering skills and proportionate planning for substantive changes.
- Reproduce bugs, fix the cause and protect important behavior with regression tests.
- Run relevant checks after the final affected change; review nontrivial changes and report actual evidence and remaining limits.
- Carry the user's authorization through ordinary local implementation and verification. Respect separate approval requirements for destructive operations, installation, secrets and remote actions.
- Do not initialize, run, update or archive through Trellis, or load Trellis workflow skills, unless the user explicitly re-adopts it.
- Do not replace Trellis with another specification framework automatically.

## Specifications and Quality Bar

Read [CONSTRAINTS.md](<CONSTRAINTS.md>) before writing code. Do not weaken it to make a change pass. Read the [specification entry](<docs/specs/README.md>) and relevant contracts before changing covered behavior.

Key historical acceptance evidence is retained under `docs/validation/`; it is dated evidence, not a claim of a fresh test run. The obsolete root framework directory was removed after verified migration. Do not recreate it or follow historical workflow tags.

Preserve maintained specifications, validation evidence and unrelated work. For new long-running work, use one concise task record rather than parallel framework artifacts.

## Project Safety and Scope

- Keep `reference/` repositories unchanged unless the user explicitly requests changes there.
- Protect account credentials and redact sensitive evidence. Do not treat offline fixtures as permission for live login, check-in, key mutation, deployment or publication.
- Preserve existing checks, assertions and safety boundaries; do not weaken them to obtain passing results.
- Follow the user's standing request to do the work personally without additional subagents unless they authorize delegation again.
