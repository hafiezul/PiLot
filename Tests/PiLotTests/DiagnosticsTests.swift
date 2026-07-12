import Foundation
import XCTest
@testable import PiLot

final class DiagnosticsTests: XCTestCase {
    func testDefaultSupportExportContainsSafeFactsAndExcludesWorkContent() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        let configuration = root.appending(path: "settings.json")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: [
            "theme": "dark", "apiKey": "credential-secret", root.path: "user-specific-key",
        ]).write(to: configuration)
        defer { try? FileManager.default.removeItem(at: root) }

        let input = SupportBundleInput(
            runtime: .init(pilot: "1.0", pi: "0.80.6", node: "22.19.0", macOS: "14.0", cpu: "arm64"),
            compatibility: [.init(
                surface: "extension:test", title: "Extension failed", scope: "project",
                path: root.appending(path: "project/private.ts").path,
                reason: "Load failed", consequence: "The extension is disabled.",
                repairAction: "Repair it in Pi CLI."
            )],
            events: [.init(kind: .error, message: "Engine failed at \(root.path); HOME=\(ProcessInfo.processInfo.environment["HOME"] ?? "")")],
            configurationFiles: [configuration],
            rawLogs: ["raw-log-secret"],
            sessionContent: [
                "prompt": "prompt-secret", "response": "response-secret", "file": "file-secret",
                "diff": "diff-secret", "toolArguments": "arguments-secret", "toolResult": "result-secret",
            ]
        )

        let data = try SupportBundleExporter().data(for: input)
        let text = try XCTUnwrap(String(data: data, encoding: .utf8))

        XCTAssertTrue(text.contains("0.80.6"))
        XCTAssertTrue(text.contains("Extension failed"))
        XCTAssertTrue(text.contains("apiKey"))
        XCTAssertTrue(text.contains("$PRIVATE"))
        for excluded in [
            root.path, ProcessInfo.processInfo.environment["HOME"] ?? root.path,
            "credential-secret", "raw-log-secret", "prompt-secret", "response-secret",
            "file-secret", "diff-secret", "arguments-secret", "result-secret",
        ] {
            XCTAssertFalse(text.contains(excluded), "Default bundle leaked \(excluded)")
        }
    }

    func testSensitiveSelectionsAreSeparateAndDisclosed() throws {
        let input = SupportBundleInput(
            runtime: .init(pilot: "1", pi: "2", node: "3", macOS: "4", cpu: "5"),
            rawLogs: ["selected log"], sessionContent: ["prompt": "selected prompt"]
        )

        let logs = try SupportBundleExporter().data(for: input, options: .init(includeRawLogs: true))
        let content = try SupportBundleExporter().data(for: input, options: .init(includeSessionContent: true))

        XCTAssertTrue(String(decoding: logs, as: UTF8.self).contains("selected log"))
        XCTAssertFalse(String(decoding: logs, as: UTF8.self).contains("selected prompt"))
        XCTAssertTrue(String(decoding: content, as: UTF8.self).contains("selected prompt"))
        XCTAssertFalse(String(decoding: content, as: UTF8.self).contains("selected log"))
        XCTAssertNotNil(SupportBundleOptions(includeRawLogs: true).disclosureWarning)
        XCTAssertNotNil(SupportBundleOptions(includeSessionContent: true).disclosureWarning)
    }

    func testDiagnosticLogIsBoundedAndRedactsEnvironmentAndCredentialValues() {
        let log = DiagnosticLog(maxEntries: 2, environment: ["TOKEN": "environment-secret"])

        log.append("first")
        log.append("Authorization: Bearer credential-secret environment-secret")
        log.append("last" + String(repeating: "x", count: 20_000))

        let entries = log.entries
        XCTAssertEqual(entries.count, 2)
        XCTAssertLessThanOrEqual(entries.last?.count ?? .max, 16_384)
        XCTAssertFalse(entries.joined().contains("environment-secret"))
        XCTAssertFalse(entries.joined().contains("credential-secret"))
        XCTAssertTrue(entries.joined().contains("[REDACTED]"))
    }
}
