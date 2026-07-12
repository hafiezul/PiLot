# Native agent workbench patterns for PiLot

Research date: 2026-07-12

## Recommendation

PiLot should be a **project-and-session workbench**, not a chat client and not a miniature IDE:

- Use a source-list sidebar for projects and resumable sessions, with visible running, waiting-for-input, failed, and completed states.
- Keep one focused session in the main pane. Present messages as the narrative and collapse routine tool activity into inspectable timeline rows.
- Make the composer the stable action point. Put context attachments, model/mode controls, and pending approvals adjacent to it rather than in transient overlays.
- Give files and diffs a dedicated inspector that can show either the last turn or all current workspace changes. Open files in the user's editor rather than building an editor in v1.
- Preserve Pi's safety semantics and make every approval name the action, target, scope, and persistence. Never default to unrestricted access merely to reduce clicks.
- Support parallel sessions, but do not invent Git worktree orchestration for v1. Pi sessions are the product unit; isolation can be added only after the MVP workflows establish a need.
- Use standard macOS windows, menus, focus, keyboard equivalents, drag/drop, accessibility roles, appearance, and reduced-motion behavior. Do not imitate web-app chrome.

## Evidence matrix

| Area | Codex desktop | Claude Code desktop/IDE surfaces | T3 Code | PiLot decision |
|---|---|---|---|---|
| Core unit | Projects contain parallel threads; local and worktree execution can be handed off safely.[^codex-worktrees] | Conversation history is searchable and resumable; multiple conversations can run in tabs or windows.[^claude-ide] | The durable model is Project → Thread → Turn/Activity; a provider Session is attached to a Thread.[^t3-encyclopedia] | **Adopt:** Project → Session. Keep Pi's own session identity authoritative; status is visible in the sidebar. |
| Information architecture | Sidebar navigation, focused thread, composer, built-in terminal, and toggleable diff/review pane.[^codex-commands][^codex-features] | Claude can live in a sidebar, editor tab, separate window, or terminal; status dots expose hidden-session attention needs.[^claude-ide] | Resizable/collapsible thread sidebar plus chat, terminal, preview, and diff surfaces.[^t3-sidebar][^t3-keys] | **Adopt the hierarchy, reject the surface count:** sidebar + session + optional inspector. External editor/terminal actions cover the rest initially. |
| Parallel work | Managed worktrees isolate tasks, preserve task/worktree association, support local handoff, and snapshot before cleanup.[^codex-worktrees] | Multiple conversations have independent history/context; CLI worktrees provide filesystem isolation.[^claude-ide] | New threads can preserve branch/worktree state or create a new environment.[^t3-keys] | **Adopt parallel session visibility. Defer isolation:** sharing a mutable project must show a conflict/writer warning; don't silently create worktrees. |
| Files and diffs | Review pane separates staged/unstaged/base comparisons, supports last-turn scope, inline comments, chunk/file stage and revert, commit, push, and PR.[^codex-review] | Native IDE diffs, selected-line references, plan annotation, checkpoints, and code/conversation rewind.[^claude-ide] | Each turn records changed files and stats; a tree opens a turn diff.[^t3-encyclopedia][^t3-files] | **Adopt:** changed-file summary in timeline and inspector scopes “Last turn” / “Workspace.” **Reject for v1:** staging, committing, PR creation, editing, and rewind—all expand PiLot into an IDE/VCS client. |
| Tool activity | A task can wait for approval; troubleshooting explicitly directs users to check that state.[^codex-troubleshooting] | Reasoning is collapsed; long-running command progress appears in status; background visibility is acknowledged as weaker than CLI.[^claude-ide] | Activities are first-class timeline records for approvals, tools, and failures.[^t3-encyclopedia] | **Adopt:** concise verb/target/status rows, streaming state, elapsed time, expandable input/output, and a persistent waiting indicator. Preserve full raw details on demand. |
| Approvals and trust | Sandbox and approval settings constrain actions; review remains separate from execution permission.[^codex-features] | Manual, Plan, and auto-edit modes are explicit. Anthropic warns that repetitive prompts cause approval fatigue and reports that bypassing permissions is unsafe; even classifier-based auto mode retains residual risk.[^claude-auto][^claude-ide] | Supervised mode prompts for commands/files, but “Full access” is the default; approval actions include once, session, decline, and cancel.[^t3-runtime][^t3-approval] | **Adopt scoped choices; reject T3's default:** use Pi's current policy as source of truth. Show “Allow once” and only engine-supported persistent scope. Separate “Decline” from “Stop session.” Never manufacture a broader grant than Pi supports. |
| Keyboarding | Searchable, customizable shortcuts include new/search/previous thread, sidebar, diff, terminal, and find.[^codex-commands][^codex-settings] | Focus toggle, new conversation, reopen closed session, file-selection reference, and standard VS Code command discovery.[^claude-ide] | Context-sensitive user keybindings exist, but configuration is a JSON file and several defaults overload familiar macOS commands.[^t3-keys] | **Adopt commands, reject hidden web key handling:** expose actions in the menu bar with standard shortcuts and discoverability. Reserve Return to send and Shift-Return for newline; support user rebinding only if native menus/settings make it cheap. |
| Onboarding | The desktop workspace emphasizes keeping tasks visible and inspecting outputs.[^codex-app] | Onboarding is a checklist and the GUI/CLI share settings and history.[^claude-ide] | Requires a separately installed and authenticated provider CLI; project docs call the product early-stage.[^t3-readme] | **Adopt existing setup:** detect Pi, show the exact executable/config/session roots in use, offer “Open Pi setup help” on failure, then open a project. No account funnel or duplicated provider setup. |
| macOS behavior | Current Codex documentation exposes desktop commands but is product-specific rather than a macOS interaction specification.[^codex-commands] | VS Code integration inherits IDE windows, tabs, diffs, command palette, and focus behavior.[^claude-ide] | Electron manually offsets controls for macOS traffic lights and handles app-level keys in web code.[^t3-sidebar] | **Reject imitation:** use native titlebar/toolbar/sidebar/menu/window restoration, file panels, Services/open-in actions, and drag/drop. Multiple project windows should behave as ordinary document-style Mac windows. |
| Accessibility | Public product docs reviewed here do not define a sufficient accessibility contract. | Standard IDE controls help, but custom agent surfaces still require explicit semantics. | Some controls have focus rings/labels, but source evidence is component-level rather than a product accessibility guarantee.[^t3-files][^t3-sidebar] | **Make binding:** keyboard-only operation, logical focus order, VoiceOver labels/values for session and tool states, announcements for approval/completion, text resizing, contrast, no color-only status, reduced motion, and standard controls where possible.[^apple-accessibility][^apple-keyboards][^apple-motion] |

## Interaction contract to carry into the MVP workflow and prototype tickets

### Sidebar

- Group sessions under project roots; allow collapse, search, rename, archive, and resume.
- Each session gets one status with text and icon: Running, Waiting for approval, Waiting for answer, Failed, or Done. Color is supplementary.
- Clicking a running session switches focus; it does not stop or re-parent the session.
- A new project opens through `NSOpenPanel`/standard folder selection; dropping a folder onto the sidebar is an equivalent path.

### Session timeline

- User and assistant prose stay prominent.
- Tool calls render as compact activity rows: `Read · path`, `Bash · command`, `Edit · N files`; running, succeeded, failed, and denied are explicit.
- Routine successful activity defaults collapsed. Failures, approvals, and user-input requests default expanded.
- Tool output is selectable/copyable and retains a raw view; terminal escape sequences are never the only representation.

### Composer and interruptions

- The composer remains in place while the session runs. Sending while busy follows Pi's supported steer/follow-up semantics rather than inventing a queue.
- File drops and file-picker selections become explicit context chips removable before send.
- An approval is inline near the composer and mirrored in sidebar/window attention state. It states exactly what will happen and offers only scopes supported by Pi.
- Notifications are opt-in and used only when the app/window is not active and a session needs input or completes.

### Inspector

- The default summary belongs to the turn that produced it; the inspector can switch to aggregate workspace changes.
- File rows show path, status, additions, and deletions. Selecting a row shows a read-only diff and offers **Open in Editor** / **Reveal in Finder**.
- Diff lines and status are accessible by text, not only red/green. Large diffs virtualize or paginate without blocking conversation input.

### Native command surface

At minimum, menu commands should cover New Window, Open Project, New Session, Close, Find, Focus Sidebar, Focus Composer, Show/Hide Inspector, Stop Session, Settings, and Help. Menu item availability reflects current state, and shortcuts appear there. Apple recommends full keyboard access and clear focus/selection behavior; PiLot should test both standard and system-wide Keyboard Navigation modes.[^apple-keyboards][^apple-focus]

## Patterns to reject explicitly

1. **Chat-only navigation.** It hides concurrent work and waiting states.
2. **A terminal transcript painted into a GUI.** Desktop semantics need structured messages, activities, approvals, and input requests.
3. **A built-in code editor/terminal/browser in v1.** External tools already solve these jobs; embedding them multiplies focus, accessibility, process, and security work.
4. **Default full access or one-click blanket permission.** Convenience cannot silently weaken the user's existing Pi policy.
5. **Git worktrees as the session model.** They are valuable isolation machinery, not a universal product concept, and require lifecycle/handoff/recovery behavior beyond the first specification.
6. **Unreadable tool-call exhaust.** Collapse routine activity without deleting or summarizing away inspectable evidence.
7. **Web-style custom titlebars, command handling, and context menus.** They reproduce native behavior incompletely and tend to miss accessibility and user-customized keyboard expectations.
8. **Visual imitation of Codex, Claude, or T3.** Reuse proven workflow ideas, not their branding, spacing, component kits, or information density.

## Risks and questions handed forward

- The MVP workflow decision must settle whether multiple simultaneously live sessions may target the same project root or whether PiLot warns/blocks based on Pi's one-writer session constraints.
- The first prototype must test whether the inspector is a trailing split pane or a separate window. Both are specifiable now; preference should come from task walkthroughs, not competitor mimicry.
- Architecture research must verify which native framework can meet the accessibility, menus, multi-window, drag/drop, large-timeline, and large-diff requirements without rebuilding AppKit behavior.
- Trust/distribution work must define notifications, shell/executable discovery, external-editor launching, file access prompts, and how unsigned-app trust messaging avoids conditioning users to dismiss unrelated warnings.

## Source notes

The comparison prioritizes first-party product documentation, Apple guidance, and source code. Codex documentation changed during research to describe Codex within the ChatGPT desktop app; claims above cite the current first-party pages rather than screenshots or third-party reviews. T3 Code is explicitly early-stage, so it is evidence of concrete design choices, not a quality baseline. No audited accessibility conformance reports were found for the compared products; absence is not evidence of inaccessibility.

[^codex-app]: OpenAI, [ChatGPT desktop app](https://developers.openai.com/codex/app).
[^codex-features]: OpenAI, [Codex app features](https://developers.openai.com/codex/app/features).
[^codex-worktrees]: OpenAI, [Worktrees](https://developers.openai.com/codex/app/worktrees).
[^codex-review]: OpenAI, [Code review](https://developers.openai.com/codex/app/review).
[^codex-commands]: OpenAI, [Codex app commands](https://developers.openai.com/codex/app/commands).
[^codex-settings]: OpenAI, [Codex app settings](https://developers.openai.com/codex/app/settings).
[^codex-troubleshooting]: OpenAI, [Codex app troubleshooting](https://developers.openai.com/codex/app/troubleshooting).
[^claude-ide]: Anthropic, [Use Claude Code in VS Code](https://docs.anthropic.com/en/docs/claude-code/ide-integrations).
[^claude-auto]: Anthropic, [How we built Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode).
[^t3-readme]: T3 Code, [README at researched revision](https://github.com/pingdotgg/t3code/blob/f61fa9499d96fee825492aba204593c37b27e0cb/README.md).
[^t3-encyclopedia]: T3 Code, [domain encyclopedia at researched revision](https://github.com/pingdotgg/t3code/blob/f61fa9499d96fee825492aba204593c37b27e0cb/docs/reference/encyclopedia.md).
[^t3-runtime]: T3 Code, [runtime modes at researched revision](https://github.com/pingdotgg/t3code/blob/f61fa9499d96fee825492aba204593c37b27e0cb/docs/architecture/runtime-modes.md).
[^t3-keys]: T3 Code, [keybindings at researched revision](https://github.com/pingdotgg/t3code/blob/f61fa9499d96fee825492aba204593c37b27e0cb/docs/user/keybindings.md).
[^t3-files]: T3 Code, [changed-files tree at researched revision](https://github.com/pingdotgg/t3code/blob/f61fa9499d96fee825492aba204593c37b27e0cb/apps/web/src/components/chat/ChangedFilesTree.tsx).
[^t3-approval]: T3 Code, [approval actions at researched revision](https://github.com/pingdotgg/t3code/blob/f61fa9499d96fee825492aba204593c37b27e0cb/apps/web/src/components/chat/ComposerPendingApprovalActions.tsx).
[^t3-sidebar]: T3 Code, [sidebar layout at researched revision](https://github.com/pingdotgg/t3code/blob/f61fa9499d96fee825492aba204593c37b27e0cb/apps/web/src/components/AppSidebarLayout.tsx).
[^apple-keyboards]: Apple, [Human Interface Guidelines: Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards).
[^apple-focus]: Apple, [Human Interface Guidelines: Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection).
[^apple-accessibility]: Apple, [Make your Mac app more accessible to everyone (WWDC25)](https://developer.apple.com/videos/play/wwdc2025/229/).
[^apple-motion]: Apple, [`accessibilityReduceMotion`](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilityReduceMotion).
