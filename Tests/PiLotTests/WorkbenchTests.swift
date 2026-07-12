import XCTest
@testable import PiLot

@MainActor
final class WorkbenchTests: XCTestCase {
    func testFixturesExerciseEveryWorkbenchState() {
        XCTAssertEqual(
            Set(WorkbenchFixtures.sessions.map(\.state)),
            Set(WorkbenchSessionState.allCases)
        )
        XCTAssertTrue(WorkbenchFixtures.sessions.contains { $0.interruption != nil })
    }

    func testAnsweringAnInterruptionKeepsTheSessionFocusedAndRunning() {
        let store = WorkbenchStore()
        let sessionID = try! XCTUnwrap(store.sessions.first { $0.interruption != nil }?.id)

        store.answerInterruption(for: sessionID)

        XCTAssertEqual(store.session(id: sessionID)?.state, .running)
        XCTAssertNil(store.session(id: sessionID)?.interruption)
    }

    func testCanonicalProjectIdentityDeduplicatesSymlinkedPaths() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let project = root.appending(path: "project")
        let alias = root.appending(path: "alias")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: project)
        defer { try? FileManager.default.removeItem(at: root) }

        var index = ProjectIndex()
        let opened = try index.open(project, access: .trusted)
        let reopened = try index.open(alias, access: .trusted)

        XCTAssertEqual(opened.id, reopened.id)
        XCTAssertEqual(index.recents.count, 1)
    }

    func testSupervisedSessionsSortByAttentionThenRecency() {
        let old = Date(timeIntervalSince1970: 1)
        let recent = Date(timeIntervalSince1970: 2)
        let index = SupervisedSessionIndex(sessions: [
            .init(id: "done", projectPath: "/a", title: "Done", state: .done, updatedAt: recent),
            .init(id: "running-old", projectPath: "/a", title: "Running old", state: .running, updatedAt: old),
            .init(id: "failed", projectPath: "/b", title: "Failed", state: .failed, updatedAt: old),
            .init(id: "waiting", projectPath: "/c", title: "Waiting", state: .waiting, updatedAt: old),
            .init(id: "running-new", projectPath: "/a", title: "Running new", state: .running, updatedAt: recent),
        ])

        XCTAssertEqual(index.sortedSessions.map(\.id), ["waiting", "failed", "running-new", "running-old", "done"])
    }

    func testSharedCanonicalRootWarnsEveryPeer() {
        let index = SupervisedSessionIndex(sessions: [
            .init(id: "one", projectPath: "/project", title: "One", state: .running),
            .init(id: "two", projectPath: "/project", title: "Two", state: .done),
            .init(id: "other", projectPath: "/other", title: "Other", state: .running),
        ])

        XCTAssertEqual(index.peers(of: "one").map(\.id), ["two"])
        XCTAssertEqual(index.peers(of: "two").map(\.id), ["one"])
        XCTAssertTrue(index.peers(of: "other").isEmpty)
    }

    func testSessionLifecycleKeepsIdentityAndArchiveSeparateFromRuntimeState() {
        var index = SupervisedSessionIndex(sessions: [
            .init(id: "stable-id", projectPath: "/project", title: "Original", state: .running),
        ])

        index.rename(sessionID: "stable-id", title: "Renamed")
        index.setStopped(sessionID: "stable-id", true)
        index.setArchived(sessionID: "stable-id", true)

        let session = index.session(id: "stable-id")
        XCTAssertEqual(session?.id, "stable-id")
        XCTAssertEqual(session?.title, "Renamed")
        XCTAssertEqual(session?.state, .done)
        XCTAssertEqual(session?.isStopped, true)
        XCTAssertEqual(session?.isArchived, true)
    }

    func testWindowOwnershipAllowsOneEditorAndReadOnlyObservers() {
        var ownership = SessionWindowOwnership()
        let firstWindow = UUID()
        let secondWindow = UUID()

        XCTAssertEqual(ownership.access(to: "session", from: firstWindow), .owner)
        XCTAssertEqual(ownership.access(to: "session", from: secondWindow), .observer)
        ownership.release(window: firstWindow)
        XCTAssertEqual(ownership.access(to: "session", from: secondWindow), .owner)
    }

    func testOneEngineExitDoesNotChangeSiblingSessions() {
        var index = SupervisedSessionIndex(sessions: [
            .init(id: "failed-engine", projectPath: "/project", title: "One", state: .running),
            .init(id: "healthy-engine", projectPath: "/project", title: "Two", state: .running),
        ])

        index.update(sessionID: "failed-engine", state: .failed, at: Date(timeIntervalSince1970: 3))

        XCTAssertEqual(index.session(id: "failed-engine")?.state, .failed)
        XCTAssertEqual(index.session(id: "healthy-engine")?.state, .running)
    }

    func testProjectIndexRestoresOnlyDurableNavigationState() throws {
        var index = ProjectIndex()
        let project = try index.open(URL(fileURLWithPath: FileManager.default.currentDirectoryPath), access: .readOnly)
        index.updateNavigation(projectID: project.id, selectedSessionID: "done", inspectorPresented: false)

        let restored = try JSONDecoder().decode(ProjectIndex.self, from: JSONEncoder().encode(index))

        XCTAssertEqual(restored.recents.first?.selectedSessionID, "done")
        XCTAssertEqual(restored.recents.first?.access, .readOnly)
        XCTAssertFalse(try XCTUnwrap(restored.recents.first?.inspectorPresented))
    }
}
