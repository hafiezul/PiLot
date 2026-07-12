import Foundation

struct PiCLIMatrix: Equatable {
    let bundledVersion: String
    let detectedVersion: String?

    var state: PiCompatibilityState {
        guard let detectedVersion else { return .compatible }
        return detectedVersion == bundledVersion ? .compatible : .actionRequired
    }

    var allowsPiLotSessions: Bool { true }
    var allowsSharedStateWrites: Bool { state == .compatible }
    var allowsCLIContinuation: Bool { detectedVersion != nil && state == .compatible }

    var report: PiResourceDiagnostic {
        let detected = detectedVersion.map { "Pi CLI \($0)" } ?? "No Pi CLI detected"
        if state == .compatible {
            return .init(
                surface: "runtime:cli", title: "Pi CLI compatibility", state: .compatible,
                scope: "user", path: "Installed Pi CLI", reason: "\(detected); bundled Pi is \(bundledVersion).",
                consequence: detectedVersion == nil ? "PiLot sessions remain usable; no CLI session can be continued." : "Shared-state writes and CLI continuation are enabled.",
                retainedState: "PiLot-owned sessions remain available.",
                repairAction: detectedVersion == nil ? "Install Pi CLI only if CLI history is needed." : "No action needed."
            )
        }
        return .init(
            surface: "runtime:cli", title: "Pi CLI version needs attention", state: .actionRequired,
            scope: "user", path: "Installed Pi CLI", reason: "Detected Pi CLI \(detectedVersion ?? "unknown"); this release is tested with \(bundledVersion).",
            consequence: "Shared Pi settings writes and CLI-session continuation are blocked; PiLot-owned sessions remain usable.",
            retainedState: "No CLI session or shared setting was changed.",
            repairAction: "Use Pi CLI \(bundledVersion), then reopen PiLot."
        )
    }
}

struct InstalledPiCLI {
    static func version(environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        guard let path = environment["PATH"] else { return nil }
        for directory in path.split(separator: ":") {
            let executable = URL(fileURLWithPath: String(directory)).appending(path: "pi")
            guard FileManager.default.isExecutableFile(atPath: executable.path) else { continue }
            var candidate = executable.resolvingSymlinksInPath().deletingLastPathComponent()
            for _ in 0..<5 {
                let package = candidate.appending(path: "package.json")
                if let data = try? Data(contentsOf: package),
                   let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   value["name"] as? String == "@earendil-works/pi-coding-agent",
                   let version = value["version"] as? String {
                    return version
                }
                candidate.deleteLastPathComponent()
            }
        }
        return nil
    }
}

private struct ResourceFingerprint: Equatable, Sendable {
    let modifiedAt: Date
    let size: Int
}

struct ResourceSnapshot: Equatable, Sendable {
    private let files: [String: ResourceFingerprint]

    static func capture(
        project: URL?,
        agentDirectory: URL = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".pi/agent")
    ) -> ResourceSnapshot {
        var roots = [
            agentDirectory.appending(path: "settings.json"),
            agentDirectory.appending(path: "models.json"),
            agentDirectory.appending(path: "auth.json"),
            agentDirectory.appending(path: "keybindings.json"),
        ]
        for name in ["extensions", "skills", "prompts", "themes", "packages"] {
            roots.append(agentDirectory.appending(path: name, directoryHint: .isDirectory))
        }
        if let project {
            let configuration = project.appending(path: ".pi", directoryHint: .isDirectory)
            roots.append(configuration.appending(path: "settings.json"))
            for name in ["extensions", "skills", "prompts", "themes"] {
                roots.append(configuration.appending(path: name, directoryHint: .isDirectory))
            }
        }

        var files: [String: ResourceFingerprint] = [:]
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey]
        func record(_ file: URL) {
            guard let values = try? file.resourceValues(forKeys: keys), values.isRegularFile == true else { return }
            files[file.path] = .init(modifiedAt: values.contentModificationDate ?? .distantPast, size: values.fileSize ?? 0)
        }
        for root in roots {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) else { continue }
            if !isDirectory.boolValue {
                record(root)
                continue
            }
            guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles]) else { continue }
            for case let file as URL in enumerator { record(file) }
        }
        return ResourceSnapshot(files: files)
    }
}

struct UnsupportedPiPresentation {
    static func reports(
        project: URL?,
        agentDirectory: URL = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".pi/agent")
    ) -> [PiResourceDiagnostic] {
        var resources: [(String, URL, String)] = []
        let keybindings = agentDirectory.appending(path: "keybindings.json")
        if FileManager.default.fileExists(atPath: keybindings.path) {
            resources.append(("keybindings", keybindings, "user"))
        }
        let themeRoots = [agentDirectory.appending(path: "themes", directoryHint: .isDirectory)] + (project.map {
            [$0.appending(path: ".pi/themes", directoryHint: .isDirectory)]
        } ?? [])
        for root in themeRoots {
            guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]) else { continue }
            for case let file as URL in enumerator where file.pathExtension == "json" {
                resources.append(("theme", file, project.map { file.path.hasPrefix($0.path) } == true ? "project" : "user"))
            }
        }
        return resources.map { kind, url, scope in
            .init(
                surface: "unsupported:\(url.path)", title: "Pi \(kind)", state: .unsupported,
                scope: scope, path: url.path, reason: "Native macOS appearance and shortcuts are authoritative.",
                consequence: "This \(kind) is listed for transparency but is not imported or executed by PiLot.",
                retainedState: "The source file remains unchanged and usable in Pi CLI.",
                repairAction: "Use Pi CLI when this terminal-specific presentation is required."
            )
        }
    }
}

enum PiSettingsWrite: Equatable {
    case model(provider: String, id: String)
    case thinking(PiThinkingLevel)
}

struct PiSettingsWriter {
    let resources: URL
    let project: URL
    var agentDirectory = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".pi/agent")

    func persist(_ change: PiSettingsWrite) throws {
        let layout = RuntimeLayout(root: resources.appending(path: "PiEngine"), architecture: RuntimeLayout.currentArchitecture)
        let script = layout.root.appending(path: "settings-write.js")
        guard FileManager.default.isExecutableFile(atPath: layout.node.path), FileManager.default.fileExists(atPath: script.path) else {
            throw PiEngineError.missingRuntime(script.path)
        }
        let arguments: [String]
        switch change {
        case .model(let provider, let id): arguments = ["model", provider, id]
        case .thinking(let level): arguments = ["thinking", level.rawValue]
        }
        let process = Process()
        let errors = Pipe()
        process.executableURL = layout.node
        process.arguments = [script.path, project.path, agentDirectory.path] + arguments
        process.standardError = errors
        process.standardOutput = Pipe()
        process.environment = sanitizedEnvironment()
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let reason = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            throw PiEngineError.command(reason.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    private func sanitizedEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment.keys.filter { $0.hasPrefix("DYLD_") || $0 == "NODE_OPTIONS" || $0 == "NODE_PATH" }.forEach { environment.removeValue(forKey: $0) }
        return environment
    }
}
