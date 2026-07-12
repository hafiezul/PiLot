import SwiftUI

@main
struct PiLotApp: App {
    @StateObject private var supervisor = SessionSupervisor()
    @StateObject private var projects = ProjectStore()

    var body: some Scene {
        WindowGroup("PiLot", id: "workbench") {
            WorkbenchView(supervisor: supervisor, projects: projects)
                .frame(minWidth: 760, minHeight: 560)
                .task { startEngine() }
        }
        .defaultSize(width: 1180, height: 760)
        .windowStyle(.titleBar)
        .commands { PiLotCommands() }

        Settings {
            SettingsView(engine: supervisor.runtime, notifications: supervisor.notifications)
                .frame(width: 460, height: 320)
                .task { startEngine() }
        }

        Window("PiLot Help", id: "help") {
            HelpView()
                .frame(minWidth: 420, minHeight: 260)
        }
    }

    private func startEngine() {
        if let resources = Bundle.main.resourceURL {
            supervisor.startRuntime(resources: resources)
        }
    }
}

private struct PiLotCommands: Commands {
    @Environment(\.openWindow) private var openWindow
    @FocusedValue(\.workbenchActions) private var actions

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Window") { openWindow(id: "workbench") }
                .keyboardShortcut("n")
            Button("Open Project…") { actions?.openProject() }
                .keyboardShortcut("o")
                .disabled(actions == nil)
            Divider()
            Button("New Session") { actions?.newSession() }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(actions == nil)
        }

        CommandMenu("Session") {
            Button("Focus Composer") { actions?.focusComposer() }
                .keyboardShortcut("l", modifiers: [.command, .option])
                .disabled(actions == nil)
            Divider()
            Button("Stop Session") { actions?.stopSession() }
                .keyboardShortcut(".", modifiers: [.command])
                .disabled(actions == nil)
        }

        CommandGroup(after: .sidebar) {
            Button("Focus Sidebar") { actions?.focusSidebar() }
                .keyboardShortcut("1", modifiers: [.command, .control])
                .disabled(actions == nil)
            Button("Show or Hide Inspector") { actions?.toggleInspector() }
                .keyboardShortcut("i", modifiers: [.command, .option])
                .disabled(actions == nil)
        }

        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") {}
                .disabled(true)
        }

        CommandGroup(replacing: .help) {
            Button("PiLot Help") { openWindow(id: "help") }
                .keyboardShortcut("?", modifiers: [.command])
        }
    }
}

private struct SettingsView: View {
    @ObservedObject var engine: PiEngine
    @ObservedObject var notifications: SessionNotifications
    private let versions = VersionInfo.current

    var body: some View {
        Form {
            Section("Bundled runtime") {
                versionRow("PiLot", versions.pilot)
                versionRow("Pi", versions.pi)
                versionRow("Node", versions.node)
                versionRow("macOS", versions.macOS)
                versionRow("CPU", versions.cpu)
            }
            Section("Status") {
                Label(engine.status, systemImage: engine.isReady ? "checkmark.circle.fill" : "gearshape.2")
                    .foregroundStyle(engine.isReady ? .green : .secondary)
            }
            Section("Notifications") {
                Toggle("Notify when attention is needed", isOn: Binding(
                    get: { notifications.enabled },
                    set: notifications.setEnabled
                ))
                Text(notifications.authorization)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func versionRow(_ name: String, _ value: String) -> some View {
        LabeledContent(name) {
            Text(value).font(.system(.body, design: .monospaced))
        }
    }
}

private struct HelpView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("PiLot workbench", systemImage: "hammer")
                .font(.title2.bold())
            Text("Choose a fixture session in the sidebar to exercise running, waiting, failed, and done states. Answer pinned requests above the composer, or inspect the fixture changes without leaving the timeline.")
                .frame(maxWidth: 62 * 8, alignment: .leading)
            Text("Keyboard: ⌃⌘1 focuses the sidebar, ⌥⌘L focuses the composer, and ⌥⌘I toggles the inspector.")
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(28)
    }
}

struct VersionInfo {
    let pilot: String
    let pi: String
    let node: String
    let macOS: String
    let cpu: String

    static var current: VersionInfo {
        let manifest = Bundle.main.url(forResource: "versions", withExtension: "json", subdirectory: "PiEngine")
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode(RuntimeVersions.self, from: $0) }
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "local"
        return VersionInfo(
            pilot: "\(short) (\(build))",
            pi: manifest?.pi ?? "unknown",
            node: manifest?.node ?? "unknown",
            macOS: ProcessInfo.processInfo.operatingSystemVersionString,
            cpu: RuntimeLayout.currentArchitecture
        )
    }
}

private struct RuntimeVersions: Decodable {
    let pi: String
    let node: String
}
