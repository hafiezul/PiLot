import Darwin
import Foundation

struct SessionMetadata: Codable, Equatable {
    enum State: String, Codable { case ready, running, interrupted, done, stopped }

    let id: String
    let projectPath: String
    var state: State
    var title: String
    var isArchived: Bool
    var updatedAt: Date

    init(
        id: String,
        projectPath: String,
        state: State,
        title: String = "Pi session",
        isArchived: Bool = false,
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.projectPath = projectPath
        self.state = state
        self.title = title
        self.isArchived = isArchived
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey { case id, projectPath, state, title, isArchived, updatedAt }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        projectPath = try values.decode(String.self, forKey: .projectPath)
        state = try values.decode(State.self, forKey: .state)
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? "Pi session"
        isArchived = try values.decodeIfPresent(Bool.self, forKey: .isArchived) ?? false
        updatedAt = try values.decodeIfPresent(Date.self, forKey: .updatedAt) ?? .distantPast
    }
}

enum SessionRecoveryIssue: Equatable {
    case repairedIncompleteTail
    case incompleteTailPreserved
    case malformedRecord(line: Int)
}

enum SessionRecoveryAction: Equatable {
    case openReadOnly
    case forkVerifiedEntries
    case exportOriginal
}

struct RecoveredSession {
    let metadata: SessionMetadata
    let draft: String
    let validEntryCount: Int
    let issue: SessionRecoveryIssue?
    let recoveryCopy: URL?

    var actions: [SessionRecoveryAction] {
        switch issue {
        case .malformedRecord: [.openReadOnly, .forkVerifiedEntries, .exportOriginal]
        default: []
        }
    }
}

struct SessionRecoveryStore {
    let root: URL

    init(root: URL? = nil) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "PiLot/Sessions", directoryHint: .isDirectory)
    }

    func transcriptURL(sessionID: String) -> URL {
        let exact = root.appending(path: "\(sessionID).jsonl")
        guard !FileManager.default.fileExists(atPath: exact.path),
              let match = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
                .first(where: { $0.pathExtension == "jsonl" && $0.deletingPathExtension().lastPathComponent.contains(sessionID) })
        else { return exact }
        return match
    }

    func save(metadata: SessionMetadata) throws {
        try atomicWrite(try JSONEncoder().encode(metadata), to: metadataURL(metadata.id), keepPrevious: true)
    }

    func loadMetadata(sessionID: String) throws -> SessionMetadata {
        let url = metadataURL(sessionID)
        do { return try JSONDecoder().decode(SessionMetadata.self, from: Data(contentsOf: url)) }
        catch { return try JSONDecoder().decode(SessionMetadata.self, from: Data(contentsOf: url.appendingPathExtension("previous"))) }
    }

    func saveDraft(_ draft: String, sessionID: String) throws {
        try atomicWrite(Data(draft.utf8), to: draftURL(sessionID), keepPrevious: true)
    }

    func sessions(projectPath: String) throws -> [SessionMetadata] {
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasSuffix(".metadata.json") }
            .map { url in
                do { return try JSONDecoder().decode(SessionMetadata.self, from: Data(contentsOf: url)) }
                catch { return try JSONDecoder().decode(SessionMetadata.self, from: Data(contentsOf: url.appendingPathExtension("previous"))) }
            }
            .filter { $0.projectPath == projectPath }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func latest(projectPath: String) throws -> SessionMetadata? { try sessions(projectPath: projectPath).first }

    func forkVerifiedEntries(from recovery: RecoveredSession) throws -> SessionMetadata {
        let source = try Data(contentsOf: transcriptURL(sessionID: recovery.metadata.id))
        var verified: [[String: Any]] = []
        for (index, line) in source.split(separator: 0x0A).enumerated() {
            guard let record = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  validRecord(record, at: index)
            else { break }
            verified.append(record)
        }
        guard !verified.isEmpty, verified[0]["type"] as? String == "session" else {
            throw SessionRecoveryError.missingHeader
        }
        let id = UUID().uuidString
        verified[0]["id"] = id
        verified[0]["parentSession"] = transcriptURL(sessionID: recovery.metadata.id).path
        let transcript = try verified.reduce(into: Data()) { data, record in
            data.append(try JSONSerialization.data(withJSONObject: record))
            data.append(0x0A)
        }
        try atomicWrite(transcript, to: root.appending(path: "\(id).jsonl"), keepPrevious: false)
        let metadata = SessionMetadata(id: id, projectPath: recovery.metadata.projectPath, state: .interrupted)
        try save(metadata: metadata)
        try saveDraft(recovery.draft, sessionID: id)
        return metadata
    }

    func recover(sessionID: String, allowRepair: Bool = true) throws -> RecoveredSession {
        var metadata = try loadMetadata(sessionID: sessionID)
        if allowRepair, metadata.state == .running {
            metadata.state = .interrupted
            metadata.updatedAt = Date()
            try save(metadata: metadata)
        }
        let draft = (try? String(contentsOf: draftURL(sessionID), encoding: .utf8)) ?? ""
        let transcript = transcriptURL(sessionID: sessionID)
        guard FileManager.default.fileExists(atPath: transcript.path) else {
            return RecoveredSession(metadata: metadata, draft: draft, validEntryCount: 0, issue: nil, recoveryCopy: nil)
        }

        let original = try Data(contentsOf: transcript)
        let hasIncompleteTail = !original.isEmpty && original.last != 0x0A
        let complete: Data
        if hasIncompleteTail {
            let tailStart = original.lastIndex(of: 0x0A).map { original.index(after: $0) } ?? original.startIndex
            let tail = Data(original[tailStart...])
            if (try? JSONSerialization.jsonObject(with: tail)) is [String: Any] {
                complete = original + Data([0x0A])
            } else {
                complete = Data(original[..<tailStart])
            }
        } else {
            complete = original
        }
        let lines = complete.split(separator: 0x0A, omittingEmptySubsequences: false)
        let records = lines.last?.isEmpty == true ? lines.dropLast() : lines[...]
        for (index, line) in records.enumerated() {
            guard !line.isEmpty,
                  let record = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  validRecord(record, at: index)
            else {
                let copy = try preserve(original, sessionID: sessionID)
                return RecoveredSession(
                    metadata: metadata, draft: draft, validEntryCount: index,
                    issue: .malformedRecord(line: index + 1), recoveryCopy: copy
                )
            }
        }
        if hasIncompleteTail {
            guard allowRepair else {
                return RecoveredSession(
                    metadata: metadata, draft: draft, validEntryCount: records.count,
                    issue: .incompleteTailPreserved, recoveryCopy: nil
                )
            }
            let copy = try preserve(original, sessionID: sessionID)
            try atomicWrite(complete, to: transcript, keepPrevious: false)
            return RecoveredSession(
                metadata: metadata, draft: draft, validEntryCount: records.count,
                issue: .repairedIncompleteTail, recoveryCopy: copy
            )
        }
        return RecoveredSession(metadata: metadata, draft: draft, validEntryCount: records.count, issue: nil, recoveryCopy: nil)
    }

    private func validRecord(_ record: [String: Any], at index: Int) -> Bool {
        guard record["type"] is String else { return false }
        if index == 0 {
            return record["type"] as? String == "session" && record["id"] is String && record["cwd"] is String
        }
        return record["id"] is String
    }

    private func metadataURL(_ id: String) -> URL { root.appending(path: "\(id).metadata.json") }
    private func draftURL(_ id: String) -> URL { root.appending(path: "\(id).draft") }

    private func preserve(_ data: Data, sessionID: String) throws -> URL {
        let directory = root.appending(path: "RecoveryCopies", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let copy = directory.appending(path: "\(sessionID)-\(UUID().uuidString).jsonl")
        try data.write(to: copy, options: .withoutOverwriting)
        return copy
    }

    private func atomicWrite(_ data: Data, to url: URL, keepPrevious: Bool) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if keepPrevious, FileManager.default.fileExists(atPath: url.path) {
            let previous = url.appendingPathExtension("previous")
            try? FileManager.default.removeItem(at: previous)
            try FileManager.default.copyItem(at: url, to: previous)
        }
        try data.write(to: url, options: .atomic)
    }
}

enum SessionRecoveryError: LocalizedError {
    case missingHeader

    var errorDescription: String? { "The preserved transcript has no valid Pi session header. Open it read-only or export the original." }
}

final class SessionWriterLease: @unchecked Sendable {
    enum Result: Equatable { case acquired, forkRequired }

    private struct Owner: Codable { let pid: Int32; let token: UUID }
    private let url: URL
    private let owner = Owner(pid: getpid(), token: UUID())
    private var acquired = false

    init(root: URL, sessionID: String) {
        url = root.appending(path: "\(sessionID).lease")
    }

    func acquire() throws -> Result {
        if acquired { return .acquired }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if try create() { acquired = true; return .acquired }

        guard let data = try? Data(contentsOf: url),
              let existing = try? JSONDecoder().decode(Owner.self, from: data),
              kill(existing.pid, 0) == -1, errno == ESRCH
        else { return .forkRequired }
        try? FileManager.default.removeItem(at: url)
        guard try create() else { return .forkRequired }
        acquired = true
        return .acquired
    }

    func release() {
        guard acquired,
              let data = try? Data(contentsOf: url),
              let existing = try? JSONDecoder().decode(Owner.self, from: data),
              existing.token == owner.token
        else { return }
        try? FileManager.default.removeItem(at: url)
        acquired = false
    }

    private func create() throws -> Bool {
        let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            if errno == EEXIST { return false }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { Darwin.close(descriptor) }
        let data = try JSONEncoder().encode(owner)
        do {
            try data.withUnsafeBytes { bytes in
                guard Darwin.write(descriptor, bytes.baseAddress, bytes.count) == bytes.count else {
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
            }
            return true
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    deinit { release() }
}
