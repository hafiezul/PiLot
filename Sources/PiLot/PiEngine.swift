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
    let supportsImages: Bool

    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String,
              let provider = value["provider"] as? String
        else { return nil }
        self.id = id
        name = value["name"] as? String ?? id
        self.provider = provider
        reasoning = value["reasoning"] as? Bool ?? false
        supportsImages = (value["input"] as? [String])?.contains("image") == true
    }
}

enum PiThinkingLevel: String, CaseIterable, Identifiable {
    case off, minimal, low, medium, high, xhigh, max
    var id: String { rawValue }
    var title: String { rawValue == "xhigh" ? "Extra high" : rawValue.capitalized }
}

struct PiCommand: Identifiable, Equatable {
    enum Source: String { case extensionCommand = "extension", prompt, skill }

    let name: String
    let description: String
    let source: Source
    let scope: String
    let path: String
    var id: String { "\(source.rawValue):\(name):\(path)" }
    var invocation: String { "/\(name)" }

    init?(_ value: [String: Any]) {
        guard let name = value["name"] as? String, !name.isEmpty,
              let rawSource = value["source"] as? String, let source = Source(rawValue: rawSource),
              let info = value["sourceInfo"] as? [String: Any],
              let scope = info["scope"] as? String, let path = info["path"] as? String
        else { return nil }
        self.name = name
        description = value["description"] as? String ?? ""
        self.source = source
        self.scope = scope
        self.path = path
    }
}

struct PiResourceDiagnostic: Identifiable, Equatable {
    let surface: String
    let title: String
    let scope: String
    let path: String
    let reason: String
    let consequence: String
    let repairAction: String
    var id: String { surface }
}

struct PiExtensionPresentation: Identifiable, Equatable {
    let id: String
    let title: String
    let content: String
}

enum PiInterruptionResponse: Equatable {
    case value(String)
    case confirmed(Bool)
    case cancelled
}

struct PiInterruption: Identifiable, Equatable {
    enum Method: String { case select, confirm, input, editor }
    enum Resolution: Equatable { case active, answered, cancelled, timedOut }

    let id: String
    let method: Method
    let title: String
    let message: String?
    let options: [String]
    let placeholder: String?
    let prefill: String?
    let timeoutMilliseconds: Int?
    var resolution: Resolution = .active

    init?(_ record: [String: Any]) throws {
        guard let methodName = record["method"] as? String else { throw PiEngineError.malformedOutput }
        guard let method = Method(rawValue: methodName) else { return nil }
        guard let id = record["id"] as? String, let title = record["title"] as? String else {
            throw PiEngineError.malformedOutput
        }
        self.id = id
        self.method = method
        self.title = title
        if let timeout = record["timeout"] {
            guard let milliseconds = timeout as? Int, milliseconds >= 0 else { throw PiEngineError.malformedOutput }
            timeoutMilliseconds = milliseconds
        } else {
            timeoutMilliseconds = nil
        }

        switch method {
        case .select:
            guard let choices = record["options"] as? [String] else { throw PiEngineError.malformedOutput }
            options = choices
            message = nil
            placeholder = nil
            prefill = nil
        case .confirm:
            guard let detail = record["message"] as? String else { throw PiEngineError.malformedOutput }
            message = detail
            options = []
            placeholder = nil
            prefill = nil
        case .input:
            if let value = record["placeholder"], !(value is String) { throw PiEngineError.malformedOutput }
            message = nil
            options = []
            placeholder = record["placeholder"] as? String
            prefill = nil
        case .editor:
            if let value = record["prefill"], !(value is String) { throw PiEngineError.malformedOutput }
            message = nil
            options = []
            placeholder = nil
            prefill = record["prefill"] as? String
        }
    }
}

enum PiTimelineItem: Equatable, Identifiable {
    case tool(String)
    case interruption(String)
    case extensionPresentation(String)

    var id: String {
        switch self {
        case .tool(let id): "tool:\(id)"
        case .interruption(let id): "interruption:\(id)"
        case .extensionPresentation(let id): "extension:\(id)"
        }
    }
}

struct PiToolRun: Identifiable, Equatable {
    enum Status: Equatable { case running, succeeded, failed }
    let id: String
    let name: String
    var changedPath: String?
    var arguments = ""
    var output = ""
    var details = ""
    var status: Status = .running
}

enum SessionAttentionState: Equatable {
    case waiting, failed, running, done

    var sortOrder: Int {
        switch self {
        case .waiting: 0
        case .failed: 1
        case .running: 2
        case .done: 3
        }
    }
}

struct PiSessionState {
    var assistantText = ""
    var tools: [String: PiToolRun] = [:]
    var toolOrder: [String] = []
    var models: [PiModel] = []
    var model: PiModel?
    var commands: [PiCommand] = []
    var resourceDiagnostics: [PiResourceDiagnostic] = []
    var extensionPresentations: [PiExtensionPresentation] = []
    var requestedEditorText: String?
    var thinkingLevel: PiThinkingLevel = .off
    var isRunning = false
    var isSettled = false
    var isRetrying = false
    var isCompacting = false
    var steeringQueue: [String] = []
    var followUpQueue: [String] = []
    var lastPrompt = ""
    var lastRunChangedPaths: [String] = []
    var interruptions: [PiInterruption] = []
    var timelineItems: [PiTimelineItem] = []

    var orderedTools: [PiToolRun] { toolOrder.compactMap { tools[$0] } }
    var activeInterruptions: [PiInterruption] { interruptions.filter { $0.resolution == .active } }
    var isWaitingForInput: Bool { !activeInterruptions.isEmpty }

    mutating func loadCommands(_ values: [[String: Any]]) {
        commands = []
        resourceDiagnostics.removeAll { $0.surface.hasPrefix("command:") }
        for (index, value) in values.enumerated() {
            if let command = PiCommand(value) {
                commands.append(command)
            } else {
                let info = value["sourceInfo"] as? [String: Any]
                addDiagnostic(.init(
                    surface: "command:\(index)", title: "Invalid Pi command",
                    scope: info?["scope"] as? String ?? "unknown",
                    path: info?["path"] as? String ?? "Unknown path",
                    reason: "Pi returned incomplete or unsupported command metadata.",
                    consequence: "Only this command was skipped; other Pi resources remain available.",
                    repairAction: "Open the resource in Pi CLI, correct it, then restart this session."
                ))
            }
        }
    }

    mutating func loadModels(_ values: [[String: Any]]) {
        models = []
        resourceDiagnostics.removeAll { $0.surface.hasPrefix("model:") }
        for (index, value) in values.enumerated() {
            if let model = PiModel(value) {
                models.append(model)
            } else {
                addDiagnostic(.init(
                    surface: "model:\(index)", title: "Invalid Pi model", scope: "user",
                    path: "~/.pi/agent/models.json", reason: "Pi returned incomplete model metadata.",
                    consequence: "Only this model was skipped; other configured models remain available.",
                    repairAction: "Run Pi CLI and repair models.json before restarting this session."
                ))
            }
        }
    }

    mutating func resolveInterruption(id: String, response: PiInterruptionResponse) throws -> [String: Any] {
        guard let index = interruptions.firstIndex(where: { $0.id == id && $0.resolution == .active }) else {
            throw PiEngineError.command("This input request is no longer waiting.")
        }
        let interruption = interruptions[index]
        var payload: [String: Any] = ["type": "extension_ui_response", "id": id]
        switch response {
        case .value(let value):
            guard interruption.method == .input || interruption.method == .editor ||
                    (interruption.method == .select && interruption.options.contains(value))
            else { throw PiEngineError.command("That response was not offered by Pi or the extension.") }
            payload["value"] = value
            interruptions[index].resolution = .answered
        case .confirmed(let confirmed):
            guard interruption.method == .confirm else {
                throw PiEngineError.command("This request does not accept confirmation responses.")
            }
            payload["confirmed"] = confirmed
            interruptions[index].resolution = .answered
        case .cancelled:
            payload["cancelled"] = true
            interruptions[index].resolution = .cancelled
        }
        return payload
    }

    @discardableResult
    mutating func timeoutInterruption(id: String) -> Bool {
        guard let index = interruptions.firstIndex(where: { $0.id == id && $0.resolution == .active }) else {
            return false
        }
        interruptions[index].resolution = .timedOut
        return true
    }

    mutating func cancelActiveInterruptions() {
        for index in interruptions.indices where interruptions[index].resolution == .active {
            interruptions[index].resolution = .cancelled
        }
    }

    mutating func apply(_ record: [String: Any]) throws {
        guard let type = record["type"] as? String else { throw PiEngineError.malformedOutput }
        switch type {
        case "agent_start":
            isRunning = true
            isSettled = false
        case "agent_end", "turn_start", "turn_end", "message_start", "message_end":
            break
        case "extension_error":
            guard let path = record["extensionPath"] as? String,
                  let event = record["event"] as? String,
                  let error = record["error"] as? String
            else { throw PiEngineError.malformedOutput }
            let scope = path.hasPrefix(FileManager.default.homeDirectoryForCurrentUser.path) ? "user" : "project"
            addDiagnostic(.init(
                surface: "extension:\(path):\(event)", title: "Extension event failed", scope: scope,
                path: path, reason: error,
                consequence: "The \(event) hook was skipped; the session and other extensions remain active.",
                repairAction: "Open this extension in Pi CLI, repair the failing hook, then restart this session."
            ))
        case "extension_ui_request":
            guard let method = record["method"] as? String else { throw PiEngineError.malformedOutput }
            if let interruption = try PiInterruption(record) {
                guard !interruptions.contains(where: { $0.id == interruption.id }) else {
                    throw PiEngineError.malformedOutput
                }
                interruptions.append(interruption)
                timelineItems.append(.interruption(interruption.id))
            } else {
                try Self.validateFireAndForgetUI(record, method: method)
                applyExtensionPresentation(record, method: method)
            }
        case "queue_update":
            guard let steering = record["steering"] as? [String],
                  let followUp = record["followUp"] as? [String]
            else { throw PiEngineError.malformedOutput }
            steeringQueue = steering
            followUpQueue = followUp
        case "compaction_start":
            guard record["reason"] is String else { throw PiEngineError.malformedOutput }
            isCompacting = true
            isRunning = true
            isSettled = false
        case "compaction_end":
            guard record["reason"] is String,
                  record["aborted"] is Bool,
                  record["willRetry"] is Bool
            else { throw PiEngineError.malformedOutput }
            isCompacting = false
        case "auto_retry_start":
            guard record["attempt"] is Int,
                  record["maxAttempts"] is Int,
                  record["delayMs"] is Int,
                  record["errorMessage"] is String
            else { throw PiEngineError.malformedOutput }
            isRetrying = true
            isRunning = true
            isSettled = false
        case "auto_retry_end":
            guard record["success"] is Bool, record["attempt"] is Int else {
                throw PiEngineError.malformedOutput
            }
            isRetrying = false
        case "agent_settled":
            isRunning = false
            isSettled = true
            isRetrying = false
            isCompacting = false
            steeringQueue = []
            followUpQueue = []
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
            var tool = PiToolRun(id: id, name: name)
            let arguments = record["args"] as? [String: Any]
            if name == "edit" || name == "write" {
                tool.changedPath = arguments?["path"] as? String ?? arguments?["file_path"] as? String
            }
            tool.arguments = Self.structuredText(record["args"])
            tools[id] = tool
            toolOrder.append(id)
            timelineItems.append(.tool(id))
        case "tool_execution_update":
            let (id, name) = try toolIdentity(record)
            guard var tool = tools[id], let result = record["partialResult"] as? [String: Any] else {
                throw PiEngineError.malformedOutput
            }
            apply(result, to: &tool, surface: "tool:\(name)")
            tools[id] = tool
        case "tool_execution_end":
            let (id, name) = try toolIdentity(record)
            guard var tool = tools[id], let result = record["result"] as? [String: Any],
                  let isError = record["isError"] as? Bool
            else { throw PiEngineError.malformedOutput }
            apply(result, to: &tool, surface: "tool:\(name)")
            tool.status = isError ? .failed : .succeeded
            if !isError, let path = tool.changedPath, !lastRunChangedPaths.contains(path) {
                lastRunChangedPaths.append(path)
            }
            tools[id] = tool
        default:
            throw PiEngineError.unknownProtocol(type)
        }
    }

    private static func validateFireAndForgetUI(_ record: [String: Any], method: String) throws {
        guard record["id"] is String else { throw PiEngineError.malformedOutput }
        switch method {
        case "notify":
            guard record["message"] is String else { throw PiEngineError.malformedOutput }
            if let type = record["notifyType"], !(type is String) { throw PiEngineError.malformedOutput }
        case "setStatus":
            guard record["statusKey"] is String else { throw PiEngineError.malformedOutput }
            if let text = record["statusText"], !(text is String) { throw PiEngineError.malformedOutput }
        case "setWidget":
            guard record["widgetKey"] is String else { throw PiEngineError.malformedOutput }
            if let lines = record["widgetLines"], !(lines is [String]) { throw PiEngineError.malformedOutput }
        case "setTitle":
            guard record["title"] is String else { throw PiEngineError.malformedOutput }
        case "set_editor_text":
            guard record["text"] is String else { throw PiEngineError.malformedOutput }
        default:
            throw PiEngineError.unknownProtocol(method)
        }
    }

    private mutating func applyExtensionPresentation(_ record: [String: Any], method: String) {
        guard let id = record["id"] as? String else { return }
        let title = record["title"] as? String ?? record["message"] as? String ?? method
        let payload = record.filter { !["type", "id", "method", "title"].contains($0.key) }
        let presentation = PiExtensionPresentation(id: id, title: title, content: Self.structuredText(payload))
        extensionPresentations.removeAll { $0.id == id }
        extensionPresentations.append(presentation)
        timelineItems.append(.extensionPresentation(id))
        if method == "set_editor_text" { requestedEditorText = record["text"] as? String }
    }

    private mutating func apply(_ result: [String: Any], to tool: inout PiToolRun, surface: String) {
        tool.output = Self.contentText(result["content"])
        tool.details = Self.structuredText(result["details"])
        let content = result["content"] as? [[String: Any]] ?? []
        if !tool.details.isEmpty || content.contains(where: { $0["type"] as? String != "text" }) {
            addDiagnostic(.init(
                surface: surface, title: "Generic tool presentation", scope: "extension or built-in tool",
                path: tool.name,
                reason: "The tool returned structured details or rich content.",
                consequence: "Arguments, content, details, progress, and errors are shown generically; no TUI renderer was executed.",
                repairAction: "Use Pi CLI only if this tool's terminal-specific renderer is required."
            ))
        }
    }

    private mutating func addDiagnostic(_ diagnostic: PiResourceDiagnostic) {
        guard !resourceDiagnostics.contains(where: { $0.surface == diagnostic.surface }) else { return }
        resourceDiagnostics.append(diagnostic)
    }

    private func toolIdentity(_ record: [String: Any]) throws -> (String, String) {
        guard let id = record["toolCallId"] as? String,
              let name = record["toolName"] as? String
        else { throw PiEngineError.malformedOutput }
        return (id, name)
    }

    private static func contentText(_ value: Any?) -> String {
        guard let content = value as? [[String: Any]] else { return structuredText(value) }
        return content.compactMap { item in
            if item["type"] as? String == "text" { return item["text"] as? String }
            return structuredText(item)
        }.joined(separator: "\n")
    }

    private static func structuredText(_ value: Any?) -> String {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8)
        else { return "" }
        return text
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
    @Published private(set) var recovery: RecoveredSession?
    @Published private(set) var restoredDraft = ""
    @Published private(set) var ownershipRequiresFork = false
    @Published private(set) var attentionState: SessionAttentionState = .done
    @Published private(set) var activityDate = Date()
    @Published private(set) var attentionAnnouncement = 0

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
    private var interruptionTimeouts: [String: Task<Void, Never>] = [:]
    private let recoveryStore = SessionRecoveryStore()
    private var metadata: SessionMetadata?
    private var writerLease: SessionWriterLease?

    func start(resources: URL) {
        self.resources = resources
        guard process == nil, launchProject == nil else { return }
        launch(resources: resources, project: nil, sessionID: nil)
    }

    func openProject(_ project: URL, resources: URL) {
        let canonical = project.standardizedFileURL.resolvingSymlinksInPath()
        guard launchProject != canonical || process == nil else { return }
        self.resources = resources
        stopProcess(status: nil)
        launchProject = canonical
        do {
            if let existing = try recoveryStore.latest(projectPath: canonical.path) {
                let lease = SessionWriterLease(root: recoveryStore.root, sessionID: existing.id)
                guard try lease.acquire() == .acquired else {
                    let recovered = try recoveryStore.recover(sessionID: existing.id, allowRepair: false)
                    metadata = recovered.metadata
                    recovery = recovered
                    restoredDraft = recovered.draft
                    ownershipRequiresFork = true
                    status = "Another owner may be writing this session — fork to continue"
                    return
                }
                writerLease = lease
                let recovered = try recoveryStore.recover(sessionID: existing.id)
                metadata = recovered.metadata
                recovery = recovered
                restoredDraft = recovered.draft
                guard recovered.metadata.state != .interrupted, recovered.issue == nil else {
                    setAttention(.failed)
                    status = recovered.actions.isEmpty
                        ? "Interrupted — restart or fork without replaying unfinished work"
                        : "Transcript needs recovery — open read-only, export, or fork verified entries"
                    return
                }
                launch(resources: resources, project: canonical, sessionID: existing.id)
            } else {
                try beginNewSession(project: canonical, resources: resources)
            }
        } catch {
            fail(error)
        }
    }

    func openSafeSurface(resources: URL) {
        self.resources = resources
        guard launchProject != nil else { return }
        stopProcess(status: nil)
        launchProject = nil
        metadata = nil
        recovery = nil
        restoredDraft = ""
        launch(resources: resources, project: nil, sessionID: nil)
    }

    func newSession() {
        guard let resources, let project = launchProject else { return }
        markMetadata(.done)
        stopProcess(status: nil)
        do { try beginNewSession(project: project, resources: resources) }
        catch { fail(error) }
    }

    func startNewSession(project: URL, resources: URL) {
        let canonical = project.standardizedFileURL.resolvingSymlinksInPath()
        guard process == nil else { return }
        self.resources = resources
        launchProject = canonical
        do { try beginNewSession(project: canonical, resources: resources) }
        catch { fail(error) }
    }

    func startForkedSession(_ imported: SessionMetadata, project: URL, resources: URL) {
        let canonical = project.standardizedFileURL.resolvingSymlinksInPath()
        guard process == nil, imported.projectPath == canonical.path else { return }
        self.resources = resources
        launchProject = canonical
        do {
            let lease = SessionWriterLease(root: recoveryStore.root, sessionID: imported.id)
            guard try lease.acquire() == .acquired else {
                throw PiEngineError.command("The CLI session fork could not acquire its writer lease.")
            }
            metadata = imported
            writerLease = lease
            recovery = nil
            ownershipRequiresFork = false
            restoredDraft = ""
            launch(resources: resources, project: canonical, sessionID: imported.id)
        } catch { fail(error) }
    }

    func restartRecoveredSession() {
        guard let resources, let project = launchProject, let recovery,
              recovery.actions.isEmpty, !ownershipRequiresFork
        else { return }
        self.recovery = nil
        launch(resources: resources, project: project, sessionID: recovery.metadata.id)
    }

    func forkRecoveredSession() {
        guard let resources, let project = launchProject, let recovery else { return }
        do {
            let fork = try recoveryStore.forkVerifiedEntries(from: recovery)
            writerLease?.release()
            writerLease = nil
            let lease = SessionWriterLease(root: recoveryStore.root, sessionID: fork.id)
            guard try lease.acquire() == .acquired else { throw PiEngineError.command("The recovery fork could not acquire its writer lease.") }
            metadata = fork
            writerLease = lease
            self.recovery = nil
            ownershipRequiresFork = false
            launch(resources: resources, project: project, sessionID: fork.id)
        } catch { fail(error) }
    }

    func saveDraft(_ draft: String) {
        guard let metadata, writerLease != nil else { return }
        do { try recoveryStore.saveDraft(draft, sessionID: metadata.id) }
        catch { status = "Composer draft could not be saved: \(error.localizedDescription)" }
    }

    @discardableResult
    func sendPrompt(_ prompt: PiPrompt) -> Bool {
        guard !prompt.message.isEmpty, isReady, !session.isRunning, !configurationPending else { return false }
        session.lastPrompt = prompt.displayMessage
        session.assistantText = ""
        session.tools = [:]
        session.toolOrder = []
        session.lastRunChangedPaths = []
        session.interruptions = []
        session.timelineItems = []
        session.isRunning = true
        session.isSettled = false
        setAttention(.running)
        guard markMetadata(.running) else {
            session.isRunning = false
            return false
        }
        status = "Submitting prompt…"
        send(type: "prompt", fields: prompt.rpcFields)
        return true
    }

    @discardableResult
    func directPrompt(_ prompt: PiPrompt, as delivery: PiPromptDelivery) -> Bool {
        guard !prompt.message.isEmpty, isReady, session.isRunning, !configurationPending else { return false }
        status = delivery == .steer ? "Steering current run…" : "Queueing follow-up…"
        send(type: "prompt", fields: prompt.rpcFields(delivery: delivery))
        return true
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

    func answerInterruption(_ id: String, response: PiInterruptionResponse) {
        let payload: [String: Any]
        do { payload = try session.resolveInterruption(id: id, response: response) }
        catch { status = error.localizedDescription; return }
        interruptionTimeouts.removeValue(forKey: id)?.cancel()
        do { try write(payload) }
        catch { fail(error); return }
        refreshAttentionAfterInterruption()
    }

    func stopSession() {
        markMetadata(.done)
        recovery = nil
        setAttention(.done)
        stopProcess(status: "Session stopped")
    }

    private func beginNewSession(project: URL, resources: URL) throws {
        let session = SessionMetadata(id: UUID().uuidString, projectPath: project.path, state: .ready)
        try recoveryStore.save(metadata: session)
        let lease = SessionWriterLease(root: recoveryStore.root, sessionID: session.id)
        guard try lease.acquire() == .acquired else { throw PiEngineError.command("The new session could not acquire its writer lease.") }
        metadata = session
        writerLease = lease
        recovery = nil
        ownershipRequiresFork = false
        restoredDraft = ""
        launch(resources: resources, project: project, sessionID: session.id)
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
            let directory = recoveryStore.root
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
            send(type: "get_commands")
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
        do { try write(command) }
        catch { fail(error) }
        return id
    }

    private func write(_ payload: [String: Any]) throws {
        guard let input else { throw PiEngineError.command("The Pi engine input stream is unavailable.") }
        let data = try JSONSerialization.data(withJSONObject: payload) + Data([0x0A])
        try input.write(contentsOf: data)
    }

    private func receive(_ record: [String: Any]) throws {
        guard let type = record["type"] as? String else { throw PiEngineError.malformedOutput }
        if type != "message_update" { activityDate = Date() }
        if type == "response" {
            try receiveResponse(record)
        } else {
            try session.apply(record)
            switch type {
            case "agent_start":
                status = "Running"
                setAttention(.running)
            case "agent_settled":
                send(type: "get_commands")
                if session.isWaitingForInput {
                    status = "Waiting for input"
                    setAttention(.waiting)
                } else {
                    status = "Done"
                    setAttention(.done)
                    markMetadata(.done)
                }
            case "extension_ui_request":
                if let id = record["id"] as? String,
                   let interruption = session.activeInterruptions.first(where: { $0.id == id }) {
                    status = "Waiting for input"
                    setAttention(.waiting)
                    scheduleTimeout(for: interruption)
                }
            case "queue_update":
                let count = session.steeringQueue.count + session.followUpQueue.count
                status = count == 0 ? "Running" : "Running · \(count) queued"
            case "auto_retry_start": status = "Retrying…"
            case "auto_retry_end": status = "Running"
            case "compaction_start": status = "Compacting…"
            case "compaction_end": status = "Running"
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
            session.loadModels(values)
        case "get_commands":
            guard let data = record["data"] as? [String: Any], let values = data["commands"] as? [[String: Any]] else {
                throw PiEngineError.malformedOutput
            }
            session.loadCommands(values)
        case "set_model":
            guard pendingModels.removeValue(forKey: id) != nil else { throw PiEngineError.malformedOutput }
            send(type: "get_state")
        case "set_thinking_level":
            guard pendingThinking.removeValue(forKey: id) != nil else { throw PiEngineError.malformedOutput }
            send(type: "get_state")
        case "prompt":
            let count = session.steeringQueue.count + session.followUpQueue.count
            status = count == 0 ? "Running" : "Running · \(count) queued"
        case "abort":
            break
        default:
            throw PiEngineError.unknownProtocol(command)
        }
    }

    private func scheduleTimeout(for interruption: PiInterruption) {
        guard let milliseconds = interruption.timeoutMilliseconds else { return }
        interruptionTimeouts[interruption.id]?.cancel()
        interruptionTimeouts[interruption.id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(milliseconds) * 1_000_000)
            guard !Task.isCancelled, let self,
                  self.session.timeoutInterruption(id: interruption.id)
            else { return }
            self.interruptionTimeouts.removeValue(forKey: interruption.id)
            self.refreshAttentionAfterInterruption()
        }
    }

    private func refreshAttentionAfterInterruption() {
        if session.isWaitingForInput {
            status = "Waiting for input"
            setAttention(.waiting)
        } else if session.isRunning {
            status = "Running"
            setAttention(.running)
        } else {
            status = "Done"
            setAttention(.done)
        }
    }

    private func fail(_ error: Error) {
        if process != nil { markMetadata(.interrupted) }
        setAttention(.failed)
        stopProcess(status: error.localizedDescription)
    }

    private func setAttention(_ state: SessionAttentionState) {
        if state == .waiting && attentionState != .waiting { attentionAnnouncement += 1 }
        attentionState = state
        activityDate = Date()
    }

    @discardableResult
    private func markMetadata(_ state: SessionMetadata.State) -> Bool {
        guard var metadata else { return true }
        metadata.state = state
        metadata.updatedAt = Date()
        do {
            try recoveryStore.save(metadata: metadata)
            self.metadata = metadata
            return true
        } catch {
            status = "Session state could not be saved: \(error.localizedDescription)"
            return false
        }
    }

    private func stopProcess(status newStatus: String?) {
        generation = UUID()
        let stoppedProcess = process
        let stoppedLease = writerLease
        (stoppedProcess?.standardOutput as? Pipe)?.fileHandleForReading.readabilityHandler = nil
        (stoppedProcess?.standardError as? Pipe)?.fileHandleForReading.readabilityHandler = nil
        stoppedProcess?.terminationHandler = nil
        stoppedProcess?.terminate()
        process = nil
        input = nil
        writerLease = nil
        if let stoppedProcess, stoppedProcess.isRunning {
            DispatchQueue.global().async {
                stoppedProcess.waitUntilExit()
                stoppedLease?.release()
            }
        } else {
            stoppedLease?.release()
        }
        decodeQueue.sync { recordDecoder.reset() }
        interruptionTimeouts.values.forEach { $0.cancel() }
        interruptionTimeouts = [:]
        session.cancelActiveInterruptions()
        pendingCommands = [:]
        pendingModels = [:]
        pendingThinking = [:]
        configurationPending = false
        isReady = false
        session.isRunning = false
        if let newStatus { status = newStatus }
    }

    deinit {
        if let process, process.isRunning {
            process.terminate()
            kill(process.processIdentifier, SIGKILL)
        }
    }
}
