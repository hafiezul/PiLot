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

private final class RPCRecordDecoder: @unchecked Sendable {
    private var decoder = LFJSONDecoder()

    func append(_ data: Data) throws -> [[String: Any]] { try decoder.append(data) }
    func reset() { decoder = LFJSONDecoder() }
}

struct PiModel: Identifiable, Hashable {
    let id: String
    let name: String
    let provider: String
    let reasoning: Bool

    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String,
              let provider = value["provider"] as? String
        else { return nil }
        self.id = id
        name = value["name"] as? String ?? id
        self.provider = provider
        reasoning = value["reasoning"] as? Bool ?? false
    }
}

enum PiThinkingLevel: String, CaseIterable, Identifiable {
    case off, minimal, low, medium, high, xhigh, max
    var id: String { rawValue }
    var title: String { rawValue == "xhigh" ? "Extra high" : rawValue.capitalized }
}

struct PiToolRun: Identifiable, Equatable {
    enum Status: Equatable { case running, succeeded, failed }
    let id: String
    let name: String
    var output = ""
    var status: Status = .running
}

struct PiSessionState {
    var assistantText = ""
    var tools: [String: PiToolRun] = [:]
    var toolOrder: [String] = []
    var models: [PiModel] = []
    var model: PiModel?
    var thinkingLevel: PiThinkingLevel = .off
    var isRunning = false
    var isSettled = false
    var lastPrompt = ""

    var orderedTools: [PiToolRun] { toolOrder.compactMap { tools[$0] } }

    mutating func apply(_ record: [String: Any]) throws {
        guard let type = record["type"] as? String else { throw PiEngineError.malformedOutput }
        switch type {
        case "agent_start":
            isRunning = true
            isSettled = false
        case "agent_end", "turn_start", "turn_end", "message_start", "message_end",
             "queue_update", "compaction_start", "compaction_end", "auto_retry_start",
             "auto_retry_end", "extension_error", "extension_ui_request":
            break
        case "agent_settled":
            isRunning = false
            isSettled = true
        case "message_update":
            guard let event = record["assistantMessageEvent"] as? [String: Any],
                  let eventType = event["type"] as? String
            else { throw PiEngineError.malformedOutput }
            switch eventType {
            case "text_delta":
                guard let delta = event["delta"] as? String else { throw PiEngineError.malformedOutput }
                assistantText += delta
            case "start", "text_start", "text_end", "thinking_start", "thinking_delta", "thinking_end",
                 "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error":
                break
            default:
                throw PiEngineError.unknownProtocol(eventType)
            }
        case "tool_execution_start":
            let (id, name) = try toolIdentity(record)
            guard tools[id] == nil else { throw PiEngineError.malformedOutput }
            tools[id] = PiToolRun(id: id, name: name)
            toolOrder.append(id)
        case "tool_execution_update":
            let (id, _) = try toolIdentity(record)
            guard var tool = tools[id], let result = record["partialResult"] as? [String: Any] else {
                throw PiEngineError.malformedOutput
            }
            tool.output = Self.textContent(result)
            tools[id] = tool
        case "tool_execution_end":
            let (id, _) = try toolIdentity(record)
            guard var tool = tools[id], let result = record["result"] as? [String: Any],
                  let isError = record["isError"] as? Bool
            else { throw PiEngineError.malformedOutput }
            tool.output = Self.textContent(result)
            tool.status = isError ? .failed : .succeeded
            tools[id] = tool
        default:
            throw PiEngineError.unknownProtocol(type)
        }
    }

    private func toolIdentity(_ record: [String: Any]) throws -> (String, String) {
        guard let id = record["toolCallId"] as? String,
              let name = record["toolName"] as? String
        else { throw PiEngineError.malformedOutput }
        return (id, name)
    }

    private static func textContent(_ result: [String: Any]) -> String {
        (result["content"] as? [[String: Any]])?
            .compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
            .joined(separator: "\n") ?? ""
    }
}

enum PiEngineError: LocalizedError {
    case missingRuntime(String)
    case malformedOutput
    case unknownProtocol(String)
    case command(String)
    case exited(Int32)

    var errorDescription: String? {
        switch self {
        case .missingRuntime(let path): "Bundled Pi engine is missing: \(path)"
        case .malformedOutput: "The bundled Pi engine returned malformed RPC data. This session was stopped without replaying the prompt."
        case .unknownProtocol(let type): "The bundled Pi engine returned unknown RPC data (\(type)). This session was stopped without replaying the prompt."
        case .command(let message): message
        case .exited(let status): "The bundled Pi engine exited with status \(status)."
        }
    }
}

@MainActor
final class PiEngine: ObservableObject {
    @Published private(set) var status = "Starting bundled Pi engine…"
    @Published private(set) var isReady = false
    @Published private(set) var session = PiSessionState()
    @Published private(set) var configurationPending = false

    private var process: Process?
    private var input: FileHandle?
    private let recordDecoder = RPCRecordDecoder()
    private let decodeQueue = DispatchQueue(label: "dev.pi.pilot.rpc-decoder")
    private var launchProject: URL?
    private var resources: URL?
    private var pendingCommands: [String: String] = [:]
    private var pendingModels: [String: PiModel] = [:]
    private var pendingThinking: [String: PiThinkingLevel] = [:]
    private var requestNumber = 0
    private var generation = UUID()

    func start(resources: URL) {
        self.resources = resources
        launch(resources: resources, project: nil, sessionID: nil)
    }

    func openProject(_ project: URL, resources: URL) {
        let canonical = project.standardizedFileURL.resolvingSymlinksInPath()
        guard launchProject != canonical || process == nil else { return }
        self.resources = resources
        stopProcess(status: nil)
        launch(resources: resources, project: canonical, sessionID: UUID().uuidString)
    }

    func openSafeSurface(resources: URL) {
        self.resources = resources
        guard launchProject != nil else { return }
        stopProcess(status: nil)
        launchProject = nil
        launch(resources: resources, project: nil, sessionID: nil)
    }

    func newSession() {
        guard let resources, let project = launchProject else { return }
        stopProcess(status: nil)
        launch(resources: resources, project: project, sessionID: UUID().uuidString)
    }

    func sendPrompt(_ text: String) {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, isReady, !session.isRunning, !configurationPending else { return }
        session.lastPrompt = message
        session.assistantText = ""
        session.tools = [:]
        session.toolOrder = []
        session.isRunning = true
        session.isSettled = false
        status = "Submitting prompt…"
        send(type: "prompt", fields: ["message": message])
    }

    func setModel(_ model: PiModel) {
        guard isReady, !session.isRunning, model != session.model else { return }
        let id = send(type: "set_model", fields: ["provider": model.provider, "modelId": model.id])
        pendingModels[id] = model
        configurationPending = true
    }

    func setThinkingLevel(_ level: PiThinkingLevel) {
        guard isReady, !session.isRunning, level != session.thinkingLevel else { return }
        let id = send(type: "set_thinking_level", fields: ["level": level.rawValue])
        pendingThinking[id] = level
        configurationPending = true
    }

    func abort() {
        guard session.isRunning else { return }
        status = "Abort requested…"
        send(type: "abort")
    }

    func stopSession() {
        stopProcess(status: "Session stopped")
    }

    private func launch(resources: URL, project: URL?, sessionID: String?) {
        guard process == nil else { return }
        let layout = RuntimeLayout(root: resources.appending(path: "PiEngine"), architecture: RuntimeLayout.currentArchitecture)
        guard FileManager.default.isExecutableFile(atPath: layout.node.path) else {
            fail(PiEngineError.missingRuntime(layout.node.path)); return
        }
        guard FileManager.default.fileExists(atPath: layout.cli.path) else {
            fail(PiEngineError.missingRuntime(layout.cli.path)); return
        }

        let task = Process()
        let inputPipe = Pipe()
        let output = Pipe()
        let errors = Pipe()
        task.executableURL = layout.node
        var arguments = [layout.cli.path, "--mode", "rpc", project == nil ? "--no-approve" : "--approve", "--offline"]
        if let project, let sessionID {
            let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appending(path: "PiLot/Sessions", directoryHint: .isDirectory)
            do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
            catch { fail(error); return }
            arguments += ["--session-dir", directory.path, "--session-id", sessionID]
            task.currentDirectoryURL = project
        } else {
            arguments += ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]
            task.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        }
        task.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment.keys.filter { $0.hasPrefix("DYLD_") || $0 == "NODE_OPTIONS" || $0 == "NODE_PATH" }.forEach {
            environment.removeValue(forKey: $0)
        }
        environment["PI_OFFLINE"] = "1"
        environment["PI_SKIP_VERSION_CHECK"] = "1"
        environment["PI_TELEMETRY"] = "0"
        task.environment = environment
        task.standardInput = inputPipe
        task.standardOutput = output
        task.standardError = errors
        generation = UUID()
        let generation = self.generation
        let recordDecoder = self.recordDecoder
        let decodeQueue = self.decodeQueue
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            decodeQueue.async {
                do {
                    let records = try recordDecoder.append(data)
                    Task { @MainActor [weak self] in
                        guard let self, self.generation == generation else { return }
                        do { for record in records { try self.receive(record) } }
                        catch { self.fail(error) }
                    }
                } catch {
                    Task { @MainActor [weak self] in
                        guard let self, self.generation == generation else { return }
                        self.fail(error)
                    }
                }
            }
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
            input = inputPipe.fileHandleForWriting
            launchProject = project
            session = PiSessionState()
            status = project.map { "Loading \($0.lastPathComponent)…" } ?? "Starting bundled Pi engine…"
            send(type: "get_state")
            send(type: "get_available_models")
        } catch {
            fail(error)
        }
    }

    @discardableResult
    private func send(type: String, fields: [String: Any] = [:]) -> String {
        requestNumber += 1
        let id = "pilot-\(requestNumber)"
        var command = fields
        command["id"] = id
        command["type"] = type
        pendingCommands[id] = type
        do {
            let data = try JSONSerialization.data(withJSONObject: command) + Data([0x0A])
            try input?.write(contentsOf: data)
        } catch {
            fail(error)
        }
        return id
    }

    private func receive(_ record: [String: Any]) throws {
        guard let type = record["type"] as? String else { throw PiEngineError.malformedOutput }
        if type == "response" {
            try receiveResponse(record)
        } else {
            try session.apply(record)
            switch type {
            case "agent_start": status = "Running"
            case "agent_settled": status = "Done"
            case "auto_retry_start": status = "Retrying…"
            case "compaction_start": status = "Compacting…"
            default: break
            }
        }
    }

    private func receiveResponse(_ record: [String: Any]) throws {
        guard let id = record["id"] as? String,
              let command = record["command"] as? String,
              pendingCommands.removeValue(forKey: id) == command,
              let success = record["success"] as? Bool
        else { throw PiEngineError.malformedOutput }
        guard success else {
            throw PiEngineError.command(record["error"] as? String ?? "Pi rejected the \(command) command.")
        }

        switch command {
        case "get_state":
            guard let data = record["data"] as? [String: Any],
                  let level = data["thinkingLevel"] as? String,
                  let thinking = PiThinkingLevel(rawValue: level)
            else { throw PiEngineError.malformedOutput }
            session.thinkingLevel = thinking
            if let value = data["model"] as? [String: Any] {
                guard let model = PiModel(value) else { throw PiEngineError.malformedOutput }
                session.model = model
            } else if !(data["model"] is NSNull) {
                throw PiEngineError.malformedOutput
            }
            configurationPending = !pendingModels.isEmpty || !pendingThinking.isEmpty
            isReady = true
            status = launchProject == nil ? "Bundled Pi engine ready" : "Ready"
        case "get_available_models":
            guard let data = record["data"] as? [String: Any], let values = data["models"] as? [[String: Any]] else {
                throw PiEngineError.malformedOutput
            }
            session.models = try values.map {
                guard let model = PiModel($0) else { throw PiEngineError.malformedOutput }
                return model
            }
        case "set_model":
            guard pendingModels.removeValue(forKey: id) != nil else { throw PiEngineError.malformedOutput }
            send(type: "get_state")
        case "set_thinking_level":
            guard pendingThinking.removeValue(forKey: id) != nil else { throw PiEngineError.malformedOutput }
            send(type: "get_state")
        case "prompt":
            status = "Running"
        case "abort":
            break
        default:
            throw PiEngineError.unknownProtocol(command)
        }
    }

    private func fail(_ error: Error) {
        stopProcess(status: error.localizedDescription)
    }

    private func stopProcess(status newStatus: String?) {
        generation = UUID()
        (process?.standardOutput as? Pipe)?.fileHandleForReading.readabilityHandler = nil
        (process?.standardError as? Pipe)?.fileHandleForReading.readabilityHandler = nil
        process?.terminationHandler = nil
        process?.terminate()
        process = nil
        input = nil
        decodeQueue.sync { recordDecoder.reset() }
        pendingCommands = [:]
        pendingModels = [:]
        pendingThinking = [:]
        configurationPending = false
        isReady = false
        session.isRunning = false
        if let newStatus { status = newStatus }
    }

    deinit { process?.terminate() }
}
