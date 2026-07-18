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
        case .noAdmittedModel: return "No admitted local model is installed."
        case .invalidManifest(let field): return "The model manifest is invalid: \(field)."
        case .artifactDigestMismatch: return "The model artifact digest does not match its manifest."
        case .artifactSizeMismatch: return "The model artifact size does not match its manifest."
        case .incompatibleModel(let detail): return "The model is incompatible with this runtime: \(detail)."
        case .thermalCritical: return "Archie paused because the iPhone needs to cool down."
        case .cancelled: return "Generation was cancelled."
        }
    }
}

actor ModelStore {
    private struct ActivePointer: Codable { let revisionSHA256: String }
    private let root: URL
    private let versions: URL
    private let pointer: URL
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(fileManager: FileManager = .default) throws {
        let base = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        root = base.appendingPathComponent("ArchieModels", isDirectory: true)
        versions = root.appendingPathComponent("versions", isDirectory: true)
        pointer = root.appendingPathComponent("active.json")
        try fileManager.createDirectory(at: versions, withIntermediateDirectories: true)
        try fileManager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
        encoder.outputFormatting = [.sortedKeys]
    }

    func activeModel() throws -> (ModelManifest, URL)? {
        guard FileManager.default.fileExists(atPath: pointer.path) else { return nil }
        let active = try decoder.decode(ActivePointer.self, from: Data(contentsOf: pointer))
        let directory = versions.appendingPathComponent(active.revisionSHA256, isDirectory: true)
        let manifestURL = directory.appendingPathComponent("manifest.json")
        let artifactURL = directory.appendingPathComponent("model")
        let manifest = try decoder.decode(ModelManifest.self, from: Data(contentsOf: manifestURL))
        try manifest.validate()
        guard manifest.revisionSHA256 == active.revisionSHA256 else { throw RuntimeFailure.invalidManifest("active revision") }
        try verifyArtifact(at: artifactURL, manifest: manifest)
        return (manifest, artifactURL)
    }

    func activate(manifestData: Data, artifact source: URL) throws {
        let manifest = try decoder.decode(ModelManifest.self, from: manifestData)
        try manifest.validate()
        try verifyArtifact(at: source, manifest: manifest)
        let destination = versions.appendingPathComponent(manifest.revisionSHA256, isDirectory: true)
        let staging = versions.appendingPathComponent("staging-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        try FileManager.default.copyItem(at: source, to: staging.appendingPathComponent("model"))
        try manifestData.write(to: staging.appendingPathComponent("manifest.json"), options: .atomic)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: staging.path)
        if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
        try FileManager.default.moveItem(at: staging, to: destination)
        let pointerData = try encoder.encode(ActivePointer(revisionSHA256: manifest.revisionSHA256))
        try pointerData.write(to: pointer, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func removeActiveModel() throws {
        if FileManager.default.fileExists(atPath: pointer.path) { try FileManager.default.removeItem(at: pointer) }
    }

    private func verifyArtifact(at url: URL, manifest: ModelManifest) throws {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        guard Int64(values.fileSize ?? -1) == manifest.artifactBytes else { throw RuntimeFailure.artifactSizeMismatch }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        let observed = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard observed == manifest.artifactSHA256 else { throw RuntimeFailure.artifactDigestMismatch }
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
        guard manifest.backend == .coreML else { throw RuntimeFailure.incompatibleModel("backend is not Core ML") }
        guard manifest.tokenizer == .byteV1 else { throw RuntimeFailure.incompatibleModel("only byte-v1 tokenizer is implemented") }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        model = try MLModel(contentsOf: modelURL, configuration: configuration)
        self.manifest = manifest
    }

    nonisolated func generate(prompt: String, maximumNewTokens: Int) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let chunks = try await self.generateTokens(prompt: prompt, maximumNewTokens: maximumNewTokens)
                    for chunk in chunks { try Task.checkCancellation(); continuation.yield(chunk) }
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
        guard tokens.count < manifest.maximumContextTokens else { throw RuntimeFailure.incompatibleModel("prompt exceeds admitted context") }
        var output: [String] = []
        for _ in 0..<max(1, maximumNewTokens) {
            if Task.isCancelled { throw RuntimeFailure.cancelled }
            let array = try MLMultiArray(shape: [1, NSNumber(value: tokens.count)], dataType: .int32)
            for (index, token) in tokens.enumerated() { array[index] = NSNumber(value: token) }
            let provider = try MLDictionaryFeatureProvider(dictionary: [manifest.inputIDsName: array])
            let prediction = try model.prediction(from: provider)
            guard let logits = prediction.featureValue(for: manifest.logitsName)?.multiArrayValue, logits.count >= 256 else { throw RuntimeFailure.incompatibleModel("missing byte logits") }
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

@MainActor
final class RuntimeCoordinator: ObservableObject {
    enum State: Equatable { case idle, loading, generating, paused(String), failed(String) }
    @Published private(set) var state: State = .idle
    @Published private(set) var transcript = ""
    @Published private(set) var thermalState = ProcessInfo.processInfo.thermalState
    @Published private(set) var lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled

    private let store: ModelStore
    private var backend: (any PhoneInferenceBackend)?
    private var generationTask: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []

    init() {
        do { store = try ModelStore() }
        catch { fatalError("Archie model store could not initialize: \(error)") }
        observeSystemState()
    }

    func start(prompt: String) {
        cancel()
        transcript = ""
        generationTask = Task {
            do {
                try guardSystemState()
                state = .loading
                guard let (manifest, url) = try await store.activeModel() else { throw RuntimeFailure.noAdmittedModel }
                switch manifest.backend {
                case .coreML: backend = try CoreMLAutoregressiveBackend(modelURL: url, manifest: manifest)
                case .mlx: throw RuntimeFailure.incompatibleModel("MLX backend is not admitted in this build")
                case .gguf: throw RuntimeFailure.incompatibleModel("GGUF backend is not admitted in this build")
                }
                state = .generating
                guard let backend else { throw RuntimeFailure.noAdmittedModel }
                for try await token in backend.generate(prompt: prompt, maximumNewTokens: lowPowerMode ? 64 : 192) {
                    try guardSystemState()
                    transcript += token
                }
                state = .idle
            } catch {
                state = .failed(error.localizedDescription)
                await unload()
            }
        }
    }

    func cancel() {
        generationTask?.cancel()
        generationTask = nil
        if state == .generating { state = .idle }
    }

    func unload() async {
        await backend?.unload()
        backend = nil
    }

    private func guardSystemState() throws {
        if thermalState == .critical { throw RuntimeFailure.thermalCritical }
    }

    private func observeSystemState() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.thermalState = ProcessInfo.processInfo.thermalState
                if self.thermalState == .critical {
                    self.cancel()
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
                self.cancel()
                self.state = .paused("Memory released")
                await self.unload()
            }
        })
    }
}

@main
struct ArchiePhoneApp: App {
    @StateObject private var runtime = RuntimeCoordinator()
    var body: some Scene { WindowGroup { ContentView().environmentObject(runtime) } }
}

struct ContentView: View {
    @EnvironmentObject private var runtime: RuntimeCoordinator
    @State private var prompt = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                ScrollView {
                    Text(runtime.transcript.isEmpty ? "Archie is local and quiet until an admitted model is installed." : runtime.transcript)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                TextField("Ask Archie", text: $prompt, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...8)
                HStack {
                    Button("Run locally") { runtime.start(prompt: prompt) }
                        .buttonStyle(.borderedProminent)
                        .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Stop") { runtime.cancel() }.buttonStyle(.bordered)
                }
                Text(statusText).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding()
            .navigationTitle("Archie")
        }
    }

    private var statusText: String {
        switch runtime.state {
        case .idle: return "Local runtime idle · Low Power Mode \(runtime.lowPowerMode ? "on" : "off")"
        case .loading: return "Verifying and loading the admitted model"
        case .generating: return "Generating locally"
        case .paused(let reason): return reason
        case .failed(let reason): return reason
        }
    }
}
