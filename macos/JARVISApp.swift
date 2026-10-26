import AppKit
import Foundation
import SwiftUI
import WebKit

private enum JarvisRuntime {
  /// When packaged by this repository, JARVIS.app lives in `<project>/build`.
  /// An override keeps the app portable for development and future installers.
  static var projectRoot: URL {
    if let raw = ProcessInfo.processInfo.environment["JARVIS_PROJECT_ROOT"],
       !raw.isEmpty {
      return URL(fileURLWithPath: raw, isDirectory: true)
    }
    let bundledRuntime = Bundle.main.resourceURL!
      .appendingPathComponent("jarvis-runtime", isDirectory: true)
    if FileManager.default.fileExists(
      atPath: bundledRuntime.appendingPathComponent("package.json").path
    ) {
      return bundledRuntime
    }
    return Bundle.main.bundleURL
      .deletingLastPathComponent() // build
      .deletingLastPathComponent() // project root, for developer builds
  }

  // Vite on current macOS commonly binds to the IPv6 localhost interface.
  // `localhost` correctly resolves to it; hard-coding 127.0.0.1 produced a
  // black native window while the bridge itself appeared healthy.
  static let faceURL = URL(string: "http://localhost:5173")!
  static let faceHealthURL = URL(string: "http://localhost:5173")!
  static let bridgeURL = URL(string: "http://127.0.0.1:8787/health")!
  static let ollamaURL = URL(string: "http://127.0.0.1:11434/api/tags")!

  static var ollamaExecutable: URL? {
    ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"]
      .map { URL(fileURLWithPath: $0) }
      .first { FileManager.default.isExecutableFile(atPath: $0.path) }
  }

  static var nodeExecutable: URL? {
    ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
      .map { URL(fileURLWithPath: $0) }
      .first { FileManager.default.isExecutableFile(atPath: $0.path) }
  }

  /// Keys used by the installed application live outside both the repository
  /// and the app bundle. This prevents an API key from being accidentally
  /// copied into a DMG, Git commit, or shared project folder.
  static var privateEnvironment: [String: String] {
    let file = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/JARVIS/.env.local")
    guard let source = try? String(contentsOf: file, encoding: .utf8) else {
      return [:]
    }
    let permitted = Set([
      "JARVIS_BRAIN",
      "JARVIS_NVIDIA_API_KEY",
      "JARVIS_NVIDIA_URL",
    ])
    return source.split(whereSeparator: \.isNewline).reduce(into: [:]) { values, line in
      let text = String(line).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.hasPrefix("#"), let separator = text.firstIndex(of: "=") else { return }
      let key = String(text[..<separator]).trimmingCharacters(in: .whitespaces)
      let value = String(text[text.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
      guard permitted.contains(key), !value.isEmpty else { return }
      values[key] = value
    }
  }
}

@MainActor
final class RuntimeController: ObservableObject {
  static let shared = RuntimeController()

  @Published private(set) var status = "Starting local services…"
  private var process: Process?
  private var faceProcess: Process?
  private var ollamaProcess: Process?
  private var timer: Timer?
  private var restartWorkItem: DispatchWorkItem?
  private var stopping = false

  func start() {
    stopping = false
    Task {
      let bridgeReady = await bridgeIsHealthy()
      let ollamaReady = await ollamaIsHealthy()
      let faceReady = await faceIsHealthy()
      if !ollamaReady { launchOllama() }
      // The face is a separate localhost server. A bridge from an earlier app
      // run may be perfectly healthy while Vite is absent; treating that as a
      // complete launch produced a black native window with “brain online”.
      if !bridgeReady { launchServices() }
      else if !faceReady { launchFace() }
      if bridgeReady && ollamaReady && faceReady { status = "Local brain online" }
      beginHealthChecks()
    }
  }

  /// The packaged app owns the services it starts. Releasing them when the
  /// app exits prevents an orphaned Vite process from blocking the next launch
  /// and leaving JARVIS with an apparently live but unresponsive face.
  func stop() {
    stopping = true
    restartWorkItem?.cancel()
    restartWorkItem = nil
    timer?.invalidate()
    timer = nil
    for child in [process, faceProcess, ollamaProcess] {
      guard let child, child.isRunning else { continue }
      child.terminate()
    }
    process = nil
    faceProcess = nil
    ollamaProcess = nil
  }

  private func launchOllama() {
    guard ollamaProcess == nil else { return }
    guard let executable = JarvisRuntime.ollamaExecutable else {
      status = "Ollama is not installed"
      return
    }

    let child = Process()
    child.executableURL = executable
    child.arguments = ["serve"]
    child.standardOutput = Pipe()
    child.standardError = Pipe()
    child.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async { self?.ollamaProcess = nil }
    }
    do {
      try child.run()
      ollamaProcess = child
    } catch {
      status = "Could not start Ollama: \(error.localizedDescription)"
    }
  }

  private func launchServices() {
    guard process == nil else { return }
    let package = JarvisRuntime.projectRoot.appendingPathComponent("package.json")
    guard FileManager.default.fileExists(atPath: package.path) else {
      status = "JARVIS project files were not found"
      return
    }
    guard let node = JarvisRuntime.nodeExecutable else {
      status = "Node.js is not installed"
      return
    }

    let child = Process()
    child.executableURL = node
    child.arguments = ["scripts/start.mjs"]
    child.currentDirectoryURL = JarvisRuntime.projectRoot
    var environment = ProcessInfo.processInfo.environment
    environment.merge(JarvisRuntime.privateEnvironment) { _, privateValue in privateValue }
    environment.merge([
      "PORT": "5173",
      "JARVIS_FACE_PORT": "5173",
      // This is a packaged, local-only desktop assistant. Individual services
      // still prompt through macOS before Calendar, Reminders, or Mail can be
      // touched; the bridge additionally accepts only its tiny fixed command
      // grammar, never spoken shell code.
      "JARVIS_ALLOW_MACOS_ACTIONS": "1",
    ]) { _, new in new }
    child.environment = environment
    child.standardOutput = Pipe()
    child.standardError = Pipe()
    child.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.process = nil
        self?.status = "Local services stopped"
        self?.scheduleRecovery()
      }
    }

    do {
      try child.run()
      process = child
      status = "Starting local services…"
    } catch {
      status = "Could not start JARVIS: \(error.localizedDescription)"
    }
  }

  private func launchFace() {
    guard faceProcess == nil else { return }
    let vite = JarvisRuntime.projectRoot.appendingPathComponent("node_modules/vite/bin/vite.js")
    guard FileManager.default.fileExists(atPath: vite.path), let node = JarvisRuntime.nodeExecutable else {
      status = "JARVIS interface files were not found"
      return
    }
    let child = Process()
    child.executableURL = node
    child.arguments = [vite.path, "--host", "localhost", "--port", "5173", "--strictPort"]
    child.currentDirectoryURL = JarvisRuntime.projectRoot
    child.standardOutput = Pipe()
    child.standardError = Pipe()
    child.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.faceProcess = nil
        self?.status = "Visual interface stopped — retrying"
        self?.scheduleRecovery()
      }
    }
    do {
      try child.run()
      faceProcess = child
      status = "Starting visual interface…"
    } catch {
      status = "Could not start JARVIS interface: \(error.localizedDescription)"
    }
  }

  private func beginHealthChecks() {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self else { return }
        let bridgeReady = await self.bridgeIsHealthy()
        let faceReady = await self.faceIsHealthy()
        self.status = bridgeReady && faceReady ? "Local brain online" : "Restoring local services…"
        if !bridgeReady || !faceReady { self.scheduleRecovery() }
      }
    }
  }

  /** A local dev server can exit while Vite refreshes or while a previous app
   * run releases its port. Leaving the native WebView black in that state is
   * worse than a short retry: all services are loopback-only and safe to start
   * again. One coalesced retry prevents an exit storm from spawning copies. */
  private func scheduleRecovery() {
    guard !stopping, restartWorkItem == nil else { return }
    let work = DispatchWorkItem { [weak self] in
      guard let self, !self.stopping else { return }
      self.restartWorkItem = nil
      Task { @MainActor in
        let bridgeReady = await self.bridgeIsHealthy()
        let faceReady = await self.faceIsHealthy()
        if !bridgeReady { self.launchServices() }
        else if !faceReady { self.launchFace() }
      }
    }
    restartWorkItem = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
  }

  private func bridgeIsHealthy() async -> Bool {
    await healthy(JarvisRuntime.bridgeURL)
  }

  private func faceIsHealthy() async -> Bool {
    await healthy(JarvisRuntime.faceHealthURL)
  }

  private func ollamaIsHealthy() async -> Bool {
    await healthy(JarvisRuntime.ollamaURL)
  }

  private func localBrainIsHealthy() async -> Bool {
    let bridgeReady = await bridgeIsHealthy()
    let ollamaReady = await ollamaIsHealthy()
    return bridgeReady && ollamaReady
  }

  private func healthy(_ url: URL) async -> Bool {
    var request = URLRequest(url: url)
    request.timeoutInterval = 1.5
    do {
      let (_, response) = try await URLSession.shared.data(for: request)
      return (response as? HTTPURLResponse)?.statusCode == 200
    } catch {
      return false
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    RuntimeController.shared.start()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationWillTerminate(_ notification: Notification) {
    RuntimeController.shared.stop()
  }
}

struct JarvisWebView: NSViewRepresentable {
  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.mediaTypesRequiringUserActionForPlayback = []
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.uiDelegate = context.coordinator
    view.setValue(false, forKey: "drawsBackground")
    view.load(URLRequest(url: JarvisRuntime.faceURL))
    return view
  }

  func updateNSView(_ view: WKWebView, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    private var retrying = false

    private func retry(_ webView: WKWebView) {
      guard !retrying else { return }
      retrying = true
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak webView] in
        self?.retrying = false
        webView?.load(URLRequest(url: JarvisRuntime.faceURL))
      }
    }

    func webView(
      _ webView: WKWebView,
      decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
      // The native shell displays only its own loopback interface. Links that
      // lead elsewhere are never silently opened in an authenticated browser.
      let url = navigationAction.request.url
      if url?.host == "127.0.0.1" || url?.host == "localhost" {
        decisionHandler(.allow)
      } else {
        decisionHandler(.cancel)
      }
    }

    func webView(
      _ webView: WKWebView,
      didFailProvisionalNavigation navigation: WKNavigation?,
      withError error: Error
    ) {
      // The native app may open a moment before Vite is ready. Retrying keeps
      // the first launch smooth instead of leaving the user at a dead canvas.
      retry(webView)
    }

    func webView(
      _ webView: WKWebView,
      didFail navigation: WKNavigation?,
      withError error: Error
    ) {
      retry(webView)
    }

    @available(macOS 12.0, *)
    func webView(
      _ webView: WKWebView,
      requestMediaCapturePermissionFor origin: WKSecurityOrigin,
      initiatedByFrame frame: WKFrameInfo,
      type: WKMediaCaptureType,
      decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
      // Only the JARVIS loopback face can make this request. The browser still
      // presents the normal macOS privacy prompt; this merely forwards the
      // request instead of WebKit rejecting it before macOS sees it.
      guard origin.protocol == "http",
            origin.host == "localhost" || origin.host == "127.0.0.1" else {
        decisionHandler(.deny)
        return
      }
      decisionHandler(.grant)
    }
  }
}

struct ContentView: View {
  @ObservedObject private var runtime = RuntimeController.shared

  var body: some View {
    ZStack(alignment: .bottomLeading) {
      JarvisWebView()
      Text(runtime.status)
        .font(.system(size: 11, weight: .medium, design: .monospaced))
        .foregroundStyle(.cyan.opacity(0.8))
        .padding(10)
        .background(.black.opacity(0.5), in: Capsule())
        .padding(18)
        .accessibilityLabel("JARVIS status: \(runtime.status)")
    }
    .frame(minWidth: 980, minHeight: 640)
    .background(.black)
  }
}

@main
struct JarvisMacApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @ObservedObject private var runtime = RuntimeController.shared

  var body: some Scene {
    WindowGroup("JARVIS") {
      ContentView()
    }
    .windowStyle(.hiddenTitleBar)
    .defaultSize(width: 1280, height: 800)

    MenuBarExtra("JARVIS", systemImage: "circle.hexagongrid.fill") {
      Text(runtime.status)
      Divider()
      Button("Open JARVIS") {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first?.makeKeyAndOrderFront(nil)
      }
      Button("Start local services") {
        runtime.start()
      }
      Button("Open Microphone Privacy Settings") {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") else { return }
        NSWorkspace.shared.open(url)
      }
      Divider()
      Button("Quit JARVIS") {
        NSApp.terminate(nil)
      }
    }
  }
}
