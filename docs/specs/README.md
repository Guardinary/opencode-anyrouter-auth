# Maintained AnyRouter specifications

This directory is the maintained specification entry for the root AnyRouter plugin. It is not a workflow engine and contains no generated Trellis instructions.

1. Read the project [quality/safety constraints](<../../CONSTRAINTS.md>).
2. Read [runtime contracts](<runtime-contracts.md>) for concrete signatures, payloads, error behavior and regression obligations.
3. Read the user-facing [design](<../../DESIGN.md>), [security boundary](<../../SECURITY.md>) and [provenance](<../../UPSTREAM.md>) when those areas change.
4. Use the current task-specific engineering skills: inspect/clarify only material ambiguity, implement thin slices, reproduce bugs, verify affected behavior, and review the final changes. Do not lower gates to obtain passing results.

## Evidence and maintenance

[Historical final validation](<../validation/anyrouter-0.2.1/verification.md>) and [self-review](<../validation/anyrouter-0.2.1/adversarial-review.md>) retain the executed 0.2.1 checks and their limitations. These are dated execution records, not a claim that today's code or another runtime was rerun.

Unfilled reference-package templates are not product specifications. Reference source remains read-only unless separately authorized.

For new long-running work, keep one concise task note with scope, consequential decisions, progress, acceptance evidence and remaining work. Do not create parallel framework artifacts, install tools, initialize repositories or infer deployment authority from spec maintenance.
