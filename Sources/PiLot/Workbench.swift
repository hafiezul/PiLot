import AppKit
import SwiftUI

// MARK: - Fixture model

enum WorkbenchSessionState: String, CaseIterable, Hashable {
    case waitingApproval
    case waitingAnswer
    case failed
    case running
    case done

    var title: String {
        switch self {
        case .waitingApproval: "Waiting for approval"
        case .waitingAnswer: "Waiting for answer"
        case .failed: "Failed"
        case .running: "Running"
        case .done: "Done"
        }
    }

    var symbol: String {
        switch self {
        case .waitingApproval: "hand.raised.fill"
        case .waitingAnswer: "questionmark.bubble.fill"
        case .failed: "xmark.octagon.fill"
        case .running: "gearshape.2.fill"
        case .done: "checkmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .waitingApproval, .waitingAnswer: .orange
        case .failed: .red
        case .running: .blue
        case .done: .green
        }
    }
}

struct InterruptionFixture: Equatable {
    let title: String
    let detail: String
    let primaryAction: String
}

struct ActivityFixture: Identifiable, Equatable {
    enum Status: String {
        case succeeded = "Succeeded"
        case running = "Running"
        case waiting = "Waiting"
        case failed = "Failed"
    }

    let id: String
    let verb: String
    let target: String
    let status: Status
    let detail: String
}

struct WorkbenchSession: Identifiable, Equatable {
    let id: String
    let project: String
    var title: String
    var state: WorkbenchSessionState
    var currentActivity: String
    let userPrompt: String
    let assistantSummary: String
    let activities: [ActivityFixture]
    var interruption: InterruptionFixture?
}

enum WorkbenchFixtures {
    static let sessions = [
        WorkbenchSession(
            id: "approval", project: "PiLot", title: "Repair auth handoff",
            state: .waitingApproval, currentActivity: "Allow xattr inspection",
            userPrompt: "Check why the unsigned app handoff fails and propose the smallest safe fix.",
            assistantSummary: "I found the installation guidance and checked the app before changing anything.",
            activities: [
                ActivityFixture(id: "read-install", verb: "Read", target: "docs/install.md", status: .succeeded, detail: "Unsigned builds require explicit user trust…"),
                ActivityFixture(id: "inspect-xattr", verb: "Shell", target: "xattr inspection", status: .waiting, detail: "xattr -l /Applications/PiLot.app"),
            ],
            interruption: InterruptionFixture(title: "Allow shell command?", detail: "Run xattr inspection for /Applications/PiLot.app.", primaryAction: "Allow once")
        ),
        WorkbenchSession(
            id: "answer", project: "PiLot", title: "Choose recovery policy",
            state: .waitingAnswer, currentActivity: "One question needs an answer",
            userPrompt: "Clarify what happens when the last transcript line is incomplete.",
            assistantSummary: "The original bytes are preserved. Choose how the fixture should continue.",
            activities: [ActivityFixture(id: "question-policy", verb: "Question", target: "Recovery policy", status: .waiting, detail: "Preserve and repair, or open read-only?")],
            interruption: InterruptionFixture(title: "How should this session continue?", detail: "The fixture can preserve the source and repair its incomplete tail.", primaryAction: "Preserve and repair")
        ),
        WorkbenchSession(
            id: "failed", project: "PiLot", title: "Check migration tests",
            state: .failed, currentActivity: "Process exited with status 1",
            userPrompt: "Run the migration checks and report any failure.",
            assistantSummary: "The fixture process stopped before the checks completed.",
            activities: [ActivityFixture(id: "test-migration", verb: "Test", target: "Migration checks", status: .failed, detail: "Process exited with status 1")]
        ),
        WorkbenchSession(
            id: "running", project: "PiLot", title: "Specify recovery states",
            state: .running, currentActivity: "Reading Pi RPC docs",
            userPrompt: "Map the durable recovery states to the product specification.",
            assistantSummary: "I’m comparing the recovery contract with the RPC lifecycle.",
            activities: [
                ActivityFixture(id: "read-spec", verb: "Read", target: "spec.md", status: .succeeded, detail: "Preserve, then repair."),
                ActivityFixture(id: "read-rpc", verb: "Read", target: "Pi RPC docs", status: .running, detail: "Inspecting lifecycle events…"),
            ]
        ),
        WorkbenchSession(
            id: "done", project: "Cavecrew", title: "Refresh extension docs",
            state: .done, currentActivity: "3 files changed",
            userPrompt: "Refresh the extension guide and keep the examples concise.",
            assistantSummary: "Updated the guide and examples. The run settled with three changed files.",
            activities: [ActivityFixture(id: "edit-docs", verb: "Edit", target: "Extension docs", status: .succeeded, detail: "3 files changed")]
        ),
    ]
}

@MainActor
final class WorkbenchStore: ObservableObject {
    @Published var sessions = WorkbenchFixtures.sessions

    func session(id: String) -> WorkbenchSession? { sessions.first { $0.id == id } }

    func answerInterruption(for id: String) {
        update(id) { session in
            session.interruption = nil
            session.state = .running
            session.currentActivity = "Continuing after response"
        }
    }

    func declineInterruption(for id: String) {
        update(id) { session in
            session.interruption = nil
            session.state = .done
            session.currentActivity = "Request declined"
        }
    }

    func retry(_ id: String) {
        update(id) { session in
            session.state = .running
            session.currentActivity = "Retrying fixture run"
        }
    }

    func stop(_ id: String) {
        update(id) { session in
            session.interruption = nil
            session.state = .done
            session.currentActivity = "Session stopped"
        }
    }

    func send(_ text: String, to id: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        update(id) { session in
            session.state = .running
            session.currentActivity = "Working on your message"
        }
    }

    func newSession() -> String {
        let id = "fixture-\(sessions.count + 1)"
        sessions.insert(
            WorkbenchSession(
                id: id, project: "PiLot", title: "Untitled session", state: .done,
                currentActivity: "Ready for a message", userPrompt: "Start with a message below.",
                assistantSummary: "This fixture session is ready.", activities: []
            ),
            at: sessions.firstIndex { $0.project != "PiLot" } ?? sessions.endIndex
        )
        return id
    }

    private func update(_ id: String, change: (inout WorkbenchSession) -> Void) {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        change(&sessions[index])
    }
}

// MARK: - Workbench

enum WorkbenchFocus: Hashable { case sidebar, composer }

struct WorkbenchActions {
    let openProject: () -> Void
    let newSession: () -> Void
    let focusSidebar: () -> Void
    let focusComposer: () -> Void
    let toggleInspector: () -> Void
    let stopSession: () -> Void
}

private struct WorkbenchActionsKey: FocusedValueKey {
    typealias Value = WorkbenchActions
}

extension FocusedValues {
    var workbenchActions: WorkbenchActions? {
        get { self[WorkbenchActionsKey.self] }
        set { self[WorkbenchActionsKey.self] = newValue }
    }
}

struct WorkbenchView: View {
    @ObservedObject var engine: PiEngine
    @ObservedObject var projects: ProjectStore
    @StateObject private var store = WorkbenchStore()
    @SceneStorage("selectedSession") private var selectedSessionID = "approval"
    @SceneStorage("inspectorPresented") private var inspectorPresented = true
    @SceneStorage("composerDraft") private var draft = ""
    @State private var inspectorScope = "Last turn"
    @State private var selectedFile = "docs/install.md"
    @State private var wasNarrow = false
    @FocusState private var focus: WorkbenchFocus?

    private var selectedSession: WorkbenchSession {
        store.session(id: selectedSessionID) ?? store.sessions[0]
    }

    private var hasLiveSession: Bool { projects.activeProject?.access == .trusted }

    var body: some View {
        GeometryReader { geometry in
            NavigationSplitView {
                ProjectNavigator(
                    sessions: store.sessions,
                    selection: $selectedSessionID,
                    engineStatus: engine.status,
                    recents: projects.index.recents,
                    liveProject: projects.activeProject,
                    reopen: { url in Task { await requestOpen(url) } }
                )
                .focused($focus, equals: .sidebar)
                .navigationSplitViewColumnWidth(min: 210, ideal: 245, max: 320)
            } detail: {
                if selectedSessionID == "live", hasLiveSession {
                    LiveSessionDetail(
                        engine: engine,
                        draft: $draft,
                        composerFocus: $focus,
                        showInspector: { inspectorPresented.toggle() }
                    )
                } else {
                    SessionDetail(
                        session: selectedSession,
                        project: projects.activeProject,
                        draft: $draft,
                        composerFocus: $focus,
                        showInspector: { inspectorPresented.toggle() },
                        answer: { store.answerInterruption(for: selectedSessionID) },
                        decline: { store.declineInterruption(for: selectedSessionID) },
                        retry: { store.retry(selectedSessionID) },
                        stop: { store.stop(selectedSessionID) },
                        send: {
                            store.send(draft, to: selectedSessionID)
                            draft = ""
                        }
                    )
                }
            }
            .inspector(isPresented: $inspectorPresented) {
                ChangesInspector(scope: $inspectorScope, selectedFile: $selectedFile)
                    .inspectorColumnWidth(min: 260, ideal: 340, max: 480)
            }
            .onAppear { adaptInspector(to: geometry.size.width) }
            .onChange(of: geometry.size.width) { _, width in adaptInspector(to: width) }
        }
        .task {
            if let project = projects.activeProject { await requestOpen(project.url) }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first else { return false }
            Task { await requestOpen(url) }
            return true
        }
        .onOpenURL { url in Task { await requestOpen(url) } }
        .onChange(of: selectedSessionID) { _, _ in saveNavigation() }
        .onChange(of: inspectorPresented) { _, _ in saveNavigation() }
        .onChange(of: draft) { _, value in engine.saveDraft(value) }
        .onChange(of: engine.restoredDraft) { _, value in draft = value }
        .sheet(isPresented: Binding(
            get: { projects.pendingTrustURL != nil },
            set: { if !$0 { projects.pendingTrustURL = nil } }
        )) {
            if let url = projects.pendingTrustURL {
                ProjectTrustSheet(
                    project: url,
                    trust: { Task { await resolveTrust(url, trusted: true) } },
                    decline: { Task { await resolveTrust(url, trusted: false) } }
                )
            }
        }
        .alert("Project could not be opened", isPresented: Binding(
            get: { projects.errorMessage != nil },
            set: { if !$0 { projects.errorMessage = nil } }
        )) { Button("OK") { projects.errorMessage = nil } } message: {
            Text(projects.errorMessage ?? "Unknown error")
        }
        .focusedSceneValue(\.workbenchActions, WorkbenchActions(
            openProject: chooseProject,
            newSession: {
                if hasLiveSession {
                    engine.newSession()
                    selectedSessionID = "live"
                } else {
                    selectedSessionID = store.newSession()
                }
                focus = .composer
            },
            focusSidebar: { focus = .sidebar },
            focusComposer: { focus = .composer },
            toggleInspector: { inspectorPresented.toggle() },
            stopSession: {
                if selectedSessionID == "live" { engine.stopSession() }
                else { store.stop(selectedSessionID) }
            }
        ))
    }

    private func adaptInspector(to width: CGFloat) {
        let isNarrow = width < 900
        if isNarrow && !wasNarrow { inspectorPresented = false }
        wasNarrow = isNarrow
    }

    private func chooseProject() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Open Project"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await requestOpen(url) }
    }

    private func requestOpen(_ url: URL) async {
        guard let resources = Bundle.main.resourceURL,
              let result = await projects.inspect(url, resources: resources)
        else { return }
        switch result.status {
        case .unknown:
            break
        case .trusted, .notRequired:
            finishOpen(URL(fileURLWithPath: result.path, isDirectory: true), access: .trusted, resources: resources)
        case .declined:
            finishOpen(URL(fileURLWithPath: result.path, isDirectory: true), access: .readOnly, resources: resources)
        }
    }

    private func resolveTrust(_ url: URL, trusted: Bool) async {
        guard let resources = Bundle.main.resourceURL,
              let project = await projects.saveTrust(url, trusted: trusted, resources: resources)
        else { return }
        restoreNavigation(project)
        if trusted { engine.openProject(project.url, resources: resources) }
        else { engine.openSafeSurface(resources: resources) }
    }

    private func finishOpen(_ url: URL, access: ProjectRecord.Access, resources: URL) {
        guard let project = projects.open(url, access: access) else { return }
        restoreNavigation(project)
        if access == .trusted { engine.openProject(project.url, resources: resources) }
        else { engine.openSafeSurface(resources: resources) }
    }

    private func restoreNavigation(_ project: ProjectRecord) {
        selectedSessionID = store.session(id: project.selectedSessionID) == nil ? "approval" : project.selectedSessionID
        inspectorPresented = project.inspectorPresented
    }

    private func saveNavigation() {
        projects.updateNavigation(selectedSessionID: selectedSessionID, inspectorPresented: inspectorPresented)
    }
}

private struct LiveSessionDetail: View {
    @ObservedObject var engine: PiEngine
    @Binding var draft: String
    let composerFocus: FocusState<WorkbenchFocus?>.Binding
    let showInspector: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: engine.session.isRunning ? "gearshape.2.fill" : engine.session.isSettled ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(engine.session.isRunning ? .blue : engine.session.isSettled ? .green : .secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Pi session").font(.headline)
                    Text(engine.status).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Changes", systemImage: "sidebar.right", action: showInspector)
                Button("Abort", action: engine.abort)
                    .disabled(!engine.session.isRunning)
                Button("Stop Session", role: .destructive, action: engine.stopSession)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .padding(.horizontal, 16)
            .frame(minHeight: 54)

            if let recovery = engine.recovery {
                RecoveryBanner(
                    recovery: recovery,
                    forkRequired: engine.ownershipRequiresFork,
                    restart: engine.restartRecoveredSession,
                    fork: engine.forkRecoveredSession
                )
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if !engine.session.lastPrompt.isEmpty {
                        UserMessage(text: engine.session.lastPrompt)
                    }
                    if !engine.session.assistantText.isEmpty {
                        Text(engine.session.assistantText)
                            .textSelection(.enabled)
                            .frame(maxWidth: 760, alignment: .leading)
                            .accessibilityLabel("Assistant: \(engine.session.assistantText)")
                    }
                    ForEach(engine.session.orderedTools) { tool in
                        LiveToolRow(tool: tool)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 22)
                .frame(maxWidth: .infinity)
            }
            Divider()
            LiveComposer(engine: engine, draft: $draft, focus: composerFocus)
        }
        .navigationTitle("Pi session")
    }
}

private struct RecoveryBanner: View {
    let recovery: RecoveredSession
    let forkRequired: Bool
    let restart: () -> Void
    let fork: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                .font(.headline)
            Text(detail)
                .font(.callout)
            HStack {
                if recovery.actions.isEmpty, !forkRequired {
                    Button("Restart session", action: restart).buttonStyle(.borderedProminent)
                }
                Button("Fork preserved work", action: fork)
                if let copy = recovery.recoveryCopy {
                    Text("Original preserved: \(copy.lastPathComponent)")
                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.10))
        .accessibilityElement(children: .contain)
    }

    private var title: String {
        if forkRequired { return "Writer ownership is uncertain" }
        if !recovery.actions.isEmpty { return "Transcript recovery needs your choice" }
        return "Session was interrupted"
    }

    private var detail: String {
        if forkRequired { return "This window remains read-only. Fork to obtain a new session, writer lease, and process." }
        if !recovery.actions.isEmpty { return "Malformed durable data was left unchanged. Fork verified entries, or use the preserved original for read-only export." }
        return "\(recovery.validEntryCount) durable transcript entries and your composer draft were restored. Restart will not retry the unfinished prompt."
    }
}

private struct LiveToolRow: View {
    let tool: PiToolRun
    @State private var expanded = true

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(tool.output.isEmpty ? "Waiting for output…" : tool.output)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(.leading, 20)
        } label: {
            HStack {
                Label(tool.name, systemImage: symbol)
                Spacer()
                Text(status).font(.caption).foregroundStyle(.secondary)
                Text(tool.id).font(.caption2.monospaced()).foregroundStyle(.tertiary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(tool.name), call ID \(tool.id), \(status)")
        }
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) { Divider() }
    }

    private var status: String {
        switch tool.status {
        case .running: "Running"
        case .succeeded: "Succeeded"
        case .failed: "Failed"
        }
    }

    private var symbol: String {
        switch tool.status {
        case .running: "gearshape.2"
        case .succeeded: "checkmark.circle"
        case .failed: "xmark.octagon"
        }
    }
}

private struct LiveComposer: View {
    @ObservedObject var engine: PiEngine
    @Binding var draft: String
    let focus: FocusState<WorkbenchFocus?>.Binding

    var body: some View {
        VStack(spacing: 0) {
            TextEditor(text: $draft)
                .focused(focus, equals: .composer)
                .frame(minHeight: 54, maxHeight: 120)
                .padding(6)
                .accessibilityLabel("Message Pi")
                .onKeyPress(keys: [.return]) { press in
                    guard !press.modifiers.contains(.shift) else { return .ignored }
                    submit()
                    return .handled
                }
            Divider()
            HStack(spacing: 8) {
                Picker("Model", selection: Binding(
                    get: { engine.session.model },
                    set: { if let model = $0 { engine.setModel(model) } }
                )) {
                    if engine.session.model == nil { Text("Choose model").tag(PiModel?.none) }
                    ForEach(engine.session.models) { model in Text(model.name).tag(Optional(model)) }
                }
                .labelsHidden()
                .frame(maxWidth: 220)
                .disabled(engine.session.isRunning || engine.configurationPending)

                Picker("Thinking", selection: Binding(
                    get: { engine.session.thinkingLevel },
                    set: engine.setThinkingLevel
                )) {
                    ForEach(PiThinkingLevel.allCases) { level in Text(level.title).tag(level) }
                }
                .labelsHidden()
                .frame(maxWidth: 130)
                .disabled(engine.session.isRunning || engine.configurationPending || engine.session.model?.reasoning != true)

                if engine.configurationPending { ProgressView().controlSize(.small) }
                Spacer()
                Button("Send", systemImage: "arrow.up", action: submit)
                    .buttonStyle(.borderedProminent)
                    .disabled(!engine.isReady || engine.session.isRunning || engine.configurationPending || engine.session.model == nil || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .controlSize(.small)
            .padding(7)
        }
        .background(.background, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator))
        .padding(16)
    }

    private func submit() {
        guard !engine.session.isRunning, !engine.configurationPending, engine.session.model != nil else { return }
        engine.sendPrompt(draft)
        draft = ""
    }
}

private struct ProjectNavigator: View {
    let sessions: [WorkbenchSession]
    @Binding var selection: String
    let engineStatus: String
    let recents: [ProjectRecord]
    let liveProject: ProjectRecord?
    let reopen: (URL) -> Void

    private var projects: [String] {
        sessions.reduce(into: []) { result, session in
            if !result.contains(session.project) { result.append(session.project) }
        }
    }

    var body: some View {
        List(selection: $selection) {
            if !recents.isEmpty {
                Section("Recents") {
                    ForEach(recents) { project in
                        Button { reopen(project.url) } label: {
                            Label(project.name, systemImage: project.access == .trusted ? "folder" : "lock.fill")
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Reopen \(project.name), \(project.access == .trusted ? "trusted" : "read only")")
                    }
                }
            }
            if let liveProject, liveProject.access == .trusted {
                Section(liveProject.name) {
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles")
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Pi session")
                            Text(engineStatus).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .tag("live")
                    .accessibilityLabel("Pi session, \(engineStatus)")
                }
            }
            ForEach(projects, id: \.self) { project in
                Section(project) {
                    ForEach(sessions.filter { $0.project == project }) { session in
                        SessionRow(session: session)
                            .tag(session.id)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Projects")
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 7) {
                Image(systemName: "cpu")
                Text(engineStatus).lineLimit(1)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            .accessibilityElement(children: .combine)
        }
        .accessibilityLabel("Projects and sessions")
    }
}

private struct SessionRow: View {
    let session: WorkbenchSession

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: session.state.symbol)
                .foregroundStyle(session.state.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title).lineLimit(1)
                Text(session.state.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if session.interruption != nil {
                Text("Needs you")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.title), \(session.state.title)")
    }
}

private struct SessionDetail: View {
    let session: WorkbenchSession
    let project: ProjectRecord?
    @Binding var draft: String
    let composerFocus: FocusState<WorkbenchFocus?>.Binding
    let showInspector: () -> Void
    let answer: () -> Void
    let decline: () -> Void
    let retry: () -> Void
    let stop: () -> Void
    let send: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            sessionHeader
            if project?.access == .readOnly {
                Label("Read-only project — project settings and executable resources are not loaded.", systemImage: "lock.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                    .background(.quaternary)
            }
            if session.project == "PiLot" {
                Label("Shared project root — edits from these fixture sessions may conflict.", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                    .background(Color.orange.opacity(0.10))
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    UserMessage(text: session.userPrompt)
                    VStack(alignment: .leading, spacing: 10) {
                        Text(session.assistantSummary)
                            .frame(maxWidth: 720, alignment: .leading)
                        ForEach(session.activities) { ActivityRow(activity: $0) }
                        if session.interruption != nil {
                            Label("Input requested — pinned above the composer", systemImage: "pin.fill")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .accessibilityLabel("Input requested. The request is also pinned above the composer.")
                        }
                    }
                    .frame(maxWidth: 760, alignment: .leading)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 22)
                .frame(maxWidth: .infinity)
            }
            Divider()
            if let interruption = session.interruption {
                InterruptionView(interruption: interruption, answer: answer, decline: decline, stop: stop)
            }
            Composer(
                draft: $draft,
                focus: composerFocus,
                isRunning: session.state == .running,
                isReadOnly: project?.access == .readOnly,
                send: send
            )
        }
        .navigationTitle(session.title)
    }

    private var sessionHeader: some View {
        HStack(spacing: 10) {
            Image(systemName: session.state.symbol)
                .foregroundStyle(session.state.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title).font(.headline)
                Text("\(session.state.title) · \(session.currentActivity)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if session.state == .failed {
                Button("Retry", action: retry)
            }
            Button("Changes", systemImage: "sidebar.right", action: showInspector)
            Button("Stop", action: stop)
                .disabled(session.state == .done)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .padding(.horizontal, 16)
        .frame(minHeight: 54)
        .background(.background)
        .accessibilityElement(children: .contain)
    }
}

private struct UserMessage: View {
    let text: String

    var body: some View {
        Text(text)
            .textSelection(.enabled)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Color.accentColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
            .frame(maxWidth: 680, alignment: .trailing)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityLabel("You: \(text)")
    }
}

private struct ActivityRow: View {
    let activity: ActivityFixture
    @State private var isExpanded: Bool

    init(activity: ActivityFixture) {
        self.activity = activity
        _isExpanded = State(initialValue: activity.status != .succeeded)
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            Text(activity.detail)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(.leading, 20)
                .padding(.bottom, 8)
        } label: {
            HStack {
                Label("\(activity.verb) · \(activity.target)", systemImage: symbol)
                Spacer()
                Text(activity.status.rawValue)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(activity.verb), \(activity.target), \(activity.status.rawValue)")
        }
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) { Divider() }
    }

    private var symbol: String {
        switch activity.status {
        case .succeeded: "checkmark.circle"
        case .running: "gearshape.2"
        case .waiting: "pause.circle"
        case .failed: "xmark.octagon"
        }
    }
}

private struct InterruptionView: View {
    let interruption: InterruptionFixture
    let answer: () -> Void
    let decline: () -> Void
    let stop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(interruption.title, systemImage: "hand.raised.fill")
                .font(.headline)
            Text(interruption.detail)
                .font(.callout)
            HStack {
                Button(interruption.primaryAction, action: answer)
                    .buttonStyle(.borderedProminent)
                Button("Decline", action: decline)
                Button("Stop session", role: .destructive, action: stop)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(.separator))
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Input needed: \(interruption.title)")
    }
}

private struct ProjectTrustSheet: View {
    @Environment(\.dismiss) private var dismiss
    let project: URL
    let trust: () -> Void
    let decline: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Trust this project?", systemImage: "hand.raised.fill")
                .font(.title2.bold())
            Text(project.path)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
            Text("Trusting allows Pi to load this project's settings and executable resources, install missing project packages, and run extensions with your normal user permissions. PiLot is not a sandbox.")
                .fixedSize(horizontal: false, vertical: true)
            Text("Choose Read Only to open the safe surface without loading those resources.")
                .foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Open Read Only") { decline() }
                Button("Trust and Open") { trust() }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(24)
        .frame(width: 520)
        .interactiveDismissDisabled()
        .accessibilityElement(children: .contain)
    }
}

private struct Composer: View {
    @Binding var draft: String
    let focus: FocusState<WorkbenchFocus?>.Binding
    let isRunning: Bool
    let isReadOnly: Bool
    let send: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            TextEditor(text: $draft)
                .font(.body)
                .scrollContentBackground(.hidden)
                .focused(focus, equals: .composer)
                .frame(minHeight: 54, maxHeight: 120)
                .padding(6)
                .accessibilityLabel(isReadOnly ? "Message Pi, unavailable in read-only mode" : "Message Pi")
                .disabled(isReadOnly)
                .onKeyPress(keys: [.return]) { press in
                    guard !press.modifiers.contains(.shift) else { return .ignored }
                    send()
                    return .handled
                }
            Divider()
            HStack(spacing: 8) {
                Button("Context", systemImage: "plus") {}
                    .disabled(isReadOnly)
                Menu("Claude Sonnet 4") { Button("Claude Sonnet 4") {} }
                    .disabled(isReadOnly)
                Menu("High thinking") { Button("High") {} }
                    .disabled(isReadOnly)
                Spacer()
                Button(isRunning ? "Follow up" : "Send", systemImage: "arrow.up", action: send)
                    .buttonStyle(.borderedProminent)
                    .disabled(isReadOnly || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .keyboardShortcut(.return, modifiers: [])
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .padding(7)
        }
        .background(.background, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator))
        .padding(16)
        .accessibilityElement(children: .contain)
    }
}

private struct ChangesInspector: View {
    @Binding var scope: String
    @Binding var selectedFile: String
    private let files = ["docs/install.md", "README.md"]

    var body: some View {
        VStack(spacing: 0) {
            Picker("Change scope", selection: $scope) {
                Text("Last turn").tag("Last turn")
                Text("Workspace").tag("Workspace")
            }
            .pickerStyle(.segmented)
            .padding(10)

            List(files, id: \.self, selection: $selectedFile) { file in
                HStack {
                    Text(file).lineLimit(1)
                    Spacer()
                    Text(file == files[0] ? "+8 −2" : "+2")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .tag(file)
                .accessibilityLabel("\(file), \(file == files[0] ? "8 additions, 2 deletions" : "2 additions")")
            }
            .frame(minHeight: 115, maxHeight: 150)

            Divider()
            ScrollView([.horizontal, .vertical]) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("@@ Installation guidance @@").foregroundStyle(.secondary)
                    DiffLine(symbol: "−", text: "Open System Settings manually", color: .red)
                    DiffLine(symbol: "+", text: "Verify the downloaded DMG path.", color: .green)
                    DiffLine(symbol: "+", text: "Run xattr only for that exact path.", color: .green)
                }
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(12)
            }
            Spacer(minLength: 0)
        }
        .navigationTitle("Changes")
        .accessibilityLabel("Read-only changes inspector")
    }
}

private struct DiffLine: View {
    let symbol: String
    let text: String
    let color: Color

    var body: some View {
        Text("\(symbol) \(text)")
            .padding(.horizontal, 3)
            .background(color.opacity(0.10))
            .accessibilityLabel("\(symbol == "+" ? "Added" : "Removed") line: \(text)")
    }
}
