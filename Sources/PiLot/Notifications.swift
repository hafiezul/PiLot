import AppKit
import UserNotifications

struct NotificationDestination: Equatable {
    let projectPath: String
    let sessionID: String
    let interruptionID: String?
}

enum SessionNotificationPolicy {
    static func shouldNotify(
        enabled: Bool,
        appIsActive: Bool,
        previous: SessionAttentionState,
        current: SessionAttentionState
    ) -> Bool {
        guard enabled, !appIsActive, previous != current else { return false }
        return switch current {
        case .waiting, .failed: true
        case .done: previous == .running
        case .running: false
        }
    }
}

@MainActor
final class SessionNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published private(set) var enabled: Bool
    @Published private(set) var authorization = "Not requested"
    @Published var destination: NotificationDestination?

    private let center = UNUserNotificationCenter.current()
    private let defaults = UserDefaults.standard
    private let enabledKey = "notificationsEnabled"

    override init() {
        enabled = UserDefaults.standard.bool(forKey: enabledKey)
        super.init()
        center.delegate = self
        refreshAuthorization()
    }

    func setEnabled(_ value: Bool) {
        guard value else {
            enabled = false
            defaults.set(false, forKey: enabledKey)
            return
        }
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.enabled = granted
                self.defaults.set(granted, forKey: self.enabledKey)
                self.refreshAuthorization()
            }
        }
    }

    func post(
        session: SupervisedSessionSummary,
        previous: SessionAttentionState,
        interruptionID: String?
    ) {
        guard SessionNotificationPolicy.shouldNotify(
            enabled: enabled,
            appIsActive: NSApp.isActive,
            previous: previous,
            current: session.state
        ) else { return }

        let content = UNMutableNotificationContent()
        content.title = switch session.state {
        case .waiting: "Input needed"
        case .failed: "Session failed"
        case .done: "Session complete"
        case .running: ""
        }
        content.body = session.title
        content.sound = .default
        content.userInfo = [
            "projectPath": session.projectPath,
            "sessionID": session.id,
            "interruptionID": interruptionID ?? "",
        ]
        center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    func consumeDestination() { destination = nil }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions { [] }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let projectPath = info["projectPath"] as? String,
              let sessionID = info["sessionID"] as? String else { return }
        let interruption = (info["interruptionID"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        await MainActor.run {
            destination = NotificationDestination(
                projectPath: projectPath,
                sessionID: sessionID,
                interruptionID: interruption
            )
            NSApp.activate(ignoringOtherApps: true)
            NSApp.windows.first { $0.canBecomeKey }?.makeKeyAndOrderFront(nil)
        }
    }

    private func refreshAuthorization() {
        center.getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                self?.authorization = switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral: "Allowed"
                case .denied: "Denied in System Settings"
                case .notDetermined: "Not requested"
                @unknown default: "Unknown"
                }
            }
        }
    }
}
