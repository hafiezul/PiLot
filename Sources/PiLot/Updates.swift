import Combine
import Foundation

struct UpdateRelease: Decodable, Equatable {
    let version: String
    let releaseNotes: String

    func isNewer(than installedVersion: String) -> Bool {
        guard let available = Self.components(version), let installed = Self.components(installedVersion) else { return false }
        let count = max(available.count, installed.count)
        for index in 0..<count {
            let left = index < available.count ? available[index] : 0
            let right = index < installed.count ? installed[index] : 0
            if left != right { return left > right }
        }
        return false
    }

    private static func components(_ version: String) -> [Int]? {
        let values = version.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard !values.isEmpty, values.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) else { return nil }
        let components = values.map(Int.init)
        guard components.allSatisfy({ $0 != nil }) else { return nil }
        return components.compactMap { $0 }
    }
}

enum PiLotDistribution {
    static let updateMetadata = URL(string: "https://github.com/hafiezul/PiLot/releases/latest/download/update.json")!
    static let releases = URL(string: "https://github.com/hafiezul/PiLot/releases")!
}

@MainActor
final class ManualUpdateChecker: ObservableObject {
    enum State: Equatable {
        case idle
        case checking
        case current(UpdateRelease)
        case available(UpdateRelease)
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    func check() {
        guard state != .checking else { return }
        state = .checking
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(from: PiLotDistribution.updateMetadata)
                guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
                    throw URLError(.badServerResponse)
                }
                let release = try JSONDecoder().decode(UpdateRelease.self, from: data)
                let installed = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
                state = release.isNewer(than: installed) ? .available(release) : .current(release)
            } catch {
                state = .failed("Update check failed: \(error.localizedDescription)")
            }
        }
    }
}
