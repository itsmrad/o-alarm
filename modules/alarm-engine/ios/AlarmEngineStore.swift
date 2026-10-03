import Foundation

/// The native mirror (D10): one JSON file in Application Support, written atomically with
/// `completeUntilFirstUserAuthentication` protection so it is readable after the first
/// unlock following a reboot (and by App Intents running in the background).
///
/// Not thread-safe on its own: only `AlarmEngineCore` (an actor) touches it.
final class AlarmEngineStore {
  enum LoadError: Error {
    /// The file exists but can't be read (e.g. before first unlock). Never overwrite it.
    case unreadable(String)
  }

  private let fileURL: URL

  init() {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    fileURL = base.appendingPathComponent("AlarmEngine", isDirectory: true)
      .appendingPathComponent("state.json", isDirectory: false)
  }

  /// Returns the persisted state, a fresh one if none exists, or throws `unreadable`.
  /// A corrupt file is moved aside (kept for diagnosis) and reported via `corrupt`.
  func load() throws -> (state: EngineState, corrupt: Bool) {
    guard FileManager.default.fileExists(atPath: fileURL.path) else {
      return (EngineState(), false)
    }
    let data: Data
    do {
      data = try Data(contentsOf: fileURL)
    } catch {
      throw LoadError.unreadable(String(describing: error))
    }
    do {
      return (try JSONDecoder().decode(EngineState.self, from: data), false)
    } catch {
      let aside = fileURL.deletingLastPathComponent()
        .appendingPathComponent("state.corrupt-\(Int(Date().timeIntervalSince1970)).json")
      try? FileManager.default.moveItem(at: fileURL, to: aside)
      return (EngineState(), true)
    }
  }

  func save(_ state: EngineState) throws {
    let directory = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    let data = try JSONEncoder().encode(state)
    try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
}
