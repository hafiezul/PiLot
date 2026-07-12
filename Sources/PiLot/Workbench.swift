import AppKit
import SwiftUI
import UniformTypeIdentifiers

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

enum WorkbenchFocus: Hashable { case sidebar, composer, interruption(String) }

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
    @ObservedObject var supervisor: SessionSupervisor
    @ObservedObject var projects: ProjectStore
    @StateObject private var store = WorkbenchStore()
    @SceneStorage("selectedSession") private var selectedSessionID = "approval"
    @SceneStorage("activeProject") private var activeProjectID = ""
    @SceneStorage("inspectorPresented") private var inspectorPresented = true
    @SceneStorage("composerDraft") private var draft = ""
    @State private var inspectorScope = "Last turn"
    @State private var selectedFile = "docs/install.md"
    @State private var wasNarrow = false
    @State private var pendingCLISession: CLISessionRecord?
    @State private var windowID = UUID()
    @State private var windowAccess: SessionWindowAccess = .observer
    @State private var renamingSessionID: String?
    @State private var sessionTitle = ""
    @FocusState private var focus: WorkbenchFocus?

    private var selectedSession: WorkbenchSession {
        store.session(id: selectedSessionID) ?? store.sessions[0]
    }

    private var activeProject: ProjectRecord? {
        projects.index.recents.first { $0.id == activeProjectID } ?? projects.activeProject
    }

    private var selectedEngine: PiEngine? { supervisor.engine(for: selectedSessionID) }

    private var selectedProjectURL: URL? {
        supervisor.projectURL(for: selectedSessionID) ?? activeProject?.url
    }

    var body: some View {
        GeometryReader { geometry in
            NavigationSplitView {
                ProjectNavigator(
                    sessions: store.sessions,
                    selection: $selectedSessionID,
                    engineStatus: supervisor.runtime.status,
                    recents: projects.index.recents,
                    liveSessions: supervisor.sortedSessions,
                    cliSessions: supervisor.cliSessions,
                    reopen: { url in Task { await requestOpen(url) } },
                    continueCLI: continueCLISession,
                    rename: { session in
                        guard supervisor.windowAccess(to: session.id, from: windowID) == .owner else { return }
                        beginRenaming(session)
                    },
                    stop: { id in
                        guard supervisor.windowAccess(to: id, from: windowID) == .owner else { return }
                        supervisor.stopSession(id)
                    },
                    resume: { id in
                        guard supervisor.windowAccess(to: id, from: windowID) == .owner else { return }
                        supervisor.resumeSession(id)
                    },
                    archive: { id, archived in
                        guard supervisor.windowAccess(to: id, from: windowID) == .owner else { return }
                        supervisor.setArchived(archived, sessionID: id)
                    }
                )
                .focused($focus, equals: .sidebar)
                .navigationSplitViewColumnWidth(min: 210, ideal: 245, max: 320)
            } detail: {
                if let engine = selectedEngine {
                    LiveSessionDetail(
                        engine: engine,
                        peers: supervisor.peers(of: selectedSessionID),
                        isReadOnly: windowAccess == .observer || engine.ownershipRequiresFork,
                        draft: $draft,
                        stopSession: { supervisor.stopSession(selectedSessionID) },
                        composerFocus: $focus,
                        showInspector: { inspectorPresented.toggle() }
                    )
                    .id(selectedSessionID)
                } else {
                    SessionDetail(
                        session: selectedSession,
                        project: activeProject,
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
                ChangesInspector(
                    scope: $inspectorScope,
                    selectedFile: $selectedFile,
                    project: selectedProjectURL,
                    lastRunPaths: selectedEngine?.session.lastRunChangedPaths ?? []
                )
                .inspectorColumnWidth(min: 300, ideal: 380, max: 560)
            }
            .onAppear { adaptInspector(to: geometry.size.width) }
            .onChange(of: geometry.size.width) { _, width in adaptInspector(to: width) }
        }
        .task {
            supervisor.refreshCLIHistory()
            if let project = activeProject { await requestOpen(project.url) }
            if let destination = supervisor.notifications.destination { openNotification(destination) }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first else { return false }
            Task { await requestOpen(url) }
            return true
        }
        .onOpenURL { url in Task { await requestOpen(url) } }
        .onChange(of: selectedSessionID) { _, id in
            windowAccess = supervisor.windowAccess(to: id, from: windowID)
            saveNavigation()
        }
        .onChange(of: supervisor.notifications.destination) { _, destination in
            if let destination { openNotification(destination) }
        }
        .onChange(of: inspectorPresented) { _, _ in saveNavigation() }
        .onChange(of: draft) { _, value in selectedEngine?.saveDraft(value) }
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
        .onAppear { windowAccess = supervisor.windowAccess(to: selectedSessionID, from: windowID) }
        .onDisappear { supervisor.releaseWindow(windowID) }
        .alert("Rename session", isPresented: Binding(
            get: { renamingSessionID != nil },
            set: { if !$0 { renamingSessionID = nil } }
        )) {
            TextField("Session name", text: $sessionTitle)
            Button("Rename") {
                if let id = renamingSessionID { supervisor.renameSession(id, title: sessionTitle) }
                renamingSessionID = nil
            }
            Button("Cancel", role: .cancel) { renamingSessionID = nil }
        }
        .alert("Project could not be opened", isPresented: Binding(
            get: { projects.errorMessage != nil },
            set: { if !$0 { projects.errorMessage = nil } }
        )) { Button("OK") { projects.errorMessage = nil } } message: {
            Text(projects.errorMessage ?? "Unknown error")
        }
        .alert("CLI session fork failed", isPresented: Binding(
            get: { supervisor.cliContinuationFailure != nil },
            set: { if !$0 { supervisor.cliContinuationFailure = nil } }
        )) {
            Button("Retry") {
                if let session = pendingCLISession { continueCLISession(session) }
            }
            Button("Export Copy…") {
                if let failure = supervisor.cliContinuationFailure { exportRecoveryCopy(failure.recoveryCopy) }
            }
            Button("Salvage Verified Entries") {
                guard let session = pendingCLISession, let failure = supervisor.cliContinuationFailure else { return }
                salvageCLISession(session, failure: failure)
            }
            Button("Cancel", role: .cancel) { supervisor.cliContinuationFailure = nil }
        } message: {
            if let failure = supervisor.cliContinuationFailure {
                Text("\(failure.localizedDescription) \(failure.salvageSummary) Recovery copy: \(failure.recoveryCopy.path)")
            }
        }
        .focusedSceneValue(\.workbenchActions, WorkbenchActions(
            openProject: chooseProject,
            newSession: {
                if let project = activeProject, project.access == .trusted, let resources = Bundle.main.resourceURL {
                    selectedSessionID = supervisor.newSession(project: project.url, resources: resources)
                } else {
                    selectedSessionID = store.newSession()
                }
                focus = .composer
            },
            focusSidebar: { focus = .sidebar },
            focusComposer: { focus = .composer },
            toggleInspector: { inspectorPresented.toggle() },
            stopSession: {
                guard windowAccess == .owner else { return }
                if selectedEngine != nil { supervisor.stopSession(selectedSessionID) }
                else { store.stop(selectedSessionID) }
            }
        ))
    }

    private func beginRenaming(_ session: SupervisedSessionSummary) {
        renamingSessionID = session.id
        sessionTitle = session.title
    }

    private func openNotification(_ destination: NotificationDestination) {
        guard supervisor.index.session(id: destination.sessionID)?.projectPath == destination.projectPath else {
            supervisor.notifications.consumeDestination()
            return
        }
        if let project = projects.index.recents.first(where: { $0.path == destination.projectPath }) {
            activeProjectID = project.id
            projects.activeProjectID = project.id
        }
        selectedSessionID = destination.sessionID
        focus = destination.interruptionID.map(WorkbenchFocus.interruption) ?? .composer
        supervisor.notifications.consumeDestination()
    }

    private func continueCLISession(_ session: CLISessionRecord) {
        guard let project = activeProject, project.access == .trusted,
              let resources = Bundle.main.resourceURL else { return }
        pendingCLISession = session
        supervisor.cliContinuationFailure = nil
        Task {
            if let id = await supervisor.continueCLISession(session, project: project.url, resources: resources) {
                selectedSessionID = id
                pendingCLISession = nil
            }
        }
    }

    private func salvageCLISession(_ session: CLISessionRecord, failure: CLISessionContinuationFailure) {
        guard let project = activeProject, project.access == .trusted,
              let resources = Bundle.main.resourceURL else { return }
        supervisor.cliContinuationFailure = nil
        Task {
            if let id = await supervisor.salvageCLISession(session, failure: failure, project: project.url, resources: resources) {
                selectedSessionID = id
                pendingCLISession = nil
            }
        }
    }

    private func exportRecoveryCopy(_ source: URL) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = source.lastPathComponent
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            try Data(contentsOf: source).write(to: destination, options: .atomic)
            supervisor.cliContinuationFailure = nil
        } catch {
            projects.errorMessage = "Recovery copy could not be exported: \(error.localizedDescription)"
        }
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
        activeProjectID = project.id
        if trusted {
            inspectorPresented = project.inspectorPresented
            selectedSessionID = supervisor.openProject(project.url, resources: resources, preferredSessionID: project.selectedSessionID)
        } else {
            restoreNavigation(project)
        }
    }

    private func finishOpen(_ url: URL, access: ProjectRecord.Access, resources: URL) {
        guard let project = projects.open(url, access: access) else { return }
        activeProjectID = project.id
        if access == .trusted {
            inspectorPresented = project.inspectorPresented
            selectedSessionID = supervisor.openProject(project.url, resources: resources, preferredSessionID: project.selectedSessionID)
        } else {
            restoreNavigation(project)
        }
    }

    private func restoreNavigation(_ project: ProjectRecord) {
        selectedSessionID = store.session(id: project.selectedSessionID) == nil && supervisor.engine(for: project.selectedSessionID) == nil
            ? "approval" : project.selectedSessionID
        inspectorPresented = project.inspectorPresented
    }

    private func saveNavigation() {
        guard let project = activeProject else { return }
        projects.updateNavigation(projectID: project.id, selectedSessionID: selectedSessionID, inspectorPresented: inspectorPresented)
    }
}

private struct LiveSessionDetail: View {
    @ObservedObject var engine: PiEngine
    let peers: [SupervisedSessionSummary]
    let isReadOnly: Bool
    @Binding var draft: String
    let stopSession: () -> Void
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
                    .disabled(isReadOnly || !engine.session.isRunning)
                Button("Stop Session", role: .destructive, action: stopSession)
                    .disabled(isReadOnly)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .padding(.horizontal, 16)
            .frame(minHeight: 54)

            if isReadOnly {
                Label("Read-only observer — another window owns this session.", systemImage: "eye")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                    .background(.quaternary)
            }

            if !peers.isEmpty {
                Label(
                    "Shared project root with \(peers.map(\.title).joined(separator: ", ")) — edits may conflict; sessions are not isolated.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                .background(Color.orange.opacity(0.10))
                .accessibilityLabel("Shared project root. Edits may conflict. Sessions are not isolated.")
            }

            if let recovery = engine.recovery {
                RecoveryBanner(
                    recovery: recovery,
                    forkRequired: engine.ownershipRequiresFork,
                    restart: engine.restartRecoveredSession,
                    fork: engine.forkRecoveredSession
                )
            }

            if !engine.session.resourceDiagnostics.isEmpty {
                PiResourceDiagnosticsView(diagnostics: engine.session.resourceDiagnostics)
            }

            if engine.reloadAvailable {
                HStack {
                    Label("Pi resources changed. Reload rebuilds this settled runtime and its subscriptions.", systemImage: "arrow.clockwise")
                        .font(.caption)
                    Spacer()
                    Button("Reload", action: engine.reloadResources)
                        .buttonStyle(.borderedProminent)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 38)
                .background(Color.orange.opacity(0.10))
            }

            if engine.session.isRetrying || engine.session.isCompacting {
                Label(
                    engine.session.isRetrying ? "Pi is retrying the active run" : "Pi is compacting context for the active run",
                    systemImage: "arrow.triangle.2.circlepath"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                .background(.quaternary)
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
                    ForEach(engine.session.timelineItems) { item in
                        switch item {
                        case .tool(let id):
                            if let tool = engine.session.tools[id] { LiveToolRow(tool: tool) }
                        case .interruption(let id):
                            if let interruption = engine.session.interruptions.first(where: { $0.id == id }) {
                                LiveInterruptionTimelineRow(interruption: interruption)
                            }
                        case .extensionPresentation(let id):
                            if let presentation = engine.session.extensionPresentations.first(where: { $0.id == id }) {
                                ExtensionPresentationRow(presentation: presentation)
                            }
                        }
                    }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 22)
                .frame(maxWidth: .infinity)
            }
            Divider()
            if !engine.session.steeringQueue.isEmpty || !engine.session.followUpQueue.isEmpty {
                QueuedWorkView(
                    steering: engine.session.steeringQueue,
                    followUps: engine.session.followUpQueue
                )
            }
            ForEach(engine.session.activeInterruptions) { interruption in
                LiveInterruptionView(interruption: interruption) { response in
                    engine.answerInterruption(interruption.id, response: response)
                }
                .focusable()
                .focused(composerFocus, equals: .interruption(interruption.id))
                .disabled(isReadOnly)
            }
            LiveComposer(engine: engine, draft: $draft, focus: composerFocus)
                .disabled(isReadOnly)
        }
        .navigationTitle("Pi session")
        .onAppear { draft = engine.restoredDraft }
        .onChange(of: engine.restoredDraft) { _, value in draft = value }
        .onChange(of: engine.session.requestedEditorText) { _, value in
            if let value { draft = value }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            engine.checkForResourceChanges()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                engine.checkForResourceChanges()
            }
        }
    }
}

private struct PiResourceDiagnosticsView: View {
    let diagnostics: [PiResourceDiagnostic]

    var body: some View {
        DisclosureGroup("Pi compatibility · \(diagnostics.count) item\(diagnostics.count == 1 ? "" : "s")") {
            ForEach(diagnostics) { diagnostic in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(diagnostic.state.rawValue) · \(diagnostic.title)").font(.caption.bold())
                    Text("\(diagnostic.scope) · \(diagnostic.path)")
                        .font(.caption2.monospaced()).foregroundStyle(.secondary)
                    Text(diagnostic.reason).font(.caption)
                    Text(diagnostic.consequence).font(.caption).foregroundStyle(.secondary)
                    Text("Retained: \(diagnostic.retainedState)").font(.caption).foregroundStyle(.secondary)
                    Text("Possible loss: \(diagnostic.possibleLoss)").font(.caption).foregroundStyle(.secondary)
                    Text("Recovery copy: \(diagnostic.recoveryCopy)").font(.caption).foregroundStyle(.secondary)
                    Text("Next: \(diagnostic.repairAction)").font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
            }
        }
        .font(.caption)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.10))
        .accessibilityLabel("Pi compatibility diagnostics, \(diagnostics.count) items")
    }
}

private struct ExtensionPresentationRow: View {
    let presentation: PiExtensionPresentation

    var body: some View {
        DisclosureGroup(presentation.title) {
            Text(presentation.content)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
        }
        .accessibilityLabel("Extension presentation: \(presentation.title)")
    }
}

private struct LiveInterruptionTimelineRow: View {
    let interruption: PiInterruption

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(interruption.title)
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: interruption.resolution == .active ? "pause.circle.fill" : "checkmark.circle")
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Input request: \(interruption.title), \(status)")
    }

    private var status: String {
        switch interruption.resolution {
        case .active: "Waiting · pinned above the composer"
        case .answered: "Answered"
        case .cancelled: "Cancelled"
        case .timedOut: "Timed out"
        }
    }
}

private struct LiveInterruptionView: View {
    let interruption: PiInterruption
    let respond: (PiInterruptionResponse) -> Void
    @State private var text: String

    init(interruption: PiInterruption, respond: @escaping (PiInterruptionResponse) -> Void) {
        self.interruption = interruption
        self.respond = respond
        _text = State(initialValue: interruption.prefill ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(interruption.title, systemImage: "hand.raised.fill").font(.headline)
            if let message = interruption.message { Text(message).font(.callout) }
            responseControls
            HStack {
                Button("Cancel request") { respond(.cancelled) }
                if interruption.timeoutMilliseconds != nil {
                    Text("Pi will cancel this request if it times out.")
                        .font(.caption).foregroundStyle(.secondary)
                }
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

    @ViewBuilder
    private var responseControls: some View {
        switch interruption.method {
        case .select:
            VStack(alignment: .leading) {
                ForEach(Array(interruption.options.enumerated()), id: \.offset) { _, option in
                    Button(option) { respond(.value(option)) }
                        .buttonStyle(.bordered)
                }
            }
        case .confirm:
            HStack {
                Button("Confirm") { respond(.confirmed(true)) }.buttonStyle(.borderedProminent)
                Button("Decline") { respond(.confirmed(false)) }
            }
        case .input:
            HStack {
                TextField(interruption.placeholder ?? "Response", text: $text)
                Button("Submit") { respond(.value(text)) }.buttonStyle(.borderedProminent)
            }
        case .editor:
            VStack(alignment: .trailing, spacing: 6) {
                TextEditor(text: $text).frame(minHeight: 70, maxHeight: 140)
                Button("Submit") { respond(.value(text)) }.buttonStyle(.borderedProminent)
            }
        }
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

private struct QueuedWorkView: View {
    let steering: [String]
    let followUps: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Queued work").font(.caption.bold())
            queue(steering, label: "Steer")
            queue(followUps, label: "Follow-up")
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func queue(_ messages: [String], label: String) -> some View {
        ForEach(Array(messages.enumerated()), id: \.offset) { index, message in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(label) \(index + 1)")
                    .font(.caption2).foregroundStyle(.secondary)
                Text(message).font(.caption).lineLimit(2)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

private struct LiveToolRow: View {
    let tool: PiToolRun
    @State private var expanded = true

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                if !tool.arguments.isEmpty { structured("Arguments", tool.arguments) }
                structured("Content", tool.output.isEmpty ? "Waiting for output…" : tool.output)
                if !tool.details.isEmpty { structured("Details", tool.details) }
            }
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

    private func structured(_ title: String, _ content: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2.bold()).foregroundStyle(.secondary)
            Text(content).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        }
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
    @State private var attachments: [PromptAttachment] = []
    @State private var contextError: String?
    @State private var choosingBusyDelivery = false

    var body: some View {
        VStack(spacing: 0) {
            if !attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(attachments) { attachment in
                            HStack(spacing: 4) {
                                Label(attachment.name, systemImage: attachment.symbol)
                                    .lineLimit(1)
                                Button("Remove \(attachment.name)", systemImage: "xmark") {
                                    attachments.removeAll { $0.id == attachment.id }
                                }
                                .labelStyle(.iconOnly)
                                .buttonStyle(.plain)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(.quaternary, in: Capsule())
                            .accessibilityElement(children: .contain)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.top, 7)
                }
                .scrollIndicators(.hidden)
            }
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
                Button("Context", systemImage: "plus", action: chooseContext)
                    .help("Attach text files or images")

                Menu("Pi resources", systemImage: "command") {
                    ForEach(engine.session.commands) { command in
                        Button(command.description.isEmpty ? command.invocation : "\(command.invocation) — \(command.description)") {
                            draft = command.invocation + " "
                        }
                        .help("\(command.source.rawValue), \(command.scope): \(command.path)")
                    }
                }
                .disabled(engine.session.commands.isEmpty)
                .help("Use extension commands, prompt templates, and skills discovered by Pi")

                Picker("Model", selection: Binding(
                    get: { engine.session.model },
                    set: { if let model = $0 { engine.setModel(model) } }
                )) {
                    if engine.session.model == nil { Text("Choose model").tag(PiModel?.none) }
                    ForEach(engine.session.models) { model in
                        Text("\(model.name) · \(model.provider)").tag(Optional(model))
                    }
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
                Button(engine.session.isRunning ? "Direct…" : "Send", systemImage: "arrow.up", action: submit)
                    .buttonStyle(.borderedProminent)
                    .disabled(!engine.isReady || engine.configurationPending || engine.session.model == nil || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .controlSize(.small)
            .padding(7)
        }
        .background(.background, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator))
        .dropDestination(for: URL.self) { urls, _ in
            attachments.append(contentsOf: urls.map(PromptAttachment.init(file:)))
            return !urls.isEmpty
        }
        .onPasteCommand(of: [.image], perform: pasteImages)
        .alert("Context could not be attached", isPresented: Binding(
            get: { contextError != nil },
            set: { if !$0 { contextError = nil } }
        )) {
            Button("OK") { contextError = nil }
        } message: {
            Text(contextError ?? "Unknown context error")
        }
        .confirmationDialog(
            "Direct message while Pi is busy",
            isPresented: $choosingBusyDelivery,
            titleVisibility: .visible
        ) {
            Button("Steer current run") { submit(delivery: .steer) }
            Button("Queue follow-up") { submit(delivery: .followUp) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Steering changes the active work after its current tool calls. A follow-up waits until the active work finishes.")
        }
        .padding(16)
    }

    private func chooseContext() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Attach"
        guard panel.runModal() == .OK else { return }
        attachments.append(contentsOf: panel.urls.map(PromptAttachment.init(file:)))
    }

    private func pasteImages(_ providers: [NSItemProvider]) {
        for provider in providers {
            guard let identifier = provider.registeredTypeIdentifiers.first(where: {
                UTType($0)?.conforms(to: .image) == true
            }) else { continue }
            provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, error in
                DispatchQueue.main.async {
                    guard let data, error == nil,
                          let image = NSImage(data: data),
                          let tiff = image.tiffRepresentation,
                          let bitmap = NSBitmapImageRep(data: tiff),
                          let png = bitmap.representation(using: .png, properties: [:])
                    else {
                        contextError = "The pasted image could not be read. Copy it again and retry."
                        return
                    }
                    attachments.append(PromptAttachment(imageData: png, mimeType: "image/png", name: "Pasted image"))
                }
            }
        }
    }

    private func submit() {
        guard !engine.session.isRunning else {
            choosingBusyDelivery = true
            return
        }
        submit(delivery: nil)
    }

    private func submit(delivery: PiPromptDelivery?) {
        guard !engine.configurationPending, engine.session.model != nil else { return }
        do {
            let prompt = try PromptContext(attachments: attachments).prepare(message: draft)
            guard prompt.images.isEmpty || engine.session.model?.supportsImages == true else {
                contextError = "The selected model does not accept images. Remove them or choose an image-capable model."
                return
            }
            let sent = delivery.map { engine.directPrompt(prompt, as: $0) } ?? engine.sendPrompt(prompt)
            guard sent else { return }
            draft = ""
            attachments = []
        } catch {
            contextError = error.localizedDescription
        }
    }
}

private struct ProjectNavigator: View {
    let sessions: [WorkbenchSession]
    @Binding var selection: String
    let engineStatus: String
    let recents: [ProjectRecord]
    let liveSessions: [SupervisedSessionSummary]
    let cliSessions: [CLISessionRecord]
    let reopen: (URL) -> Void
    let continueCLI: (CLISessionRecord) -> Void
    let rename: (SupervisedSessionSummary) -> Void
    let stop: (String) -> Void
    let resume: (String) -> Void
    let archive: (String, Bool) -> Void

    private var projects: [String] {
        sessions.reduce(into: []) { result, session in
            if !result.contains(session.project) { result.append(session.project) }
        }
    }

    private var liveProjects: [String] {
        liveSessions.reduce(into: []) { result, session in
            if !result.contains(session.projectPath) { result.append(session.projectPath) }
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
            if !cliSessions.isEmpty {
                Section("CLI History · Read Only") {
                    ForEach(cliSessions) { session in
                        HStack(spacing: 8) {
                            Image(systemName: session.compatibility == .compatible ? "terminal" : "exclamationmark.triangle.fill")
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(session.projectPath.isEmpty ? session.id : URL(fileURLWithPath: session.projectPath).lastPathComponent)
                                    .lineLimit(1)
                                Text("\(session.compatibility.detail) · \(session.source.path)")
                                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 4)
                            Button("Continue") { continueCLI(session) }
                                .controlSize(.small)
                                .disabled(session.compatibility != .compatible)
                        }
                        .help(session.source.path)
                        .accessibilityElement(children: .contain)
                    }
                }
            }
            ForEach(liveProjects, id: \.self) { projectPath in
                let projectSessions = liveSessions.filter { $0.projectPath == projectPath }
                let visibleSessions = projectSessions.filter { !$0.isArchived }
                let archivedSessions = projectSessions.filter(\.isArchived)
                Section(URL(fileURLWithPath: projectPath).lastPathComponent) {
                    ForEach(visibleSessions) { session in
                        sessionRow(session, hasPeers: projectSessions.count > 1)
                    }
                }
                if !archivedSessions.isEmpty {
                    Section("Archived · \(URL(fileURLWithPath: projectPath).lastPathComponent)") {
                        ForEach(archivedSessions) { session in
                            sessionRow(session, hasPeers: projectSessions.count > 1)
                        }
                    }
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

    private func sessionRow(_ session: SupervisedSessionSummary, hasPeers: Bool) -> some View {
        SupervisedSessionRow(session: session, hasPeers: hasPeers)
            .tag(session.id)
            .contextMenu {
                Button("Rename…") { rename(session) }
                if session.isStopped {
                    Button("Resume") { resume(session.id) }
                } else {
                    Button("Stop") { stop(session.id) }
                }
                Divider()
                Button(session.isArchived ? "Unarchive" : "Archive") {
                    archive(session.id, !session.isArchived)
                }
            }
    }
}

private extension CLISessionCompatibility {
    var title: String {
        switch self {
        case .compatible: "Compatible"
        case .actionRequired: "Action required"
        }
    }

    var detail: String {
        switch self {
        case .compatible: title
        case .actionRequired(let reason): "\(title): \(reason)"
        }
    }
}

private extension SessionAttentionState {
    var title: String {
        switch self {
        case .waiting: "Waiting"
        case .failed: "Failed"
        case .running: "Running"
        case .done: "Done"
        }
    }

    var symbol: String {
        switch self {
        case .waiting: "pause.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .running: "gearshape.2.fill"
        case .done: "checkmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .waiting: .orange
        case .failed: .red
        case .running: .blue
        case .done: .green
        }
    }
}

private struct SupervisedSessionRow: View {
    let session: SupervisedSessionSummary
    let hasPeers: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: session.state.symbol)
                .foregroundStyle(session.state.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title).lineLimit(1)
                Text(session.isStopped ? "Stopped" : session.state.title).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if hasPeers {
                Label("Shared", systemImage: "exclamationmark.triangle.fill")
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.title), \(session.isStopped ? "Stopped" : session.state.title)\(session.isArchived ? ", archived" : "")\(hasPeers ? ", shared project root; edits may conflict" : "")")
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
    let project: URL?
    let lastRunPaths: [String]
    @StateObject private var store = ChangesStore()

    private var selected: ChangedFile? {
        store.inspection.files.first { $0.path == selectedFile } ?? store.inspection.files.first
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Change scope", selection: $scope) {
                Text("Last turn").tag("Last turn")
                Text("Workspace").tag("Workspace")
            }
            .pickerStyle(.segmented)
            .padding(10)

            Text(scope == "Last turn"
                 ? "Paths changed by the latest run; diffs show current workspace state. Shared-root peer changes may be present."
                 : "Current Git working-tree and index changes. Read only.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.bottom, 8)

            if store.isLoading {
                ProgressView().frame(maxWidth: .infinity, minHeight: 100)
            } else if let reason = store.inspection.unavailableReason {
                ContentUnavailableView("Aggregate diff unavailable", systemImage: "doc.text.magnifyingglass", description: Text(reason))
                    .frame(minHeight: 120)
            }

            List(store.inspection.files, selection: $selectedFile) { file in
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(file.path).lineLimit(1)
                        Text(file.status.rawValue).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("+\(file.additions) −\(file.deletions)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .tag(file.path)
                .accessibilityLabel("\(file.path), \(file.status.rawValue), \(file.additions) additions, \(file.deletions) deletions")
            }
            .frame(minHeight: 115, maxHeight: 180)

            Divider()
            if let file = selected {
                HStack {
                    Text(file.path).font(.caption.monospaced()).lineLimit(1)
                    Spacer()
                    Button("Open in Editor", systemImage: "square.and.pencil") { open(file) }
                    Button("Reveal in Finder", systemImage: "folder") { reveal(file) }
                }
                .labelStyle(.iconOnly)
                .padding(8)
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(file.hunks) { hunk in
                            Text(hunk.header).foregroundStyle(.secondary).padding(.vertical, 5)
                            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                                NativeDiffLine(line: line)
                            }
                        }
                        if file.hunks.isEmpty {
                            Text("No current textual diff is available for this path.")
                                .foregroundStyle(.secondary).padding(12)
                        }
                    }
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(.horizontal, 8)
                }
            }
            Spacer(minLength: 0)
        }
        .navigationTitle("Changes")
        .accessibilityLabel("Read-only changes inspector")
        .task(id: refreshID) { refresh() }
        .onChange(of: store.inspection.files) { _, files in
            if !files.contains(where: { $0.path == selectedFile }) { selectedFile = files.first?.path ?? "" }
        }
    }

    private var refreshID: String {
        "\(project?.path ?? "")|\(scope)|\(lastRunPaths.joined(separator: "|"))"
    }

    private func refresh() {
        store.refresh(project: project, lastRunPaths: lastRunPaths, lastRunOnly: scope == "Last turn")
    }

    private func fileURL(_ file: ChangedFile) -> URL? { project?.appending(path: file.path) }

    private func open(_ file: ChangedFile) {
        guard let project, let url = fileURL(file), FileManager.default.fileExists(atPath: url.path) else { return }
        FileHandoff.openInEditor(url, project: project)
    }

    private func reveal(_ file: ChangedFile) {
        guard let url = fileURL(file) else { return }
        FileHandoff.revealInFinder(url)
    }
}

private struct NativeDiffLine: View {
    let line: DiffLine

    var body: some View {
        HStack(spacing: 0) {
            Text(line.oldLine.map(String.init) ?? " ").frame(width: 34, alignment: .trailing)
            Text(line.newLine.map(String.init) ?? " ").frame(width: 34, alignment: .trailing)
            Text(" \(symbol) \(line.text)").frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 3)
        .background(color.opacity(0.10))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var symbol: String {
        switch line.kind { case .addition: "+"; case .deletion: "−"; case .context: " " }
    }

    private var color: Color {
        switch line.kind { case .addition: .green; case .deletion: .red; case .context: .clear }
    }

    private var accessibilityText: String {
        switch line.kind {
        case .addition: "Added line \(line.newLine ?? 0): \(line.text)"
        case .deletion: "Removed line \(line.oldLine ?? 0): \(line.text)"
        case .context: "Context line \(line.newLine ?? 0): \(line.text)"
        }
    }
}
