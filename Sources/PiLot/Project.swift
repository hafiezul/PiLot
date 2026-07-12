import AppKit
import Foundation

struct ProjectRecord: Codable, Identifiable, Equatable {
    enum Access: String, Codable { case trusted, readOnly }

    let id: String
    let path: String
    var access: Access
    var selectedSessionID = "approval"
    var inspectorPresented = true
    var lastOpened = Date()

    var name: String { URL(fileURLWithPath: path).lastPathComponent }
    var url: URL { URL(fileURLWithPath: path, isDirectory: true) }
}

struct ProjectIndex: Codable, Equatable {
    private(set) var recents: [ProjectRecord] = []

    mutating func open(_ url: URL, access: ProjectRecord.Access) throws -> ProjectRecord {
        let canonical = try Self.canonicalURL(url)
        let id = canonical.path
        if let index = recents.firstIndex(where: { $0.id == id }) {
            recents[index].access = access
            recents[index].lastOpened = Date()
            let project = recents.remove(at: index)
            recents.insert(project, at: 0)
        } else {
            recents.insert(ProjectRecord(id: id, path: canonical.path, access: access), at: 0)
        }
        return recents[0]
    }

    mutating func updateNavigation(projectID: String, selectedSessionID: String, inspectorPresented: Bool) {
        guard let index = recents.firstIndex(where: { $0.id == projectID }) else { return }
        recents[index].selectedSessionID = selectedSessionID
        recents[index].inspectorPresented = inspectorPresented
    }

    static func canonicalURL(_ url: URL) throws -> URL {
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: canonical.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ProjectError.notDirectory(canonical.path)
        }
        return canonical
    }
}

enum ProjectError: LocalizedError {
    case notDirectory(String)
    case trustBridge(String)

    var errorDescription: String? {
        switch self {
        case .notDirectory(let path): "Choose a project folder, not a file: \(path)"
        case .trustBridge(let reason): "Pi project trust could not be checked: \(reason)"
        }
    }
}

struct ProjectTrustResult: Decodable {
    enum Status: String, Decodable { case unknown, trusted, declined, notRequired }
    let path: String
    let status: Status
}

struct ProjectTrustClient {
    let resources: URL

    func inspect(_ url: URL) throws -> ProjectTrustResult { try run("inspect", url.path) }
    func save(_ url: URL, trusted: Bool) throws -> ProjectTrustResult {
        try run("set", url.path, trusted ? "true" : "false")
    }

    private func run(_ arguments: String...) throws -> ProjectTrustResult {
        let layout = RuntimeLayout(root: resources.appending(path: "PiEngine"), architecture: RuntimeLayout.currentArchitecture)
        let script = layout.root.appending(path: "project-trust.js")
        guard FileManager.default.isExecutableFile(atPath: layout.node.path), FileManager.default.fileExists(atPath: script.path) else {
            throw ProjectError.trustBridge("the bundled trust runtime is missing")
        }

        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = layout.node
        process.arguments = [script.path] + arguments
        process.standardOutput = output
        process.standardError = errors
        var environment = ProcessInfo.processInfo.environment
        environment.keys.filter { $0.hasPrefix("DYLD_") || $0 == "NODE_OPTIONS" || $0 == "NODE_PATH" }.forEach {
            environment.removeValue(forKey: $0)
        }
        process.environment = environment
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let reason = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "unknown failure"
            throw ProjectError.trustBridge(reason.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return try JSONDecoder().decode(ProjectTrustResult.self, from: data)
    }
}

@MainActor
final class ProjectStore: ObservableObject {
    @Published private(set) var index: ProjectIndex
    @Published var activeProjectID: String?
    @Published var pendingTrustURL: URL?
    @Published var errorMessage: String?

    private let defaults: UserDefaults
    private let storageKey = "projectIndex"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        index = defaults.data(forKey: storageKey)
            .flatMap { try? JSONDecoder().decode(ProjectIndex.self, from: $0) } ?? ProjectIndex()
        activeProjectID = index.recents.first?.id
    }

    var activeProject: ProjectRecord? { index.recents.first { $0.id == activeProjectID } }

    func inspect(_ url: URL, resources: URL) async -> ProjectTrustResult? {
        do {
            let canonical = try ProjectIndex.canonicalURL(url)
            let result = try await Task.detached { try ProjectTrustClient(resources: resources).inspect(canonical) }.value
            if result.status == .unknown { pendingTrustURL = URL(fileURLWithPath: result.path, isDirectory: true) }
            return result
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func saveTrust(_ url: URL, trusted: Bool, resources: URL) async -> ProjectRecord? {
        do {
            let result = try await Task.detached {
                try ProjectTrustClient(resources: resources).save(url, trusted: trusted)
            }.value
            pendingTrustURL = nil
            return open(URL(fileURLWithPath: result.path, isDirectory: true), access: trusted ? .trusted : .readOnly)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    @discardableResult
    func open(_ url: URL, access: ProjectRecord.Access) -> ProjectRecord? {
        do {
            let project = try index.open(url, access: access)
            activeProjectID = project.id
            persist()
            NSDocumentController.shared.noteNewRecentDocumentURL(project.url)
            return project
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func updateNavigation(selectedSessionID: String, inspectorPresented: Bool) {
        guard let activeProjectID else { return }
        index.updateNavigation(projectID: activeProjectID, selectedSessionID: selectedSessionID, inspectorPresented: inspectorPresented)
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(index) { defaults.set(data, forKey: storageKey) }
    }
}
