import XCTest
@testable import PiLot

final class NotificationTests: XCTestCase {
    func testNotificationsRequireOptInInactiveAppAndAttentionTransition() {
        XCTAssertFalse(SessionNotificationPolicy.shouldNotify(
            enabled: false, appIsActive: false, previous: .running, current: .failed
        ))
        XCTAssertFalse(SessionNotificationPolicy.shouldNotify(
            enabled: true, appIsActive: true, previous: .running, current: .failed
        ))
        XCTAssertFalse(SessionNotificationPolicy.shouldNotify(
            enabled: true, appIsActive: false, previous: .failed, current: .failed
        ))
        XCTAssertFalse(SessionNotificationPolicy.shouldNotify(
            enabled: true, appIsActive: false, previous: .done, current: .running
        ))
    }

    func testNotificationsCoverInputFailureAndCompletionOnly() {
        XCTAssertTrue(SessionNotificationPolicy.shouldNotify(
            enabled: true, appIsActive: false, previous: .running, current: .waiting
        ))
        XCTAssertTrue(SessionNotificationPolicy.shouldNotify(
            enabled: true, appIsActive: false, previous: .running, current: .failed
        ))
        XCTAssertTrue(SessionNotificationPolicy.shouldNotify(
            enabled: true, appIsActive: false, previous: .running, current: .done
        ))
        XCTAssertFalse(SessionNotificationPolicy.shouldNotify(
            enabled: true, appIsActive: false, previous: .waiting, current: .done
        ))
    }

    func testNotificationDestinationPreservesExactInterruption() {
        let destination = NotificationDestination(
            projectPath: "/project", sessionID: "session", interruptionID: "approval"
        )

        XCTAssertEqual(destination.projectPath, "/project")
        XCTAssertEqual(destination.sessionID, "session")
        XCTAssertEqual(destination.interruptionID, "approval")
    }
}
