import AppKit
import Combine
import Foundation

struct SupervisedSessionSummary: Identifiable, Equatable {
    let id: String
    let projectPath: String
    let title: String
    var state: SessionAttentionState
    var updatedAt = Date()
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

    mutating func update(sessionID: String, state: SessionAttentionState, at date: Date) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        sessions[index].state = state
        sessions[index].updatedAt = date
    }
}

@MainActor
final class SessionSupervisor: ObservableObject {
    let runtime = PiEngine()
    @Published private(set) var index = SupervisedSessionIndex()
    @Published private(set) var cliSessions: [CLISessionRecord] = []
    @Published var cliContinuationFailure: CLISessionContinuationFailure?

    private var engines: [String: PiEngine] = [:]
    private var observations: [String: AnyCancellable] = [:]
    private var announcementObservations: [String: AnyCancellable] = [:]

    var sortedSessions: [SupervisedSessionSummary] { index.sortedSessions }

    func startRuntime(resources: URL) { runtime.start(resources: resources) }

    func engine(for sessionID: String) -> PiEngine? { engines[sessionID] }

    func peers(of sessionID: String) -> [SupervisedSessionSummary] { index.peers(of: sessionID) }

    func refreshCLIHistory() {
        Task {
            do { cliSessions = try await Task.detached { try CLISessionStore().discover() }.value }
            catch { cliSessions = [] }
        }
    }

    func continueCLISession(_ session: CLISessionRecord, project: URL, resources: URL) async -> String? {
        do {
            let metadata = try await Task.detached {
                try CLISessionStore().continueSession(session, in: project)
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
            let metadata = try await Task.detached {
                try CLISessionStore().salvageVerifiedEntries(from: failure, session: session, in: project)
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
    func openProject(_ project: URL, resources: URL) -> String {
        let canonical = project.standardizedFileURL.resolvingSymlinksInPath()
        if let existing = index.sessions.first(where: { $0.projectPath == canonical.path }) { return existing.id }
        return addSession(project: canonical, resources: resources, recoverLatest: true)
    }

    @discardableResult
    func newSession(project: URL, resources: URL) -> String {
        addSession(project: project.standardizedFileURL.resolvingSymlinksInPath(), resources: resources, recoverLatest: false)
    }

    private func addSession(project: URL, resources: URL, recoverLatest: Bool) -> String {
        let id = UUID().uuidString
        let number = index.sessions.filter { $0.projectPath == project.path }.count + 1
        let engine = PiEngine()
        engines[id] = engine
        index.add(.init(id: id, projectPath: project.path, title: "Pi session \(number)", state: .done))
        observe(engine, id: id)
        if recoverLatest { engine.openProject(project, resources: resources) }
        else { engine.startNewSession(project: project, resources: resources) }
        return id
    }

    private func registerCLIContinuation(_ metadata: SessionMetadata, project: URL, resources: URL) -> String {
        let engine = PiEngine()
        engines[metadata.id] = engine
        let number = index.sessions.filter { $0.projectPath == metadata.projectPath }.count + 1
        index.add(.init(id: metadata.id, projectPath: metadata.projectPath, title: "CLI fork \(number)", state: .done))
        observe(engine, id: metadata.id)
        engine.startForkedSession(metadata, project: project, resources: resources)
        refreshCLIHistory()
        return metadata.id
    }

    private func observe(_ engine: PiEngine, id: String) {
        observations[id] = engine.$attentionState.combineLatest(engine.$activityDate).sink { [weak self] state, date in
            self?.index.update(sessionID: id, state: state, at: date)
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
