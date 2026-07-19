import SwiftUI
import Foundation
import CryptoKit
import CoreML
import UIKit

struct ModelManifest: Codable, Hashable, Sendable {
    enum Backend: String, Codable, Sendable { case coreML = "coreml"; case mlx = "mlx"; case gguf = "gguf" }
    enum Tokenizer: String, Codable, Sendable { case byteV1 = "byte-v1" }

    let schema: String
    let modelID: String
    let revisionSHA256: String
    let artifactSHA256: String
    let artifactBytes: Int64
    let runtimeABI: String
    let backend: Backend
    let tokenizer: Tokenizer
    let quantizationDesignID: String
    let inputIDsName: String
    let logitsName: String
    let maximumContextTokens: Int
    let evidencePackageDigest: String
    let measurementAuthorityID: String

    func validate() throws {
        guard schema == "archie-phone-model-manifest/v1" else { throw RuntimeFailure.invalidManifest("schema") }
        for (name, value) in [("revisionSHA256", revisionSHA256), ("artifactSHA256", artifactSHA256), ("evidencePackageDigest", evidencePackageDigest)] where !Self.isSHA256(value) {
            throw RuntimeFailure.invalidManifest(name)
        }
        guard artifactBytes > 0, maximumContextTokens >= 512 else { throw RuntimeFailure.invalidManifest("resource bounds") }
        guard runtimeABI == "archie-phone-runtime/v1" else { throw RuntimeFailure.invalidManifest("runtime ABI") }
        guard !measurementAuthorityID.isEmpty else { throw RuntimeFailure.invalidManifest("measurement authority") }
    }

    static func isSHA256(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
}

enum RuntimeFailure: Error, LocalizedError, Equatable {
    case noAdmittedModel
    case invalidManifest(String)
    case artifactDigestMismatch
    case artifactSizeMismatch
    case incompatibleModel(String)
    case thermalCritical
    case cancelled

    var errorDescription: String? {
        switch self {
        case .noAdmittedModel: return "Archie needs a local mind before this can run."
        case .invalidManifest: return "The installed mind could not be verified."
        case .artifactDigestMismatch, .artifactSizeMismatch: return "The installed mind changed unexpectedly."
        case .incompatibleModel: return "This mind does not fit this phone runtime."
        case .thermalCritical: return "Archie paused while the phone cools down."
        case .cancelled: return "Stopped."
        }
    }
}

actor ModelStore {
    private struct ActivePointer: Codable { let revisionSHA256: String }
    private let versions: URL
    private let pointer: URL
    private let decoder = JSONDecoder()

    init(fileManager: FileManager = .default) throws {
        let base = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let root = base.appendingPathComponent("ArchieModels", isDirectory: true)
        versions = root.appendingPathComponent("versions", isDirectory: true)
        pointer = root.appendingPathComponent("active.json")
        try fileManager.createDirectory(at: versions, withIntermediateDirectories: true)
        try fileManager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
    }

    func activeModel() throws -> (ModelManifest, URL)? {
        guard FileManager.default.fileExists(atPath: pointer.path) else { return nil }
        let active = try decoder.decode(ActivePointer.self, from: Data(contentsOf: pointer))
        let directory = versions.appendingPathComponent(active.revisionSHA256, isDirectory: true)
        let manifest = try decoder.decode(ModelManifest.self, from: Data(contentsOf: directory.appendingPathComponent("manifest.json")))
        let artifact = directory.appendingPathComponent("model")
        try manifest.validate()
        guard manifest.revisionSHA256 == active.revisionSHA256 else { throw RuntimeFailure.invalidManifest("active revision") }
        let values = try artifact.resourceValues(forKeys: [.fileSizeKey])
        guard Int64(values.fileSize ?? -1) == manifest.artifactBytes else { throw RuntimeFailure.artifactSizeMismatch }
        let data = try Data(contentsOf: artifact, options: [.mappedIfSafe])
        let observed = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard observed == manifest.artifactSHA256 else { throw RuntimeFailure.artifactDigestMismatch }
        return (manifest, artifact)
    }
}

protocol PhoneInferenceBackend: Sendable {
    func generate(prompt: String, maximumNewTokens: Int) -> AsyncThrowingStream<String, Error>
    func unload() async
}

actor CoreMLAutoregressiveBackend: PhoneInferenceBackend {
    private var model: MLModel?
    private let manifest: ModelManifest

    init(modelURL: URL, manifest: ModelManifest) throws {
        guard manifest.backend == .coreML, manifest.tokenizer == .byteV1 else { throw RuntimeFailure.incompatibleModel("backend") }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        model = try MLModel(contentsOf: modelURL, configuration: configuration)
        self.manifest = manifest
    }

    nonisolated func generate(prompt: String, maximumNewTokens: Int) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for chunk in try await self.generateTokens(prompt: prompt, maximumNewTokens: maximumNewTokens) {
                        try Task.checkCancellation()
                        continuation.yield(chunk)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: RuntimeFailure.cancelled)
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func generateTokens(prompt: String, maximumNewTokens: Int) throws -> [String] {
        guard let model else { throw RuntimeFailure.noAdmittedModel }
        var tokens = Array(prompt.utf8).map(Int.init)
        guard tokens.count < manifest.maximumContextTokens else { throw RuntimeFailure.incompatibleModel("context") }
        var output: [String] = []
        for _ in 0..<max(1, maximumNewTokens) {
            if Task.isCancelled { throw RuntimeFailure.cancelled }
            let array = try MLMultiArray(shape: [1, NSNumber(value: tokens.count)], dataType: .int32)
            for (index, token) in tokens.enumerated() { array[index] = NSNumber(value: token) }
            let provider = try MLDictionaryFeatureProvider(dictionary: [manifest.inputIDsName: array])
            let prediction = try model.prediction(from: provider)
            guard let logits = prediction.featureValue(for: manifest.logitsName)?.multiArrayValue, logits.count >= 256 else { throw RuntimeFailure.incompatibleModel("logits") }
            let offset = logits.count - 256
            var best = 0
            var bestValue = -Double.infinity
            for token in 0..<256 {
                let value = logits[offset + token].doubleValue
                if value > bestValue { best = token; bestValue = value }
            }
            tokens.append(best)
            if best == 0 { break }
            output.append(String(decoding: [UInt8(best)], as: UTF8.self))
            if tokens.count >= manifest.maximumContextTokens { break }
        }
        return output
    }

    func unload() async { model = nil }
}

enum PresenceMode: String, CaseIterable, Identifiable {
    case quiet = "Quiet"
    case companion = "Companion"
    case operatorMode = "Operator"
    case focus = "Focus"
    case world = "World"

    var id: String { rawValue }
    var icon: String {
        switch self {
        case .quiet: return "circle.dotted"
        case .companion: return "waveform"
        case .operatorMode: return "bolt.fill"
        case .focus: return "scope"
        case .world: return "globe.americas.fill"
        }
    }
    var instruction: String {
        switch self {
        case .quiet: return "Observe the supplied state. Respond only when action is required."
        case .companion: return "Act as a concise, continuous local presence. Speak naturally when useful."
        case .operatorMode: return "Convert the goal into concrete actions and return the completed result or the next required permission."
        case .focus: return "Maintain the active objective, suppress distraction, and surface only the next useful move."
        case .world: return "Map the subject into objects, relations, evidence, uncertainty, and useful paths to explore."
        }
    }
}

struct ActivityRecord: Identifiable, Hashable {
    let id = UUID()
    let mode: PresenceMode
    let input: String
    var output: String
    let createdAt = Date()
}

@MainActor
final class PresenceRuntime: ObservableObject {
    enum State: Equatable { case resting, loading, active, paused(String), failed(String) }

    @Published var mode: PresenceMode = .companion
    @Published var input = ""
    @Published private(set) var state: State = .resting
    @Published private(set) var currentOutput = ""
    @Published private(set) var history: [ActivityRecord] = []
    @Published private(set) var lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
    @Published private(set) var thermalState = ProcessInfo.processInfo.thermalState

    private let store: ModelStore
    private var backend: (any PhoneInferenceBackend)?
    private var task: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []

    init() {
        do { store = try ModelStore() }
        catch { fatalError("Local model storage failed: \(error)") }
        observePhone()
    }

    func act() {
        let goal = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !goal.isEmpty else { return }
        stop()
        currentOutput = ""
        let activeMode = mode
        task = Task {
            do {
                try guardPhone()
                state = .loading
                guard let (manifest, url) = try await store.activeModel() else { throw RuntimeFailure.noAdmittedModel }
                guard manifest.backend == .coreML else { throw RuntimeFailure.incompatibleModel("backend") }
                backend = try CoreMLAutoregressiveBackend(modelURL: url, manifest: manifest)
                state = .active
                let envelope = """
                [ARCHIE PRESENCE]\nmode=\(activeMode.rawValue)\nrule=\(activeMode.instruction)\nstate=local_private_phone\nobjective=\(goal)\nReturn the most useful continuation. Do not imitate a chat transcript.\n[OUTPUT]\n
                """
                guard let backend else { throw RuntimeFailure.noAdmittedModel }
                for try await token in backend.generate(prompt: envelope, maximumNewTokens: lowPowerMode ? 96 : 256) {
                    try guardPhone()
                    currentOutput += token
                }
                history.insert(ActivityRecord(mode: activeMode, input: goal, output: currentOutput), at: 0)
                input = ""
                state = .resting
            } catch {
                state = .failed(error.localizedDescription)
                await unload()
            }
        }
    }

    func continueLast() {
        guard let last = history.first else { return }
        mode = last.mode
        input = "Continue this unfinished objective from its current state:\n\(last.input)\nCurrent result:\n\(last.output)"
        act()
    }

    func stop() {
        task?.cancel()
        task = nil
        if state == .active || state == .loading { state = .resting }
    }

    func unload() async {
        await backend?.unload()
        backend = nil
    }

    private func guardPhone() throws {
        if thermalState == .critical { throw RuntimeFailure.thermalCritical }
    }

    private func observePhone() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.thermalState = ProcessInfo.processInfo.thermalState
                if self.thermalState == .critical {
                    self.stop()
                    self.state = .paused("Cooling down")
                    await self.unload()
                }
            }
        })
        observers.append(center.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled }
        })
        observers.append(center.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.stop()
                self.state = .paused("Memory released")
                await self.unload()
            }
        })
    }
}

@main
struct ArchiePresenceApp: App {
    @StateObject private var runtime = PresenceRuntime()
    var body: some Scene { WindowGroup { PresenceRootView().environmentObject(runtime) } }
}

struct PresenceRootView: View {
    @EnvironmentObject private var runtime: PresenceRuntime

    var body: some View {
        TabView {
            PresenceHome().tabItem { Label("Now", systemImage: "sparkles") }
            WorldView().tabItem { Label("World", systemImage: "circle.hexagongrid.fill") }
            ActivityView().tabItem { Label("Runs", systemImage: "clock.arrow.circlepath") }
            LocalView().tabItem { Label("Local", systemImage: "iphone") }
        }
        .tint(.primary)
    }
}

struct PresenceHome: View {
    @EnvironmentObject private var runtime: PresenceRuntime

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    modeStrip
                    outputCard
                    objectiveComposer
                    if !runtime.history.isEmpty {
                        Button("Keep going from the last result") { runtime.continueLast() }
                            .buttonStyle(.bordered)
                    }
                }
                .padding()
            }
            .navigationTitle("Archie")
            .safeAreaInset(edge: .bottom) { statusBar }
        }
    }

    private var modeStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(PresenceMode.allCases) { mode in
                    Button {
                        runtime.mode = mode
                    } label: {
                        Label(mode.rawValue, systemImage: mode.icon)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(runtime.mode == mode ? Color.primary : Color.secondary.opacity(0.12))
                            .foregroundStyle(runtime.mode == mode ? Color(uiColor: .systemBackground) : .primary)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var outputCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(runtime.mode.rawValue, systemImage: runtime.mode.icon).font(.headline)
                Spacer()
                if runtime.state == .active { ProgressView() }
            }
            Text(runtime.currentOutput.isEmpty ? emptyMessage : runtime.currentOutput)
                .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
                .textSelection(.enabled)
        }
        .padding(18)
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private var objectiveComposer: some View {
        VStack(spacing: 12) {
            TextField(promptLabel, text: $runtime.input, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(2...8)
                .padding(16)
                .background(Color.secondary.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            HStack {
                Button { runtime.act() } label: {
                    Label("Go", systemImage: "arrow.up.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(runtime.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if runtime.state == .active || runtime.state == .loading {
                    Button("Stop") { runtime.stop() }.buttonStyle(.bordered).controlSize(.large)
                }
            }
        }
    }

    private var statusBar: some View {
        HStack {
            Circle().frame(width: 8, height: 8).foregroundStyle(statusColor)
            Text(statusText).font(.footnote)
            Spacer()
            Image(systemName: runtime.lowPowerMode ? "battery.25" : "battery.100")
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
    }

    private var emptyMessage: String {
        switch runtime.mode {
        case .quiet: return "Nothing needs your attention."
        case .companion: return "Say something, or leave Archie quiet."
        case .operatorMode: return "Give Archie an outcome to complete."
        case .focus: return "Name the one thing that matters now."
        case .world: return "Open a subject and map what it connects to."
        }
    }

    private var promptLabel: String {
        switch runtime.mode {
        case .quiet: return "What should Archie watch?"
        case .companion: return "Speak or type"
        case .operatorMode: return "What should be done?"
        case .focus: return "What are we finishing?"
        case .world: return "What should we understand?"
        }
    }

    private var statusText: String {
        switch runtime.state {
        case .resting: return "On device"
        case .loading: return "Waking local mind"
        case .active: return "Working locally"
        case .paused(let reason): return reason
        case .failed(let reason): return reason
        }
    }

    private var statusColor: Color {
        switch runtime.state {
        case .failed: return .red
        case .paused: return .orange
        case .active, .loading: return .green
        case .resting: return .secondary
        }
    }
}

struct WorldView: View {
    private let domains = ["Physics", "Life", "Language", "Code", "Earth", "Systems"]
    var body: some View {
        NavigationStack {
            List(domains, id: \.self) { domain in
                NavigationLink(domain) {
                    ContentUnavailableView("Sidepus object space", systemImage: "point.3.connected.trianglepath.dotted", description: Text("This surface will open local objects, relations, sources, and transformations without reducing them to chat."))
                }
            }
            .navigationTitle("World")
        }
    }
}

struct ActivityView: View {
    @EnvironmentObject private var runtime: PresenceRuntime
    var body: some View {
        NavigationStack {
            List(runtime.history) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Label(item.mode.rawValue, systemImage: item.mode.icon).font(.caption).foregroundStyle(.secondary)
                    Text(item.input).font(.headline).lineLimit(2)
                    Text(item.output).lineLimit(3).foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }
            .overlay {
                if runtime.history.isEmpty {
                    ContentUnavailableView("No runs yet", systemImage: "clock", description: Text("Completed local work appears here."))
                }
            }
            .navigationTitle("Runs")
        }
    }
}

struct LocalView: View {
    @EnvironmentObject private var runtime: PresenceRuntime
    var body: some View {
        NavigationStack {
            Form {
                Section("Phone") {
                    LabeledContent("Execution", value: "Local")
                    LabeledContent("Low Power Mode", value: runtime.lowPowerMode ? "On" : "Off")
                    LabeledContent("Thermal state", value: String(describing: runtime.thermalState))
                }
                Section("Behavior") {
                    Text("Archie is not required to act like an assistant. Presence mode changes how the same local model is framed and used.")
                }
                Section {
                    Button("Release model memory") { Task { await runtime.unload() } }
                }
            }
            .navigationTitle("Local")
        }
    }
}
