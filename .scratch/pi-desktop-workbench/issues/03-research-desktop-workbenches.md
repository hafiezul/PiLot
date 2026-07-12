# Research native agent workbench patterns

Type: research
Status: resolved
Blocked by:

## Question

What product and macOS interaction patterns should PiLot adopt or reject from current agent workbenches such as Codex desktop, Claude Code's desktop surfaces, and t3code-style apps?

Produce a linked evidence-backed Markdown comparison focused on workflows, information architecture, multi-session operation, files/diffs, tool activity and approvals, keyboarding, onboarding, trust, accessibility, and native macOS conventions—not visual imitation.

## Answer

Adopt a native project-and-session workbench: source-list navigation with visible attention states, a structured session timeline, a stable composer with inline scoped approvals, and a read-only last-turn/workspace diff inspector that opens files in existing tools. Support parallel Pi sessions without making Git worktrees the v1 session model. Reject chat-only navigation, embedded IDE surfaces, default full access, terminal-painted UI, and web-style imitation of macOS controls. The detailed evidence, interaction contract, accessibility requirements, and handoffs are in [Native agent workbench patterns for PiLot](../research/native-agent-workbench-patterns.md).
