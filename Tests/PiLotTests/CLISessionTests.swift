import Foundation
import XCTest
@testable import PiLot

final class CLISessionTests: XCTestCase {
    private var root: URL!
    private var cliRoot: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        cliRoot = root.appending(path: "CLI", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: cliRoot, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

    func testDiscoveryIsReadOnlyAndReportsSourceAndCompatibility() throws {
        let source = cliRoot.appending(path: "project/session.jsonl")
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        let bytes = Data("{\"type\":\"session\",\"version\":3,\"id\":\"cli-1\",\"cwd\":\"/project\"}\n".utf8)
        try bytes.write(to: source)
        let store = CLISessionStore(root: root.appending(path: "PiLot"), cliRoot: cliRoot)

        let sessions = try store.discover()

        XCTAssertEqual(sessions.map(\.id), ["cli-1"])
        XCTAssertEqual(sessions.first?.source.lastPathComponent, source.lastPathComponent)
        XCTAssertEqual(sessions.first?.compatibility, .compatible)
        XCTAssertEqual(try Data(contentsOf: source), bytes)
    }

    func testContinuationStagesThenPublishesANewOwnedSessionWithoutChangingSource() throws {
        let source = cliRoot.appending(path: "session.jsonl")
        let bytes = Data("{\"type\":\"session\",\"version\":2,\"id\":\"cli-2\",\"cwd\":\"/old\"}\n{\"type\":\"message\",\"id\":\"entry-1\",\"parentId\":null}\n".utf8)
        try bytes.write(to: source)
        let appRoot = root.appending(path: "PiLot")
        let store = CLISessionStore(root: appRoot, cliRoot: cliRoot) { staged, output, id, project, source in
            let destination = output.appending(path: "fork-\(id).jsonl")
            let header = "{\"type\":\"session\",\"version\":3,\"id\":\"\(id)\",\"cwd\":\"\(project.path)\",\"parentSession\":\"\(source.path)\"}\n"
            let old = try String(contentsOf: staged, encoding: .utf8).split(separator: "\n").dropFirst().joined(separator: "\n")
            try Data((header + old + "\n").utf8).write(to: destination)
            return destination
        }
        let record = try XCTUnwrap(store.discover().first)

        let metadata = try store.continueSession(record, in: URL(fileURLWithPath: "/new-project"))

        XCTAssertNotEqual(metadata.id, record.id)
        XCTAssertEqual(metadata.projectPath, "/new-project")
        XCTAssertEqual(metadata.state, .ready)
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        let transcript = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: appRoot, includingPropertiesForKeys: nil).first { $0.pathExtension == "jsonl" })
        let published = try String(contentsOf: transcript, encoding: .utf8)
        XCTAssertTrue(published.contains("\"id\":\"\(metadata.id)\""))
        XCTAssertNotNil(try SessionRecoveryStore(root: appRoot).loadMetadata(sessionID: metadata.id))
    }

    func testBundledEngineMigratesTheStagedCopyBeforePublication() throws {
        let source = cliRoot.appending(path: "session.jsonl")
        let header = #"{"type":"session","version":2,"id":"cli-engine","cwd":"/old"}"#
        let message = #"{"type":"message","id":"entry-1","parentId":null,"timestamp":"2026-07-13T00:00:00Z","message":{"role":"hookMessage","content":"migrate me"}}"#
        let bytes = Data("\(header)\n\(message)\n".utf8)
        try bytes.write(to: source)
        let runtime = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appending(path: "Runtime/PiEngine")
        let appRoot = root.appending(path: "PiLot")
        let store = CLISessionStore(root: appRoot, cliRoot: cliRoot, runtimeRoot: runtime)
        let record = try XCTUnwrap(store.discover().first)

        let metadata = try store.continueSession(record, in: root)

        let published = try String(contentsOf: SessionRecoveryStore(root: appRoot).transcriptURL(sessionID: metadata.id), encoding: .utf8)
        XCTAssertTrue(published.contains(#""version":3"#))
        XCTAssertTrue(published.contains(#""role":"custom""#))
        XCTAssertEqual(try Data(contentsOf: source), bytes)
    }

    func testSalvageContinuesOnlyVerifiedEntriesFromTheRecoveryCopy() throws {
        let source = cliRoot.appending(path: "session.jsonl")
        let header = #"{"type":"session","version":3,"id":"cli-salvage","cwd":"/old"}"#
        let message = #"{"type":"message","id":"entry-1","parentId":null}"#
        try Data("\(header)\n\(message)\nnot-json\n".utf8).write(to: source)
        let appRoot = root.appending(path: "PiLot")
        let store = CLISessionStore(root: appRoot, cliRoot: cliRoot) { staged, output, id, project, _ in
            let destination = output.appending(path: "fork-\(id).jsonl")
            let verified = try String(contentsOf: staged, encoding: .utf8)
            XCTAssertFalse(verified.contains("not-json"))
            let entries = verified.split(separator: "\n").dropFirst().joined(separator: "\n")
            try Data("{\"type\":\"session\",\"version\":3,\"id\":\"\(id)\",\"cwd\":\"\(project.path)\"}\n\(entries)\n".utf8).write(to: destination)
            return destination
        }
        let discovered = try XCTUnwrap(store.discover().first)
        XCTAssertEqual(discovered.compatibility, .actionRequired("Session contains malformed durable data"))
        let record = CLISessionRecord(
            id: discovered.id, source: discovered.source, projectPath: discovered.projectPath,
            modifiedAt: discovered.modifiedAt, compatibility: .compatible
        )
        let failure: CLISessionContinuationFailure
        do {
            _ = try store.continueSession(record, in: root)
            return XCTFail("Expected malformed source to fail")
        } catch let error as CLISessionContinuationFailure {
            failure = error
        }

        let metadata = try store.salvageVerifiedEntries(from: failure, session: record, in: root)

        XCTAssertTrue(FileManager.default.fileExists(atPath: SessionRecoveryStore(root: appRoot).transcriptURL(sessionID: metadata.id).path))
    }

    func testFailedContinuationPublishesNothingAndRetainsRecoveryChoices() throws {
        let source = cliRoot.appending(path: "session.jsonl")
        try Data("{\"type\":\"session\",\"version\":3,\"id\":\"cli-3\",\"cwd\":\"/old\"}\n".utf8).write(to: source)
        let appRoot = root.appending(path: "PiLot")
        let store = CLISessionStore(root: appRoot, cliRoot: cliRoot) { _, _, _, _, _ in
            throw CocoaError(.fileReadCorruptFile)
        }
        let record = try XCTUnwrap(store.discover().first)

        XCTAssertThrowsError(try store.continueSession(record, in: URL(fileURLWithPath: "/new"))) { error in
            let failure = error as? CLISessionContinuationFailure
            XCTAssertEqual(failure?.actions, [.retry, .exportRecoveryCopy, .salvageVerifiedEntries])
            XCTAssertTrue(FileManager.default.fileExists(atPath: failure?.recoveryCopy.path ?? ""))
        }
        XCTAssertFalse((try FileManager.default.contentsOfDirectory(at: appRoot, includingPropertiesForKeys: nil)).contains { $0.pathExtension == "jsonl" })
    }
}
