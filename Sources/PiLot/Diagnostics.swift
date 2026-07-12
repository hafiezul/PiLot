import Foundation

struct RuntimeFacts: Codable, Equatable {
    let pilot: String
    let pi: String
    let node: String
    let macOS: String
    let cpu: String
}

struct DiagnosticEvent: Codable, Equatable {
    enum Kind: String, Codable { case lifecycle, error }

    let kind: Kind
    let message: String
    let date: Date

    init(kind: Kind, message: String, date: Date = Date()) {
        self.kind = kind
        self.message = message
        self.date = date
    }
}

struct SupportBundleOptions: Equatable {
    var includeRawLogs = false
    var includeSessionContent = false

    var disclosureWarning: String? {
        guard includeRawLogs || includeSessionContent else { return nil }
        return "Selected raw logs or session content may contain private work. Review the local file before sharing it."
    }
}

struct SupportBundleInput {
    let runtime: RuntimeFacts
    var compatibility: [PiResourceDiagnostic] = []
    var events: [DiagnosticEvent] = []
    var configurationFiles: [URL] = []
    var rawLogs: [String] = []
    var sessionContent: [String: String] = [:]
}

final class DiagnosticLog: @unchecked Sendable {
    static let shared = DiagnosticLog()

    private let lock = NSLock()
    private let maxEntries: Int
    private let redactor: PrivacyRedactor
    private var storage: [String] = []
    private var eventStorage: [DiagnosticEvent] = []

    init(maxEntries: Int = 500, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.maxEntries = max(1, maxEntries)
        redactor = PrivacyRedactor(environment: environment)
    }

    func append(_ message: String) {
        lock.lock()
        defer { lock.unlock() }
        appendRedacted(message)
    }

    func record(_ kind: DiagnosticEvent.Kind, _ message: String) {
        lock.lock()
        defer { lock.unlock() }
        let message = redactor.redact(message)
        eventStorage.append(.init(kind: kind, message: message))
        if eventStorage.count > maxEntries { eventStorage.removeFirst(eventStorage.count - maxEntries) }
        appendRedacted("[\(kind.rawValue)] \(message)")
    }

    var entries: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    var events: [DiagnosticEvent] {
        lock.lock()
        defer { lock.unlock() }
        return eventStorage
    }

    private func appendRedacted(_ message: String) {
        storage.append(String(redactor.redact(message).prefix(16_384)))
        if storage.count > maxEntries { storage.removeFirst(storage.count - maxEntries) }
    }
}

struct SupportBundleExporter {
    func data(for input: SupportBundleInput, options: SupportBundleOptions = .init()) throws -> Data {
        let privateRoots = input.configurationFiles.map { $0.deletingLastPathComponent().path }
        let redactor = PrivacyRedactor(privatePaths: privateRoots)
        var bundle: [String: Any] = [
            "formatVersion": 1,
            "runtime": try object(input.runtime),
            "compatibility": input.compatibility.map { diagnostic in
                [
                    "surface": redactor.redact(diagnostic.surface),
                    "title": redactor.redact(diagnostic.title),
                    "state": diagnostic.state.rawValue,
                    "scope": diagnostic.scope,
                    "path": redactor.redact(diagnostic.path),
                    "reason": redactor.redact(diagnostic.reason),
                    "behavior": redactor.redact(diagnostic.consequence),
                    "retainedState": redactor.redact(diagnostic.retainedState),
                    "possibleLoss": redactor.redact(diagnostic.possibleLoss),
                    "recoveryCopy": redactor.redact(diagnostic.recoveryCopy),
                    "nextAction": redactor.redact(diagnostic.repairAction),
                ]
            },
            "events": input.events.map {
                ["kind": $0.kind.rawValue, "message": redactor.redact($0.message), "date": ISO8601DateFormatter().string(from: $0.date)]
            },
            "configurationStructure": configurationStructure(input.configurationFiles, redactor: redactor),
        ]
        if options.includeRawLogs { bundle["rawLogs"] = input.rawLogs.map(redactor.redact) }
        if options.includeSessionContent {
            bundle["sessionContent"] = input.sessionContent.mapValues(redactor.redact)
        }
        return try JSONSerialization.data(withJSONObject: bundle, options: [.prettyPrinted, .sortedKeys])
    }

    func export(_ input: SupportBundleInput, options: SupportBundleOptions = .init(), to url: URL) throws {
        try data(for: input, options: options).write(to: url, options: .atomic)
    }

    private func object<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }

    private func configurationStructure(_ files: [URL], redactor: PrivacyRedactor) -> [[String: Any]] {
        files.compactMap { url in
            guard let data = try? Data(contentsOf: url),
                  let dictionary = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return nil }
            return [
                "file": redactor.redact(url.lastPathComponent),
                "scope": url.path.contains("/.pi/") ? "project or user" : "app",
                "fields": Dictionary(uniqueKeysWithValues: dictionary.map {
                    (redactor.redact($0.key), Self.jsonType($0.value))
                }),
            ]
        }
    }

    private static func jsonType(_ value: Any) -> String {
        switch value {
        case is NSNull: "null"
        case is Bool: "boolean"
        case is String: "string"
        case is NSNumber: "number"
        case is [Any]: "array"
        case is [String: Any]: "object"
        default: "unknown"
        }
    }
}

private struct PrivacyRedactor {
    private let replacements: [String]
    private let bearer = try! NSRegularExpression(pattern: "(?i)(authorization\\s*:\\s*bearer\\s+)[^\\s]+")
    private let credential = try! NSRegularExpression(pattern: "(?i)((?:api[_-]?key|token|password|secret)\\s*[=:]\\s*)[^\\s,;]+")
    private let secretToken = try! NSRegularExpression(pattern: "\\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\\b")
    private let absolutePath = try! NSRegularExpression(pattern: "(?<![A-Za-z0-9])/(?:[^\\s\\\"']+/)*[^\\s\\\"']+")

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        privatePaths: [String] = []
    ) {
        replacements = (Array(environment.values) + privatePaths + [FileManager.default.homeDirectoryForCurrentUser.path])
            .filter { $0.count >= 4 }
            .sorted { $0.count > $1.count }
    }

    func redact(_ value: String) -> String {
        var result = value
        for replacement in replacements { result = result.replacingOccurrences(of: replacement, with: "$PRIVATE") }
        let range = NSRange(result.startIndex..., in: result)
        result = bearer.stringByReplacingMatches(in: result, range: range, withTemplate: "$1[REDACTED]")
        result = credential.stringByReplacingMatches(
            in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1[REDACTED]"
        )
        result = secretToken.stringByReplacingMatches(
            in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "[REDACTED]"
        )
        return absolutePath.stringByReplacingMatches(
            in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$PATH"
        )
    }
}
