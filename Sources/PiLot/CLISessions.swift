import Foundation

let bundledPiSessionVersion = 3

enum CLISessionCompatibility: Equatable {
    case compatible
    case actionRequired(String)
}

struct CLISessionRecord: Identifiable, Equatable {
    let id: String
    let source: URL
    let projectPath: String
    let modifiedAt: Date
    let compatibility: CLISessionCompatibility
}

enum CLISessionContinuationAction: Equatable {
    case retry
    case exportRecoveryCopy
    case salvageVerifiedEntries
}

struct CLISessionContinuationFailure: LocalizedError {
    let recoveryCopy: URL
    let reason: String
    let actions: [CLISessionContinuationAction] = [.retry, .exportRecoveryCopy, .salvageVerifiedEntries]

    var errorDescription: String? { "CLI session could not be continued: \(reason). The source was not changed and a recovery copy was retained." }

    var salvageSummary: String {
        guard let data = try? Data(contentsOf: recoveryCopy) else { return "The recovery copy could not be inspected for salvage." }
        let lines = data.split(separator: 0x0A)
        let verified = lines.prefix { (try? JSONSerialization.jsonObject(with: Data($0))) is [String: Any] }.count
        return "Salvage would keep \(verified) verified records and omit \(lines.count - verified) unverified records."
    }
}

typealias CLISessionEngineFork = (_ stagedSource: URL, _ outputDirectory: URL, _ id: String, _ project: URL, _ originalSource: URL) throws -> URL

struct CLISessionStore {
    let root: URL
    let cliRoot: URL
    private let engineFork: CLISessionEngineFork
    private let cliCompatibilityReason: String?

    init(
        root: URL? = nil,
        cliRoot: URL? = nil,
        runtimeRoot: URL? = nil,
        cliCompatibilityReason: String? = nil,
        engineFork: CLISessionEngineFork? = nil
    ) {
        self.root = root ?? SessionRecoveryStore().root
        self.cliRoot = cliRoot ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".pi/agent/sessions")
        self.cliCompatibilityReason = cliCompatibilityReason
        let runtime = runtimeRoot ?? Bundle.main.resourceURL?.appending(path: "PiEngine")
        self.engineFork = engineFork ?? { staged, output, id, project, source in
            guard let runtime else { throw PiEngineError.missingRuntime("PiEngine") }
            return try Self.forkWithBundledEngine(staged, output: output, id: id, project: project, source: source, runtime: runtime)
        }
    }

    func discover() throws -> [CLISessionRecord] {
        guard FileManager.default.fileExists(atPath: cliRoot.path) else { return [] }
        let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey]
        guard let enumerator = FileManager.default.enumerator(at: cliRoot, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return [] }
        var sessions: [CLISessionRecord] = []
        for case let url as URL in enumerator where url.pathExtension == "jsonl" {
            guard let header = try? Self.header(at: url) else { continue }
            let version = header["version"] as? Int ?? 1
            let compatibility: CLISessionCompatibility
            if let cliCompatibilityReason {
                compatibility = .actionRequired(cliCompatibilityReason)
            } else if version > bundledPiSessionVersion {
                compatibility = .actionRequired("Session schema \(version) is newer than bundled schema \(bundledPiSessionVersion)")
            } else if (try? Self.validate(url)) == nil {
                compatibility = .actionRequired("Session contains malformed durable data")
            } else {
                compatibility = .compatible
            }
            sessions.append(.init(
                id: header["id"] as? String ?? "",
                source: url,
                projectPath: header["cwd"] as? String ?? "",
                modifiedAt: (try? url.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast,
                compatibility: compatibility
            ))
        }
        return sessions.sorted { $0.modifiedAt > $1.modifiedAt }
    }

    func salvageVerifiedEntries(
        from failure: CLISessionContinuationFailure,
        session: CLISessionRecord,
        in project: URL
    ) throws -> SessionMetadata {
        let salvage = root.appending(path: ".Salvage-\(UUID().uuidString).jsonl")
        defer { try? FileManager.default.removeItem(at: salvage) }
        let data = try Data(contentsOf: failure.recoveryCopy)
        var verified = Data()
        for line in data.split(separator: 0x0A) {
            guard (try? JSONSerialization.jsonObject(with: Data(line))) is [String: Any] else { break }
            verified.append(contentsOf: line)
            verified.append(0x0A)
        }
        try verified.write(to: salvage, options: .atomic)
        _ = try Self.header(at: salvage)
        let salvaged = CLISessionRecord(
            id: session.id, source: salvage, projectPath: session.projectPath,
            modifiedAt: Date(), compatibility: .compatible
        )
        return try continueSession(salvaged, in: project, lineageSource: session.source)
    }

    func continueSession(_ session: CLISessionRecord, in project: URL) throws -> SessionMetadata {
        try continueSession(session, in: project, lineageSource: session.source)
    }

    private func continueSession(_ session: CLISessionRecord, in project: URL, lineageSource: URL) throws -> SessionMetadata {
        guard session.compatibility == .compatible else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        let operation = root.appending(path: ".Continuations/\(UUID().uuidString)", directoryHint: .isDirectory)
        let staged = operation.appending(path: "source.jsonl")
        let id = UUID().uuidString
        var published: URL?
        do {
            try FileManager.default.createDirectory(at: operation, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: session.source, to: staged)
            try Self.validate(staged)
            let output = try engineFork(staged, operation, id, project, lineageSource)
            let header = try Self.header(at: output)
            guard header["id"] as? String == id else { throw CocoaError(.fileReadCorruptFile) }

            let metadata = SessionMetadata(id: id, projectPath: project.standardizedFileURL.resolvingSymlinksInPath().path, state: .ready)
            let destination = root.appending(path: output.lastPathComponent)
            try FileManager.default.moveItem(at: output, to: destination)
            published = destination
            let store = SessionRecoveryStore(root: root)
            try store.save(metadata: metadata)
            try store.saveDraft("", sessionID: id)
            try? FileManager.default.removeItem(at: operation)
            return metadata
        } catch {
            if let published { try? FileManager.default.removeItem(at: published) }
            try? FileManager.default.removeItem(at: root.appending(path: "\(id).metadata.json"))
            try? FileManager.default.removeItem(at: root.appending(path: "\(id).draft"))
            let copy = try preserve((try? Data(contentsOf: staged)) ?? Data(contentsOf: session.source), sessionID: session.id)
            try? FileManager.default.removeItem(at: operation)
            throw CLISessionContinuationFailure(recoveryCopy: copy, reason: error.localizedDescription)
        }
    }

    private func preserve(_ data: Data, sessionID: String) throws -> URL {
        let directory = root.appending(path: "RecoveryCopies", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let copy = directory.appending(path: "cli-\(sessionID)-\(UUID().uuidString).jsonl")
        try data.write(to: copy, options: .withoutOverwriting)
        return copy
    }

    private static func header(at url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let first = data.split(separator: 0x0A).first,
              let header = try JSONSerialization.jsonObject(with: Data(first)) as? [String: Any],
              header["type"] as? String == "session",
              header["id"] is String
        else { throw CocoaError(.fileReadCorruptFile) }
        return header
    }

    private static func validate(_ url: URL) throws {
        let data = try Data(contentsOf: url)
        guard !data.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
        for line in data.split(separator: 0x0A) {
            guard (try JSONSerialization.jsonObject(with: Data(line))) is [String: Any] else {
                throw CocoaError(.fileReadCorruptFile)
            }
        }
        _ = try header(at: url)
    }

    private static func forkWithBundledEngine(
        _ staged: URL,
        output: URL,
        id: String,
        project: URL,
        source: URL,
        runtime: URL
    ) throws -> URL {
        let layout = RuntimeLayout(root: runtime, architecture: RuntimeLayout.currentArchitecture)
        let module = runtime.appending(path: "node_modules/@earendil-works/pi-coding-agent/dist/index.js")
        guard FileManager.default.isExecutableFile(atPath: layout.node.path) else { throw PiEngineError.missingRuntime(layout.node.path) }
        guard FileManager.default.fileExists(atPath: module.path) else { throw PiEngineError.missingRuntime(module.path) }
        let script = #"""
        import { pathToFileURL } from 'node:url';
        import { readFileSync, writeFileSync } from 'node:fs';
        const [modulePath, staged, output, id, project, original] = process.argv.slice(1);
        const { SessionManager } = await import(pathToFileURL(modulePath));
        SessionManager.open(staged, output);
        const fork = SessionManager.forkFrom(staged, project, output, { id });
        const file = fork.getSessionFile();
        const lines = readFileSync(file, 'utf8').split('\n');
        const header = JSON.parse(lines[0]);
        header.parentSession = original;
        lines[0] = JSON.stringify(header);
        writeFileSync(file, lines.join('\n'));
        SessionManager.open(file, output, project);
        process.stdout.write(file);
        """#
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = layout.node
        process.arguments = ["--input-type=module", "-e", script, module.path, staged.path, output.path, id, project.path, source.path]
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()
        let result = String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let error = String(decoding: stderr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard process.terminationStatus == 0, !result.isEmpty else {
            throw PiEngineError.command(error.isEmpty ? "Bundled Pi session validation failed." : error.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return URL(fileURLWithPath: result)
    }
}
