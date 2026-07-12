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
