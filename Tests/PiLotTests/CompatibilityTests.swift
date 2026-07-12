import Foundation
import XCTest
@testable import PiLot

final class CompatibilityTests: XCTestCase {
    func testCompatibilityReportCarriesActionableContextForEveryState() {
        let resource = PiResourceDiagnostic(
            surface: "extension:/tmp/example.ts",
            title: "Extension failed",
            state: .degraded,
            scope: "project",
            path: "/tmp/example.ts",
            reason: "Load failed",
            consequence: "Only this extension is disabled.",
            retainedState: "The session and source file are unchanged.",
            repairAction: "Repair it in Pi CLI, then reload."
        )

        XCTAssertEqual(resource.state, .degraded)
        XCTAssertEqual(resource.scope, "project")
        XCTAssertFalse(resource.path.isEmpty)
        XCTAssertFalse(resource.consequence.isEmpty)
        XCTAssertFalse(resource.retainedState.isEmpty)
        XCTAssertFalse(resource.repairAction.isEmpty)
    }

    func testExactCLIMatrixBlocksOnlyUnsafeSharedOperations() {
        let exact = PiCLIMatrix(bundledVersion: "0.80.6", detectedVersion: "0.80.6")
        XCTAssertEqual(exact.state, .compatible)
        XCTAssertTrue(exact.allowsSharedStateWrites)
        XCTAssertTrue(exact.allowsCLIContinuation)

        let drifted = PiCLIMatrix(bundledVersion: "0.80.6", detectedVersion: "0.81.0")
        XCTAssertEqual(drifted.state, .actionRequired)
        XCTAssertFalse(drifted.allowsSharedStateWrites)
        XCTAssertFalse(drifted.allowsCLIContinuation)
        XCTAssertTrue(drifted.allowsPiLotSessions)
    }

    func testMissingCLILeavesPiLotAndSharedStateUsable() {
        let matrix = PiCLIMatrix(bundledVersion: "0.80.6", detectedVersion: nil)

        XCTAssertEqual(matrix.state, .compatible)
        XCTAssertTrue(matrix.allowsPiLotSessions)
        XCTAssertTrue(matrix.allowsSharedStateWrites)
        XCTAssertFalse(matrix.allowsCLIContinuation)
    }

    func testThemesAndKeybindingsAreReportedAsUnsupportedWithoutChangingThem() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let agent = root.appending(path: "agent")
        let theme = agent.appending(path: "themes/custom.json")
        let keybindings = agent.appending(path: "keybindings.json")
        try FileManager.default.createDirectory(at: theme.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: theme)
        try Data("{}".utf8).write(to: keybindings)
        defer { try? FileManager.default.removeItem(at: root) }

        let reports = UnsupportedPiPresentation.reports(project: nil, agentDirectory: agent)

        XCTAssertEqual(reports.count, 2)
        XCTAssertTrue(reports.allSatisfy { $0.state == .unsupported })
        XCTAssertEqual(try Data(contentsOf: theme), Data("{}".utf8))
        XCTAssertEqual(try Data(contentsOf: keybindings), Data("{}".utf8))
    }

    func testSettingsWriterFlushesThroughPiAndPreservesUnknownFields() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let project = root.appending(path: "project")
        let agent = root.appending(path: "agent")
        let settings = agent.appending(path: "settings.json")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: agent, withIntermediateDirectories: true)
        try Data(#"{"futureSetting":{"keep":true}}"#.utf8).write(to: settings)
        defer { try? FileManager.default.removeItem(at: root) }
        let resources = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appending(path: "Runtime")
        let writer = PiSettingsWriter(resources: resources, project: project, agentDirectory: agent)

        try writer.persist(.thinking(.high))

        let value = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: settings)) as? [String: Any])
        XCTAssertEqual(value["defaultThinkingLevel"] as? String, "high")
        XCTAssertEqual((value["futureSetting"] as? [String: Any])?["keep"] as? Bool, true)
    }

    func testResourceSnapshotDetectsChangesWithoutWatchingSessionData() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let project = root.appending(path: "project")
        let agent = root.appending(path: "agent")
        let skill = project.appending(path: ".pi/skills/example/SKILL.md")
        try FileManager.default.createDirectory(at: skill.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: agent, withIntermediateDirectories: true)
        try Data("one".utf8).write(to: skill)
        defer { try? FileManager.default.removeItem(at: root) }

        let before = ResourceSnapshot.capture(project: project, agentDirectory: agent)
        try Data("changed".utf8).write(to: skill)
        let after = ResourceSnapshot.capture(project: project, agentDirectory: agent)

        XCTAssertNotEqual(before, after)
    }
}
