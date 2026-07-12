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
}
