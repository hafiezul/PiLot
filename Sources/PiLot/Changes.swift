import AppKit
import Foundation

struct ChangedFile: Identifiable, Equatable {
    enum Status: String { case modified = "Modified", added = "Added", deleted = "Deleted", renamed = "Renamed", untracked = "Untracked", unchanged = "No current changes", unavailable = "Current diff unavailable" }

    let path: String
    let status: Status
    let additions: Int
    let deletions: Int
    let hunks: [DiffHunk]
    var id: String { path }
}

struct DiffHunk: Identifiable, Equatable {
    let header: String
    let lines: [DiffLine]
    var id: String { header }
}

struct DiffLine: Equatable {
    enum Kind { case context, addition, deletion }
    let kind: Kind
    let oldLine: Int?
    let newLine: Int?
    let text: String
}

struct ChangeInspection: Equatable {
    let files: [ChangedFile]
    let unavailableReason: String?
}

struct GitInspector {
    func inspect(project: URL, lastRunPaths: [String], lastRunOnly: Bool) throws -> ChangeInspection {
        let project = project.standardizedFileURL.resolvingSymlinksInPath()
        guard (try? run(["rev-parse", "--is-inside-work-tree"], in: project).output.trimmingCharacters(in: .whitespacesAndNewlines)) == "true" else {
            let files = normalized(lastRunPaths, in: project).map {
                ChangedFile(path: $0, status: .unavailable, additions: 0, deletions: 0, hunks: [])
            }
            return ChangeInspection(files: files, unavailableReason: "Git is unavailable or this project is not a Git working tree, so an aggregate diff is unavailable.")
        }
        let hasHead = (try? run(["rev-parse", "--verify", "HEAD"], in: project).status) == 0

        let statusOutput: String
        do {
            statusOutput = try run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], in: project).output
        } catch {
            let files = normalized(lastRunPaths, in: project).map {
                ChangedFile(path: $0, status: .unavailable, additions: 0, deletions: 0, hunks: [])
            }
            return ChangeInspection(files: files, unavailableReason: "Git inspection failed, so an aggregate diff is unavailable: \(error.localizedDescription)")
        }

        let statuses = parseStatus(statusOutput)
        let requested = lastRunOnly ? normalized(lastRunPaths, in: project) : statuses.map(\.path)
        let paths = requested.uniqued().sorted()
        let files = paths.map { path -> ChangedFile in
            let status = statuses.first { $0.path == path }?.status ?? .modified
            let patch: String
            do {
                if status == .untracked || (!hasHead && status != .deleted) {
                    patch = try run(["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--unified=3", "--", "/dev/null", path], in: project, allowedStatuses: [0, 1]).output
                } else {
                    patch = try run(["diff", "--no-ext-diff", "--no-textconv", "--unified=3", "HEAD", "--", path], in: project).output
                }
            } catch {
                return ChangedFile(path: path, status: .unavailable, additions: 0, deletions: 0, hunks: [])
            }
            let hunks = parsePatch(patch)
            return ChangedFile(
                path: path,
                status: statuses.first { $0.path == path }?.status ?? (hunks.isEmpty ? .unchanged : .modified),
                additions: hunks.flatMap(\.lines).filter { $0.kind == .addition }.count,
                deletions: hunks.flatMap(\.lines).filter { $0.kind == .deletion }.count,
                hunks: hunks
            )
        }
        return ChangeInspection(files: files, unavailableReason: nil)
    }

    private func normalized(_ paths: [String], in project: URL) -> [String] {
        paths.compactMap { path in
            let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : project.appending(path: path)
            let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
            guard resolved.path == project.path || resolved.path.hasPrefix(project.path + "/") else { return nil }
            return String(resolved.path.dropFirst(project.path.count + 1))
        }
    }

    private func parseStatus(_ output: String) -> [(path: String, status: ChangedFile.Status)] {
        let records = output.split(separator: "\0", omittingEmptySubsequences: true).map(String.init)
        var result: [(path: String, status: ChangedFile.Status)] = []
        var index = 0
        while index < records.count {
            let record = records[index]
            guard record.count >= 4 else { index += 1; continue }
            let code = String(record.prefix(2))
            let path = String(record.dropFirst(3))
            let status: ChangedFile.Status
            if code == "??" { status = .untracked }
            else if code.contains("R") { status = .renamed }
            else if code.contains("D") { status = .deleted }
            else if code.contains("A") { status = .added }
            else { status = .modified }
            result.append((path, status))
            index += code.contains("R") || code.contains("C") ? 2 : 1 // The second -z field is the source path.
        }
        return result
    }

    private func parsePatch(_ patch: String) -> [DiffHunk] {
        var hunks: [DiffHunk] = []
        var header: String?
        var lines: [DiffLine] = []
        var oldLine = 0
        var newLine = 0

        func finish() {
            if let header { hunks.append(DiffHunk(header: header, lines: lines)) }
            header = nil
            lines = []
        }

        for raw in patch.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if raw.hasPrefix("@@") {
                finish()
                header = raw
                let ranges = raw.split(separator: " ")
                oldLine = Self.startLine(ranges.count > 1 ? String(ranges[1]) : "")
                newLine = Self.startLine(ranges.count > 2 ? String(ranges[2]) : "")
            } else if header != nil, let prefix = raw.first {
                let text = String(raw.dropFirst())
                switch prefix {
                case "+":
                    lines.append(DiffLine(kind: .addition, oldLine: nil, newLine: newLine, text: text)); newLine += 1
                case "-":
                    lines.append(DiffLine(kind: .deletion, oldLine: oldLine, newLine: nil, text: text)); oldLine += 1
                case " ":
                    lines.append(DiffLine(kind: .context, oldLine: oldLine, newLine: newLine, text: text)); oldLine += 1; newLine += 1
                default: break
                }
            }
        }
        finish()
        return hunks
    }

    private static func startLine(_ range: String) -> Int {
        Int(range.dropFirst().split(separator: ",").first ?? "0") ?? 0
    }

    private func run(_ arguments: [String], in directory: URL, allowedStatuses: Set<Int32> = [0]) throws -> (output: String, status: Int32) {
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["--no-pager", "-c", "core.pager=cat", "-c", "diff.external="] + arguments
        process.currentDirectoryURL = directory
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_PAGER"] = "cat"
        environment["GIT_EXTERNAL_DIFF"] = ""
        process.environment = environment
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let errorData = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard allowedStatuses.contains(process.terminationStatus) else {
            throw NSError(domain: "GitInspector", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: String(data: errorData, encoding: .utf8) ?? "Git failed"])
        }
        return (String(data: data, encoding: .utf8) ?? "", process.terminationStatus)
    }
}

@MainActor
final class ChangesStore: ObservableObject {
    @Published private(set) var inspection = ChangeInspection(files: [], unavailableReason: nil)
    @Published private(set) var isLoading = false
    private var generation = UUID()

    func refresh(project: URL?, lastRunPaths: [String], lastRunOnly: Bool) {
        guard let project else {
            inspection = ChangeInspection(files: [], unavailableReason: "Open a project to inspect changes.")
            return
        }
        isLoading = true
        generation = UUID()
        let generation = generation
        Task {
            let result = await Task.detached {
                (try? GitInspector().inspect(project: project, lastRunPaths: lastRunPaths, lastRunOnly: lastRunOnly))
                    ?? ChangeInspection(files: [], unavailableReason: "Git inspection is unavailable.")
            }.value
            guard self.generation == generation else { return }
            inspection = result
            isLoading = false
        }
    }
}

@MainActor
struct FileHandoff {
    static func openInEditor(_ file: URL, project: URL) {
        if let command = preferredEditor(project: project), launch(command, file: file) { return }
        NSWorkspace.shared.open(file)
    }

    static func revealInFinder(_ file: URL) {
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([file])
    }

    static func preferredEditor(project: URL, environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        let settings = [project.appending(path: ".pi/settings.json"), FileManager.default.homeDirectoryForCurrentUser.appending(path: ".pi/agent/settings.json")]
        for file in settings {
            guard let data = try? Data(contentsOf: file),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let editor = json["externalEditor"] as? String,
                  !editor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            return editor
        }
        return environment["VISUAL"] ?? environment["EDITOR"]
    }

    private static func launch(_ command: String, file: URL) -> Bool {
        let parts = command.split(whereSeparator: \.isWhitespace).map(String.init)
        guard let executable = parts.first, let executableURL = executableURL(for: executable) else { return false }
        let process = Process()
        process.executableURL = executableURL
        process.arguments = Array(parts.dropFirst()) + [file.path]
        do { try process.run(); return true } catch { return false }
    }

    private static func executableURL(for executable: String) -> URL? {
        if executable.contains("/") {
            let url = URL(fileURLWithPath: executable)
            return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
        }
        return ProcessInfo.processInfo.environment["PATH"]?
            .split(separator: ":")
            .map { URL(fileURLWithPath: String($0)).appending(path: executable) }
            .first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }
}

private extension Sequence where Element: Hashable {
    func uniqued() -> [Element] {
        var seen: Set<Element> = []
        return filter { seen.insert($0).inserted }
    }
}
