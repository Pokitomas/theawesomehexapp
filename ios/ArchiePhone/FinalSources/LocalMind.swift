import Foundation
import CryptoKit
import CoreML

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
        for value in [revisionSHA256, artifactSHA256, evidencePackageDigest] where !Self.isSHA256(value) {
            throw RuntimeFailure.invalidManifest("digest")
        }
        guard artifactBytes > 0, maximumContextTokens >= 512, runtimeABI == "archie-phone-runtime/v1" else {
            throw RuntimeFailure.invalidManifest("bounds")
        }
        guard !measurementAuthorityID.isEmpty else { throw RuntimeFailure.invalidManifest("authority") }
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
        case .incompatibleModel: return "This mind does not fit the phone runtime."
        case .thermalCritical: return "Archie paused while the phone cools down."
        case .cancelled: return "Stopped."
        }
    }
}

actor ModelStore {
    private struct ActivePointer: Codable { let revisionSHA256: String }
    private let versions: URL
    private let pointer: URL

    init(fileManager: FileManager = .default) throws {
        let base = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let root = base.appendingPathComponent("ArchieModels", isDirectory: true)
        versions = root.appendingPathComponent("versions", isDirectory: true)
        pointer = root.appendingPathComponent("active.json")
        try fileManager.createDirectory(at: versions, withIntermediateDirectories: true)
        try? fileManager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
    }

    func activeModel() throws -> (ModelManifest, URL)? {
        guard FileManager.default.fileExists(atPath: pointer.path) else { return nil }
        let active = try JSONDecoder().decode(ActivePointer.self, from: Data(contentsOf: pointer))
        let directory = versions.appendingPathComponent(active.revisionSHA256, isDirectory: true)
        let manifest = try JSONDecoder().decode(ModelManifest.self, from: Data(contentsOf: directory.appendingPathComponent("manifest.json")))
        let artifact = directory.appendingPathComponent("model")
        try manifest.validate()
        guard manifest.revisionSHA256 == active.revisionSHA256 else { throw RuntimeFailure.invalidManifest("active revision") }
        let size = try artifact.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? -1
        guard Int64(size) == manifest.artifactBytes else { throw RuntimeFailure.artifactSizeMismatch }
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
            guard let logits = prediction.featureValue(for: manifest.logitsName)?.multiArrayValue, logits.count >= 256 else {
                throw RuntimeFailure.incompatibleModel("logits")
            }
            let offset = logits.count - 256
            var bestToken = 0
            var bestValue = -Double.infinity
            for token in 0..<256 {
                let value = logits[offset + token].doubleValue
                if value > bestValue { bestToken = token; bestValue = value }
            }
            tokens.append(bestToken)
            if bestToken == 0 { break }
            output.append(String(decoding: [UInt8(bestToken)], as: UTF8.self))
            if tokens.count >= manifest.maximumContextTokens { break }
        }
        return output
    }

    func unload() async { model = nil }
}
