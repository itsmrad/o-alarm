import AlarmKit
import AppIntents
import Foundation

/// AlarmKit attribute metadata. Empty: the system alert needs no custom data, and the
/// engine has no countdown presentation, so no widget extension is required.
struct AlarmEngineMetadata: AlarmMetadata {}

// App Intents attached to every alarm (D14). AlarmKit runs them in the app process — launching
// it in the background if needed — so they work with JS dead. Each carries the AlarmKit id
// (lookup key) and the schedule id (diagnostics). They are hidden from Shortcuts/Spotlight.

/// The system Stop button.
struct AlarmEngineStopIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Stop Alarm"
  static let isDiscoverable: Bool = false
  static let openAppWhenRun: Bool = false

  @Parameter(title: "Alarm ID")
  var alarmID: String

  @Parameter(title: "Schedule ID")
  var scheduleId: String

  init() {
    alarmID = ""
    scheduleId = ""
  }

  init(alarmID: String, scheduleId: String) {
    self.alarmID = alarmID
    self.scheduleId = scheduleId
  }

  func perform() async throws -> some IntentResult {
    await AlarmEngineCore.shared.handleSystemStop(alarmID: alarmID)
    return .result()
  }
}

/// "Open" on alarms that need the app (missions, wake check, retrigger): opens O-Alarm,
/// which routes to /ringing via getActiveRinging.
struct AlarmEngineOpenIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Open O-Alarm"
  static let isDiscoverable: Bool = false
  static let openAppWhenRun: Bool = true

  @Parameter(title: "Alarm ID")
  var alarmID: String

  @Parameter(title: "Schedule ID")
  var scheduleId: String

  init() {
    alarmID = ""
    scheduleId = ""
  }

  init(alarmID: String, scheduleId: String) {
    self.alarmID = alarmID
    self.scheduleId = scheduleId
  }

  func perform() async throws -> some IntentResult {
    await AlarmEngineCore.shared.handleOpen(alarmID: alarmID)
    return .result()
  }
}

/// "Snooze" on alarms without missions: arms `<occurrenceKey>#snooze-<n>` natively.
struct AlarmEngineSnoozeIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Snooze Alarm"
  static let isDiscoverable: Bool = false
  static let openAppWhenRun: Bool = false

  @Parameter(title: "Alarm ID")
  var alarmID: String

  @Parameter(title: "Schedule ID")
  var scheduleId: String

  init() {
    alarmID = ""
    scheduleId = ""
  }

  init(alarmID: String, scheduleId: String) {
    self.alarmID = alarmID
    self.scheduleId = scheduleId
  }

  func perform() async throws -> some IntentResult {
    await AlarmEngineCore.shared.handleSnoozeIntent(alarmID: alarmID)
    return .result()
  }
}
