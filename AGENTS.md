# Project Development Rules

For feature work in this repository, use this order:

1. Before implementation, prove the real operation path to the user: entry point → user or agent action → data change or other side effect → observable result. Cite the actual component, API, and file involved, or demonstrate the path in the product. This proof is not a test.
2. Implement the requested main path with the smallest direct change that makes it work.
3. After implementation, demonstrate or verify only that direct operation path and give the result to the user for confirmation.
4. Before the user confirms the feature works, do not proactively add guardrails, mutation or regression tests, legacy compatibility protection, defensive extensions, or speculative fallback behavior.
5. User confirmation does not automatically authorize that follow-up work. Add targeted protection or tests only when the user explicitly asks for them, or when the user reports a concrete failure scenario that requires them.

The primary objective is to make the requested function work. Focus on the feature implementation itself and avoid over-design; safety, guardrails, and testing must not dominate the work or turn the feature into a surrounding engineering project. This rule supersedes the earlier standing instruction that every feature must be developed test-first. Test-first language in older issues does not apply unless the user restates it for that issue after this rule.

This ordering does not waive higher-priority safety or security requirements. Keep validation that is necessary at real external boundaries, such as user input or external APIs, but do not expand it into hypothetical protection beyond the requested path.

## Yuanse collaboration boundary

- Treat requests made through the Codex entry as organization, information architecture, workflow logic, board interaction, synchronization, deployment, or reporting-capability work. Do not change project content such as a song's concrete status, supplier, amount, date, or note unless the user explicitly asks Codex to make that content change.
- Project content is normally entered through OpenClaw/“龙虾” or edited directly in the web board. Codex owns the structure that makes those two content-entry paths comfortable and reliable.
- A structural field is not complete when it is only visible. For every new or changed field, keep one canonical data shape and verify the full contract: 龙虾 can write it → the fact database persists it → the board can display and directly edit it where appropriate → 龙虾 can read it back and use it in summaries or reports.
- Prefer structured manager commands over free-text parsing for content that drives board fields or reports. If a requested structure has no comfortable 龙虾 write path or no reportable read path, implement that path as part of the same structural change.
