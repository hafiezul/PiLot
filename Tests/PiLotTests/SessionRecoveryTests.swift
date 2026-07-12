import Foundation
import XCTest
@testable import PiLot

final class SessionRecoveryTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testRecoveryRestoresDurableStateRepairsTailAndMarksRunningSessionInterrupted() throws {
        let store = SessionRecoveryStore(root: root)
        var metadata = SessionMetadata(id: "session-1", projectPath: "/tmp/project", state: .running)
        try store.save(metadata: metadata)
        try store.saveDraft("unsent work", sessionID: metadata.id)
        let transcript = store.transcriptURL(sessionID: metadata.id)
        let header = #"{"type":"session","version":3,"id":"session-1","timestamp":"2026-07-12T00:00:00Z","cwd":"/tmp/project"}"#
        let message = #"{"type":"message","id":"entry-1","parentId":null,"timestamp":"2026-07-12T00:00:01Z","message":{"role":"user","content":"keep me"}}"#
        try Data("\(header)\n\(message)\n{\"type\":\"mess".utf8).write(to: transcript)

        let recovery = try store.recover(sessionID: metadata.id)

        XCTAssertEqual(recovery.metadata.state, .interrupted)
        XCTAssertEqual(recovery.draft, "unsent work")
        XCTAssertEqual(recovery.validEntryCount, 2)
        XCTAssertEqual(recovery.issue, .repairedIncompleteTail)
        XCTAssertEqual(try String(contentsOf: transcript, encoding: .utf8), "\(header)\n\(message)\n")
        XCTAssertNotNil(recovery.recoveryCopy)
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(recovery.recoveryCopy).path))
        metadata = try store.loadMetadata(sessionID: metadata.id)
        XCTAssertEqual(metadata.state, .interrupted)
    }

    func testValidFinalRecordWithoutLFIsRetained() throws {
        let store = SessionRecoveryStore(root: root)
        let metadata = SessionMetadata(id: "session-final", projectPath: "/tmp/project", state: .done)
        try store.save(metadata: metadata)
        let transcript = store.transcriptURL(sessionID: metadata.id)
        let finalRecord = "{\"type\":\"session\",\"id\":\"session-final\",\"cwd\":\"/tmp/project\"}"
        try Data(finalRecord.utf8).write(to: transcript)

        let recovery = try store.recover(sessionID: metadata.id)

        XCTAssertEqual(recovery.validEntryCount, 1)
        XCTAssertEqual(try String(contentsOf: transcript, encoding: .utf8), finalRecord + "\n")
    }

    func testMalformedDurableRecordIsPreservedAndRequiresAChoice() throws {
        let store = SessionRecoveryStore(root: root)
        let metadata = SessionMetadata(id: "session-2", projectPath: "/tmp/project", state: .done)
        try store.save(metadata: metadata)
        let bytes = Data("{\"type\":\"session\",\"id\":\"session-2\",\"cwd\":\"/tmp/project\"}\nnot-json\n".utf8)
        try bytes.write(to: store.transcriptURL(sessionID: metadata.id))

        let recovery = try store.recover(sessionID: metadata.id)

        XCTAssertEqual(recovery.issue, .malformedRecord(line: 2))
        XCTAssertEqual(try Data(contentsOf: store.transcriptURL(sessionID: metadata.id)), bytes)
        XCTAssertEqual(recovery.actions, [.openReadOnly, .forkVerifiedEntries, .exportOriginal])
        XCTAssertNotNil(recovery.recoveryCopy)
    }

    func testReadOnlyRecoveryNeverRepairsALiveOwnersTranscript() throws {
        let store = SessionRecoveryStore(root: root)
        let metadata = SessionMetadata(id: "session-live", projectPath: "/tmp/project", state: .running)
        try store.save(metadata: metadata)
        let bytes = Data("{\"type\":\"session\",\"id\":\"session-live\",\"cwd\":\"/tmp/project\"}\n{\"partial\":".utf8)
        try bytes.write(to: store.transcriptURL(sessionID: metadata.id))

        let recovery = try store.recover(sessionID: metadata.id, allowRepair: false)

        XCTAssertEqual(recovery.metadata.state, .running)
        XCTAssertEqual(recovery.issue, .incompleteTailPreserved)
        XCTAssertEqual(try Data(contentsOf: store.transcriptURL(sessionID: metadata.id)), bytes)
    }

    func testWriterLeaseIsExclusiveAndUncertainOwnershipRequiresFork() throws {
        let first = SessionWriterLease(root: root, sessionID: "session-3")
        let second = SessionWriterLease(root: root, sessionID: "session-3")

        XCTAssertEqual(try first.acquire(), .acquired)
        XCTAssertEqual(try second.acquire(), .forkRequired)
        first.release()
        XCTAssertEqual(try second.acquire(), .acquired)
    }
}
