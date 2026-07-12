# Choose macOS desktop architecture

Type: research
Status: resolved
Blocked by: 01, 04, 05, 07

## Question

Which minimal desktop architecture and framework choice best satisfies the proven Pi integration requirements and workbench interaction model while delivering native macOS behavior, accessibility, keyboarding, menus, windows, drag/drop, performance, and maintainability?

Produce a linked evidence-backed options analysis and recommendation, including process boundaries and failure containment. Framework identity is not a goal by itself.

## Answer

[macOS desktop architecture options](../research/macos-desktop-architecture.md) selects a macOS 14+ SwiftUI-first app with narrow AppKit escape hatches and one supervised, bundle-relative Pi RPC subprocess per live session. The native host owns presentation and supervision; each session controller actor owns strict stdio JSONL transport to its pinned Node/Pi runtime. Process exits interrupt only their session and never trigger prompt replay. Electron, Tauri, AppKit-only, XPC, a local server, and a runtime database add boundaries or complexity without satisfying a current requirement better.
