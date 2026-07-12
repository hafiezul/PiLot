import AppKit
import Combine
import Foundation

struct SupervisedSessionSummary: Identifiable, Equatable {
    let id: String
    let projectPath: String
    var title: String
    var state: SessionAttentionState
    var isStopped = false
    var isArchived = false
    var updatedAt = Date()
}

enum SessionWindowAccess: Equatable { case owner, observer }

struct SessionWindowOwnership {
    private var owners: [String: UUID] = [:]

    mutating func access(to sessionID: String, from windowID: UUID) -> SessionWindowAccess {
        if let owner = owners[sessionID] { return owner == windowID ? .owner : .observer }
        owners[sessionID] = windowID
        return .owner
    }

    mutating func release(window windowID: UUID) {
        owners = owners.filter { $0.value != windowID }
    }
}

struct SupervisedSessionIndex {
    private(set) var sessions: [SupervisedSessionSummary] = []

    var sortedSessions: [SupervisedSessionSummary] {
        sessions.sorted {
            if $0.state.sortOrder != $1.state.sortOrder { return $0.state.sortOrder < $1.state.sortOrder }
            if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
            return $0.title.localizedStandardCompare($1.title) == .orderedAscending
        }
    }

    func session(id: String) -> SupervisedSessionSummary? { sessions.first { $0.id == id } }

    func peers(of id: String) -> [SupervisedSessionSummary] {
        guard let session = session(id: id) else { return [] }
        return sessions.filter { $0.id != id && $0.projectPath == session.projectPath }
    }

    mutating func add(_ session: SupervisedSessionSummary) { sessions.append(session) }

    mutating func rename(sessionID: String, title: String) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        sessions[index].title = title
    }

    mutating func setStopped(sessionID: String, _ stopped: Bool) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        sessions[index].isStopped = stopped
        if stopped { sessions[index].state = .done }
    }

    mutating func setArchived(sessionID: String, _ archived: Bool) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        sessions[index].isArchived = archived
    }

    mutating func update(sessionID: String, state: SessionAttentionState, at date: Date) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        sessions[index].state = state
        sessions[index].updatedAt = date
    }
}

@MainActor
final class SessionSupervisor: ObservableObject {
    let runtime = PiEngine()
    let notifications = SessionNotifications()
    @Published private(set) var index = SupervisedSessionIndex()
    @Published private(set) var cliSessions: [CLISessionRecord] = []
    @Published var cliContinuationFailure: CLISessionContinuationFailure?

    private var engines: [String: PiEngine] = [:]
    private var observations: [String: AnyCancellable] = [:]
    private var announcementObservations: [String: AnyCancellable] = [:]
    private var windowOwnership = SessionWindowOwnership()
    private let recoveryStore = SessionRecoveryStore()
    private lazy var cliStore: CLISessionStore = {
        let matrix = PiCLIMatrix(bundledVersion: VersionInfo.current.pi, detectedVersion: InstalledPiCLI.version())
        let reason = matrix.allowsCLIContinuation ? nil : matrix.detectedVersion.map {
            "Installed Pi CLI \($0) is outside the tested \(matrix.bundledVersion) matrix"
        } ?? "No installed Pi CLI was detected"
        return CLISessionStore(cliCompatibilityReason: reason)
    }()

    var sortedSessions: [SupervisedSessionSummary] { index.sortedSessions }

    func startRuntime(resources: URL) { runtime.start(resources: resources) }

    func engine(for sessionID: String) -> PiEngine? { engines[sessionID] }

    func projectURL(for sessionID: String) -> URL? {
        index.session(id: sessionID).map { URL(fileURLWithPath: $0.projectPath, isDirectory: true) }
    }

    func peers(of sessionID: String) -> [SupervisedSessionSummary] { index.peers(of: sessionID) }

    func windowAccess(to sessionID: String, from windowID: UUID) -> SessionWindowAccess {
        windowOwnership.access(to: sessionID, from: windowID)
    }

    func releaseWindow(_ windowID: UUID) { windowOwnership.release(window: windowID) }

    func renameSession(_ sessionID: String, title: String) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        guard engines[sessionID]?.renameSession(title) == true else { return }
        index.rename(sessionID: sessionID, title: title)
    }

    func stopSession(_ sessionID: String) {
        guard engines[sessionID]?.stopSession() == true else { return }
        index.setStopped(sessionID: sessionID, true)
    }

    func resumeSession(_ sessionID: String) {
        guard engines[sessionID]?.resumeSession() == true else { return }
        index.setStopped(sessionID: sessionID, false)
    }

    func setArchived(_ archived: Bool, sessionID: String) {
        guard engines[sessionID]?.setArchived(archived) == true else { return }
        index.setArchived(sessionID: sessionID, archived)
    }

    func refreshCLIHistory() {
        Task {
            let store = cliStore
            do { cliSessions = try await Task.detached { try store.discover() }.value }
            catch { cliSessions = [] }
        }
    }

    func continueCLISession(_ session: CLISessionRecord, project: URL, resources: URL) async -> String? {
        do {
            let store = cliStore
            let metadata = try await Task.detached {
                try store.continueSession(session, in: project)
            }.value
            return registerCLIContinuation(metadata, project: project, resources: resources)
        } catch let failure as CLISessionContinuationFailure {
            cliContinuationFailure = failure
            return nil
        } catch {
            return nil
        }
    }

    func salvageCLISession(
        _ session: CLISessionRecord,
        failure: CLISessionContinuationFailure,
        project: URL,
        resources: URL
    ) async -> String? {
        do {
            let store = cliStore
            let metadata = try await Task.detached {
                try store.salvageVerifiedEntries(from: failure, session: session, in: project)
            }.value
            return registerCLIContinuation(metadata, project: project, resources: resources)
        } catch let nextFailure as CLISessionContinuationFailure {
            cliContinuationFailure = nextFailure
            return nil
        } catch {
            cliContinuationFailure = CLISessionContinuationFailure(
                recoveryCopy: failure.recoveryCopy,
                reason: error.localizedDescription
            )
            return nil
        }
    }

    @discardableResult
    func openProject(_ project: URL, resources: URL, preferredSessionID: String? = nil) -> String {
        let canonical = project.standardizedFileURL.resolvingSymlinksInPath()
        if !index.sessions.contains(where: { $0.projectPath == canonical.path }) {
            let stored = (try? recoveryStore.sessions(projectPath: canonical.path)) ?? []
            for metadata in stored { register(metadata, project: canonical, resources: resources) }
        }
        let projectSessions = index.sessions.filter { $0.projectPath == canonical.path }
        if projectSessions.isEmpty { return addSession(project: canonical, resources: resources) }
        return projectSessions.first { $0.id == preferredSessionID }?.id
            ?? projectSessions.first { !$0.isArchived }?.id
            ?? projectSessions[0].id
    }

    @discardableResult
    func newSession(project: URL, resources: URL) -> String {
        addSession(project: project.standardizedFileURL.resolvingSymlinksInPath(), resources: resources)
    }

    private func addSession(project: URL, resources: URL) -> String {
        let id = UUID().uuidString
        let number = index.sessions.filter { $0.projectPath == project.path }.count + 1
        let title = "Pi session \(number)"
        let engine = PiEngine()
        engines[id] = engine
        index.add(.init(id: id, projectPath: project.path, title: title, state: .done))
        observe(engine, id: id)
        engine.startNewSession(project: project, resources: resources, id: id, title: title)
        return id
    }

    private func register(_ metadata: SessionMetadata, project: URL, resources: URL) {
        guard engines[metadata.id] == nil else { return }
        let engine = PiEngine()
        engines[metadata.id] = engine
        let state: SessionAttentionState = switch metadata.state {
        case .running: .running
        case .interrupted: .failed
        case .ready, .done, .stopped: .done
        }
        index.add(.init(
            id: metadata.id,
            projectPath: metadata.projectPath,
            title: metadata.title,
            state: state,
            isStopped: metadata.state == .stopped,
            isArchived: metadata.isArchived,
            updatedAt: metadata.updatedAt
        ))
        observe(engine, id: metadata.id)
        engine.openExistingSession(metadata, project: project, resources: resources)
    }

    private func registerCLIContinuation(_ metadata: SessionMetadata, project: URL, resources: URL) -> String {
        let engine = PiEngine()
        engines[metadata.id] = engine
        let number = index.sessions.filter { $0.projectPath == metadata.projectPath }.count + 1
        index.add(.init(id: metadata.id, projectPath: metadata.projectPath, title: metadata.title == "Pi session" ? "CLI fork \(number)" : metadata.title, state: .done))
        observe(engine, id: metadata.id)
        engine.startForkedSession(metadata, project: project, resources: resources)
        refreshCLIHistory()
        return metadata.id
    }

    private func observe(_ engine: PiEngine, id: String) {
        observations[id] = engine.$attentionState.combineLatest(engine.$activityDate).dropFirst().sink { [weak self, weak engine] state, date in
            guard let self, let previous = self.index.session(id: id)?.state else { return }
            self.index.update(sessionID: id, state: state, at: date)
            if let session = self.index.session(id: id) {
                self.notifications.post(
                    session: session,
                    previous: previous,
                    interruptionID: engine?.session.activeInterruptions.first?.id
                )
            }
        }
        announcementObservations[id] = engine.$attentionAnnouncement.dropFirst().sink { _ in
            NSAccessibility.post(
                element: NSApp as Any,
                notification: .announcementRequested,
                userInfo: [
                    .announcement: "Input needed for Pi session",
                    .priority: NSAccessibilityPriorityLevel.high.rawValue,
                ]
            )
        }
    }
}
