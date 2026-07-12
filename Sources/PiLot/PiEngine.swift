import Combine
import Foundation

struct RuntimeLayout: Equatable {
    let root: URL
    let architecture: String

    var node: URL { root.appending(path: "node-darwin-\(architecture)/bin/node") }
    var cli: URL { root.appending(path: "node_modules/@earendil-works/pi-coding-agent/dist/cli.js") }

    static var currentArchitecture: String {
        #if arch(arm64)
        "arm64"
        #elseif arch(x86_64)
        "x64"
        #else
        #error("PiLot supports only Apple silicon and Intel Macs")
        #endif
    }
}

struct LFJSONDecoder {
    private(set) var buffer = Data()

    mutating func append(_ bytes: Data) throws -> [[String: Any]] {
        buffer.append(bytes)
        var records: [[String: Any]] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            var record = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            if record.last == 0x0D { record.removeLast() }
            guard !record.isEmpty,
                  let value = try JSONSerialization.jsonObject(with: record) as? [String: Any]
            else { throw PiEngineError.malformedOutput }
            records.append(value)
        }
        return records
    }
}

enum PiEngineError: LocalizedError {
    case missingRuntime(String)
    case malformedOutput
    case exited(Int32)

    var errorDescription: String? {
        switch self {
        case .missingRuntime(let path): "Bundled Pi engine is missing: \(path)"
        case .malformedOutput: "The bundled Pi engine returned malformed RPC data."
        case .exited(let status): "The bundled Pi engine exited with status \(status)."
        }
    }
}

@MainActor
final class PiEngine: ObservableObject {
    @Published private(set) var status = "Starting bundled Pi engine…"
    @Published private(set) var isReady = false

    private var process: Process?
    private var decoder = LFJSONDecoder()
    private var launchProject: URL?

    func start(resources: URL) {
        launch(resources: resources, project: nil)
    }

    func openProject(_ project: URL, resources: URL) {
        let canonical = project.standardizedFileURL.resolvingSymlinksInPath()
        guard launchProject != canonical else { return }
        stop()
        launch(resources: resources, project: canonical)
    }

    func openSafeSurface(resources: URL) {
        guard launchProject != nil else { return }
        stop()
        launch(resources: resources, project: nil)
    }

    private func launch(resources: URL, project: URL?) {
        guard process == nil else { return }
        let layout = RuntimeLayout(root: resources.appending(path: "PiEngine"), architecture: RuntimeLayout.currentArchitecture)
        guard FileManager.default.isExecutableFile(atPath: layout.node.path) else {
            fail(PiEngineError.missingRuntime(layout.node.path)); return
        }
        guard FileManager.default.fileExists(atPath: layout.cli.path) else {
            fail(PiEngineError.missingRuntime(layout.cli.path)); return
        }

        let task = Process()
        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        task.executableURL = layout.node
        task.arguments = project == nil
            ? [layout.cli.path, "--mode", "rpc", "--no-session", "--no-approve", "--offline",
               "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]
            : [layout.cli.path, "--mode", "rpc", "--no-session", "--approve", "--offline"]
        task.currentDirectoryURL = project ?? FileManager.default.homeDirectoryForCurrentUser
        var environment = ProcessInfo.processInfo.environment
        environment.keys.filter { $0.hasPrefix("DYLD_") || $0 == "NODE_OPTIONS" || $0 == "NODE_PATH" }.forEach {
            environment.removeValue(forKey: $0)
        }
        environment["PI_OFFLINE"] = "1"
        environment["PI_SKIP_VERSION_CHECK"] = "1"
        environment["PI_TELEMETRY"] = "0"
        task.environment = environment
        task.standardInput = input
        task.standardOutput = output
        task.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in self?.receive(data) }
        }
        task.terminationHandler = { [weak self] task in
            Task { @MainActor in
                guard self?.process === task else { return }
                self?.fail(PiEngineError.exited(task.terminationStatus))
            }
        }

        do {
            try task.run()
            process = task
            launchProject = project
            status = project.map { "Loading \($0.lastPathComponent)…" } ?? "Starting bundled Pi engine…"
            try input.fileHandleForWriting.write(contentsOf: Data("{\"id\":\"startup\",\"type\":\"get_state\"}\n".utf8))
        } catch {
            fail(error)
        }
    }

    private func receive(_ data: Data) {
        do {
            for record in try decoder.append(data)
            where record["type"] as? String == "response" && record["id"] as? String == "startup" {
                guard record["success"] as? Bool == true else { throw PiEngineError.malformedOutput }
                isReady = true
                status = "Bundled Pi engine ready"
            }
        } catch {
            process?.terminate()
            fail(error)
        }
    }

    private func fail(_ error: Error) {
        isReady = false
        status = error.localizedDescription
    }

    private func stop() {
        (process?.standardOutput as? Pipe)?.fileHandleForReading.readabilityHandler = nil
        process?.terminationHandler = nil
        process?.terminate()
        process = nil
        launchProject = nil
        decoder = LFJSONDecoder()
        isReady = false
    }

    deinit { process?.terminate() }
}
