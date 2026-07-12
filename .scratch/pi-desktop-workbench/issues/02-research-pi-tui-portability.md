# Map Pi TUI capabilities to desktop

Type: research
Status: resolved
Blocked by:

## Question

Which Pi TUI capabilities and extension APIs can be represented in a native desktop workbench unchanged, through an adapter, through a redesigned desktop interaction, or not safely at all?

Produce an extensive, evidence-backed Markdown capability matrix linked here. Cover core conversation flow, streaming, tool calls and approvals, files/diffs, commands, models, sessions, extensions, custom tools, TUI components, themes, keybindings, prompts, skills, errors, cancellation, and any other surface found in current Pi documentation and source.

## Answer

[Pi TUI-to-desktop capability matrix](../research/pi-tui-to-desktop-capability-matrix.md) classifies current Pi v0.80.6 surfaces as unchanged engine semantics, native adapters, redesigned desktop interactions, or unsafe to port. Most engine behavior is reusable; terminal presentation is not. Extension compatibility must be tiered: backend hooks/tools/commands run in Pi, RPC-supported dialogs and simple UI requests can be adapted, and arbitrary TUI components, renderers, editors, shortcuts, themes, and terminal input cannot be promised in a native workbench.
