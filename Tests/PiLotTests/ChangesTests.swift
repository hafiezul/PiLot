import Foundation
import XCTest
@testable import PiLot

final class ChangesTests: XCTestCase {
    func testGitInspectionShowsCurrentIndexAndWorkingTreeDiff() throws {
        let project = try makeRepository()
        defer { try? FileManager.default.removeItem(at: project) }
        let file = project.appending(path: "note.txt")
        try "one\ntwo\n".write(to: file, atomically: true, encoding: .utf8)
        try git(["add", "note.txt"], in: project)
        try git(["commit", "-m", "initial"], in: project)
        try "one changed\ntwo\nthree\n".write(to: file, atomically: true, encoding: .utf8)

        let result = try GitInspector().inspect(project: project, lastRunPaths: [], lastRunOnly: false)

        XCTAssertEqual(result.files.map(\.path), ["note.txt"])
        XCTAssertEqual(result.files[0].status, .modified)
        XCTAssertEqual(result.files[0].additions, 2)
        XCTAssertEqual(result.files[0].deletions, 1)
        XCTAssertFalse(result.files[0].hunks.isEmpty)

        try git(["add", "note.txt"], in: project)
        try git(["commit", "-m", "changed"], in: project)
        let settled = try GitInspector().inspect(project: project, lastRunPaths: ["note.txt"], lastRunOnly: true)
        XCTAssertEqual(settled.files[0].status, .unchanged)
    }

    func testLongDiffPreservesEveryLineInAccessibilityOrder() throws {
        let project = try makeRepository()
        defer { try? FileManager.default.removeItem(at: project) }
        let file = project.appending(path: "long.txt")
        let original = (1...2_000).map { "old \($0)" }.joined(separator: "\n") + "\n"
        let changed = (1...2_000).map { "new \($0)" }.joined(separator: "\n") + "\n"
        try original.write(to: file, atomically: true, encoding: .utf8)
        try git(["add", "long.txt"], in: project)
        try git(["commit", "-m", "long fixture"], in: project)
        try changed.write(to: file, atomically: true, encoding: .utf8)

        let result = try GitInspector().inspect(project: project, lastRunPaths: [], lastRunOnly: false)
        let lines = try XCTUnwrap(result.files.first?.hunks.first?.lines)

        XCTAssertEqual(result.files.first?.additions, 2_000)
        XCTAssertEqual(result.files.first?.deletions, 2_000)
        XCTAssertEqual(lines.first, DiffLine(kind: .deletion, oldLine: 1, newLine: nil, text: "old 1"))
        XCTAssertEqual(lines.last, DiffLine(kind: .addition, oldLine: nil, newLine: 2_000, text: "new 2000"))
    }

    func testLastRunUsesStructuredPathsAndLabelsNonGitFallback() throws {
        let project = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: project) }
        try "changed".write(to: project.appending(path: "note.txt"), atomically: true, encoding: .utf8)

        let result = try GitInspector().inspect(project: project, lastRunPaths: ["note.txt", "../outside"], lastRunOnly: true)

        XCTAssertEqual(result.files.map(\.path), ["note.txt"])
        XCTAssertEqual(result.files[0].status, .unavailable)
        XCTAssertTrue(result.unavailableReason?.contains("not a Git") == true)
    }

    func testSuccessfulStructuredWriteAndEditPathsDescribeLatestRun() throws {
        var state = PiSessionState()
        try state.apply(["type": "tool_execution_start", "toolCallId": "write", "toolName": "write", "args": ["path": "new.txt"]])
        try state.apply(["type": "tool_execution_end", "toolCallId": "write", "toolName": "write", "result": ["content": []], "isError": false])
        try state.apply(["type": "tool_execution_start", "toolCallId": "edit", "toolName": "edit", "args": ["file_path": "old.txt"]])
        try state.apply(["type": "tool_execution_end", "toolCallId": "edit", "toolName": "edit", "result": ["content": []], "isError": true])

        XCTAssertEqual(state.lastRunChangedPaths, ["new.txt"])
    }

    @MainActor
    func testProjectEditorPreferenceOverridesEnvironment() throws {
        let project = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: project.appending(path: ".pi"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: project) }
        try #"{"externalEditor":"code --wait"}"#.write(to: project.appending(path: ".pi/settings.json"), atomically: true, encoding: .utf8)

        XCTAssertEqual(FileHandoff.preferredEditor(project: project, environment: ["EDITOR": "nano"]), "code --wait")
    }

    private func makeRepository() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        try git(["init", "-q"], in: url)
        try git(["config", "user.email", "pilot@example.invalid"], in: url)
        try git(["config", "user.name", "PiLot Tests"], in: url)
        return url
    }

    private func git(_ arguments: [String], in directory: URL) throws {
        let process = Process()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = arguments
        process.currentDirectoryURL = directory
        process.standardOutput = Pipe()
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "ChangesTests", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "git failed"])
        }
    }
}
