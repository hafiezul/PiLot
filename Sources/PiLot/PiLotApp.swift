import SwiftUI

@main
struct PiLotApp: App {
    @StateObject private var engine = PiEngine()

    var body: some Scene {
        WindowGroup {
            ContentView(engine: engine)
                .frame(minWidth: 520, minHeight: 360)
                .task {
                    if let resources = Bundle.main.resourceURL {
                        engine.start(resources: resources)
                    }
                }
        }
        .windowStyle(.titleBar)
    }
}

private struct ContentView: View {
    @ObservedObject var engine: PiEngine
    private let versions = VersionInfo.current

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 12) {
                Image(systemName: engine.isReady ? "checkmark.circle.fill" : "gearshape.2")
                    .foregroundStyle(engine.isReady ? .green : .secondary)
                    .font(.title)
                VStack(alignment: .leading) {
                    Text("PiLot").font(.title.bold())
                    Text(engine.status).foregroundStyle(.secondary)
                }
            }

            Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 10) {
                versionRow("PiLot", versions.pilot)
                versionRow("Pi", versions.pi)
                versionRow("Node", versions.node)
                versionRow("macOS", versions.macOS)
                versionRow("CPU", versions.cpu)
            }
            .textSelection(.enabled)
            Spacer()
        }
        .padding(32)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func versionRow(_ name: String, _ value: String) -> some View {
        GridRow {
            Text(name).fontWeight(.medium)
            Text(value).font(.system(.body, design: .monospaced))
        }
    }
}

private struct VersionInfo {
    let pilot: String
    let pi: String
    let node: String
    let macOS: String
    let cpu: String

    static var current: VersionInfo {
        let manifest = Bundle.main.url(forResource: "versions", withExtension: "json", subdirectory: "PiEngine")
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode(RuntimeVersions.self, from: $0) }
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "local"
        return VersionInfo(
            pilot: "\(short) (\(build))",
            pi: manifest?.pi ?? "unknown",
            node: manifest?.node ?? "unknown",
            macOS: ProcessInfo.processInfo.operatingSystemVersionString,
            cpu: RuntimeLayout.currentArchitecture
        )
    }
}

private struct RuntimeVersions: Decodable {
    let pi: String
    let node: String
}
