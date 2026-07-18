import Foundation
import CryptoKit
import UIKit

enum ModelLifecycleFailure: Error, LocalizedError, Equatable, Sendable {
    case invalidDetachedSignature
    case credentialBearingURL
    case insufficientStorage(requiredBytes: Int64, availableBytes: Int64)
    case invalidHTTPStatus(Int)
    case invalidContentRange
    case partialArtifactTooLarge
    case revisionNotInstalled(String)
    case rollbackUnavailable
    case noRecoverableRevision
    case corruptedRevision(String)

    var errorDescription: String? {
        switch self {
        case .invalidDetachedSignature:
            return "The model manifest signature is invalid."
        case .credentialBearingURL:
            return "Credential-bearing model URLs are refused."
        case .insufficientStorage(let required, let available):
            return "The model needs \(required) bytes of free storage; \(available) bytes are available."
        case .invalidHTTPStatus(let status):
            return "The model download returned HTTP \(status)."
        case .invalidContentRange:
            return "The resumed model download returned an invalid content range."
        case .partialArtifactTooLarge:
            return "The partial model artifact is larger than the admitted artifact."
        case .revisionNotInstalled(let revision):
            return "Model revision \(revision) is not installed."
        case .rollbackUnavailable:
            return "No verified previous model revision is available."
        case .noRecoverableRevision:
            return "No verified model revision can be recovered."
        case .corruptedRevision(let revision):
            return "Model revision \(revision) is corrupted."
        }
    }
}

struct ModelLifecycleReceipt: Codable, Hashable, Sendable {
    let schema: String
    let operation: String
    let revisionSHA256: String
    let previousRevisionSHA256: String?
    let artifactSHA256: String
    let artifactBytes: Int64
    let manifestSHA256: String
    let runtimeABI: String
    let evidencePackageDigest: String
    let measurementAuthorityID: String
    let source: String
    let occurredAt: String
    let receiptDigest: String
}

struct ModelLifecycleDiagnostic: Codable, Hashable, Sendable {
    struct Revision: Codable, Hashable, Sendable {
        let revisionSHA256: String
        let modelID: String?
        let backend: String?
        let artifactBytes: Int64?
        let artifactSHA256: String?
        let valid: Bool
        let failure: String?
    }

    let schema: String
    let runtimeABI: String
    let activeRevisionSHA256: String?
    let previousRevisionSHA256: String?
    let revisions: [Revision]
    let partialDownloads: [String]
    let availableCapacityBytes: Int64?
    let generatedAt: String
    let diagnosticDigest: String
}

actor ModelLifecycleManager {
    private struct RevisionPointer: Codable, Hashable, Sendable {
        let revisionSHA256: String
    }

    private struct ReceiptBody: Codable, Hashable, Sendable {
        let schema: String
        let operation: String
        let revisionSHA256: String
        let previousRevisionSHA256: String?
        let artifactSHA256: String
        let artifactBytes: Int64
        let manifestSHA256: String
        let runtimeABI: String
        let evidencePackageDigest: String
        let measurementAuthorityID: String
        let source: String
        let occurredAt: String
    }

    private struct DiagnosticBody: Codable, Hashable, Sendable {
        let schema: String
        let runtimeABI: String
        let activeRevisionSHA256: String?
        let previousRevisionSHA256: String?
        let revisions: [ModelLifecycleDiagnostic.Revision]
        let partialDownloads: [String]
        let availableCapacityBytes: Int64?
        let generatedAt: String
    }

    private let fileManager: FileManager
    private let session: URLSession
    private let root: URL
    private let versions: URL
    private let downloads: URL
    private let receipts: URL
    private let activePointer: URL
    private let previousPointer: URL
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let clock: @Sendable () -> Date

    init(
        root overrideRoot: URL? = nil,
        fileManager: FileManager = .default,
        session: URLSession = .shared,
        clock: @escaping @Sendable () -> Date = Date.init
    ) throws {
        self.fileManager = fileManager
        self.session = session
        self.clock = clock

        if let overrideRoot {
            root = overrideRoot
        } else {
            let base = try fileManager.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            root = base.appendingPathComponent("ArchieModels", isDirectory: true)
        }

        versions = root.appendingPathComponent("versions", isDirectory: true)
        downloads = root.appendingPathComponent("downloads", isDirectory: true)
        receipts = root.appendingPathComponent("receipts", isDirectory: true)
        activePointer = root.appendingPathComponent("active.json")
        previousPointer = root.appendingPathComponent("previous.json")
        encoder.outputFormatting = [.sortedKeys]

        try fileManager.createDirectory(at: versions, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: downloads, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: receipts, withIntermediateDirectories: true)
        try? fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: root.path
        )
    }

    func install(
        manifestData: Data,
        detachedSignature: Data,
        signingPublicKey: Data,
        artifact source: URL,
        sourceDescription: String = "local-file"
    ) throws -> ModelLifecycleReceipt {
        let manifest = try admittedManifest(
            manifestData: manifestData,
            detachedSignature: detachedSignature,
            signingPublicKey: signingPublicKey
        )
        try verifyArtifact(at: source, manifest: manifest)

        let (requiredBytes, overflow) = manifest.artifactBytes.multipliedReportingOverflow(by: 2)
        guard !overflow else { throw RuntimeFailure.invalidManifest("artifact size overflow") }
        try preflight(requiredBytes: requiredBytes)

        let destination = revisionDirectory(manifest.revisionSHA256)
        if fileManager.fileExists(atPath: destination.path),
           let installed = try? verifiedPackage(at: destination),
           installed.manifest == manifest {
            return try activate(
                manifest.revisionSHA256,
                operation: "activate-existing",
                source: sourceDescription
            )
        }

        let staging = versions.appendingPathComponent("staging-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: staging) }

        try fileManager.copyItem(at: source, to: staging.appendingPathComponent("model"))
        try manifestData.write(to: staging.appendingPathComponent("manifest.json"), options: .atomic)
        try detachedSignature.write(to: staging.appendingPathComponent("manifest.sig"), options: .atomic)
        try signingPublicKey.write(to: staging.appendingPathComponent("manifest.pub"), options: .atomic)
        try? fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: staging.path
        )

        _ = try verifiedPackage(at: staging, expectedRevision: manifest.revisionSHA256)

        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.moveItem(at: staging, to: destination)

        return try activate(
            manifest.revisionSHA256,
            operation: "install",
            source: sourceDescription
        )
    }

    func resumeDownload(
        from remoteURL: URL,
        manifestData: Data,
        detachedSignature: Data,
        signingPublicKey: Data
    ) async throws -> ModelLifecycleReceipt {
        guard remoteURL.user == nil, remoteURL.password == nil else {
            throw ModelLifecycleFailure.credentialBearingURL
        }

        let manifest = try admittedManifest(
            manifestData: manifestData,
            detachedSignature: detachedSignature,
            signingPublicKey: signingPublicKey
        )
        let partial = partialArtifact(manifest.revisionSHA256)
        let partialBytes = try fileSize(at: partial, missing: 0)
        guard partialBytes <= manifest.artifactBytes else {
            throw ModelLifecycleFailure.partialArtifactTooLarge
        }

        let remaining = manifest.artifactBytes - partialBytes
        let (requiredBytes, overflow) = remaining.addingReportingOverflow(manifest.artifactBytes)
        guard !overflow else { throw RuntimeFailure.invalidManifest("download size overflow") }
        try preflight(requiredBytes: requiredBytes)

        if remaining > 0 {
            var request = URLRequest(url: remoteURL)
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            request.timeoutInterval = 60 * 60
            if partialBytes > 0 {
                request.setValue("bytes=\(partialBytes)-", forHTTPHeaderField: "Range")
            }

            let (temporary, response) = try await session.download(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw ModelLifecycleFailure.invalidHTTPStatus(-1)
            }

            switch http.statusCode {
            case 206:
                guard let range = http.value(forHTTPHeaderField: "Content-Range"),
                      Self.validContentRange(
                        range,
                        expectedStart: partialBytes,
                        expectedTotal: manifest.artifactBytes
                      ) else {
                    throw ModelLifecycleFailure.invalidContentRange
                }
                if partialBytes == 0 {
                    try replaceFile(at: partial, with: temporary)
                } else {
                    try appendFile(at: temporary, to: partial)
                }
            case 200:
                try replaceFile(at: partial, with: temporary)
            default:
                throw ModelLifecycleFailure.invalidHTTPStatus(http.statusCode)
            }
        }

        try verifyArtifact(at: partial, manifest: manifest)
        let receipt = try install(
            manifestData: manifestData,
            detachedSignature: detachedSignature,
            signingPublicKey: signingPublicKey,
            artifact: partial,
            sourceDescription: "resumable-download"
        )
        try? fileManager.removeItem(at: partial)
        return receipt
    }

    func activate(_ revisionSHA256: String) throws -> ModelLifecycleReceipt {
        try activate(
            revisionSHA256,
            operation: "activate",
            source: "installed-revision"
        )
    }

    func rollback() throws -> ModelLifecycleReceipt {
        guard let previous = try readPointer(previousPointer) else {
            throw ModelLifecycleFailure.rollbackUnavailable
        }
        return try activate(
            previous.revisionSHA256,
            operation: "rollback",
            source: "previous-pointer"
        )
    }

    func recoverActiveModel() throws -> ModelLifecycleReceipt {
        let active = try readPointer(activePointer)?.revisionSHA256
        if let active,
           let package = try? verifiedPackage(at: revisionDirectory(active)) {
            return try receipt(
                operation: "verify-active",
                manifest: package.manifest,
                previous: try readPointer(previousPointer)?.revisionSHA256,
                source: "active-pointer",
                manifestData: package.manifestData
            )
        }

        let previous = try readPointer(previousPointer)?.revisionSHA256
        var candidates: [String] = []
        if let previous { candidates.append(previous) }
        candidates.append(contentsOf: try installedRevisions().reversed())

        var seen = Set<String>()
        for candidate in candidates where seen.insert(candidate).inserted {
            guard (try? verifiedPackage(at: revisionDirectory(candidate))) != nil else { continue }
            try? fileManager.removeItem(at: activePointer)
            if previous == candidate {
                try? fileManager.removeItem(at: previousPointer)
            }
            return try activate(
                candidate,
                operation: "recover",
                source: "verified-fallback"
            )
        }

        try? fileManager.removeItem(at: activePointer)
        throw ModelLifecycleFailure.noRecoverableRevision
    }

    func removeRevision(_ revisionSHA256: String) throws -> ModelLifecycleReceipt? {
        let directory = revisionDirectory(revisionSHA256)
        guard fileManager.fileExists(atPath: directory.path) else {
            throw ModelLifecycleFailure.revisionNotInstalled(revisionSHA256)
        }

        let package = try verifiedPackage(at: directory)
        let activeRevision = try readPointer(activePointer)?.revisionSHA256
        let previousRevision = try readPointer(previousPointer)?.revisionSHA256
        let removalReceipt = try receipt(
            operation: "remove",
            manifest: package.manifest,
            previous: previousRevision,
            source: "installed-revision",
            manifestData: package.manifestData
        )

        try fileManager.removeItem(at: directory)

        if previousRevision == revisionSHA256 {
            try? fileManager.removeItem(at: previousPointer)
        }

        if activeRevision == revisionSHA256 {
            try? fileManager.removeItem(at: activePointer)
            if let previousRevision,
               previousRevision != revisionSHA256,
               (try? verifiedPackage(at: revisionDirectory(previousRevision))) != nil {
                _ = try activate(
                    previousRevision,
                    operation: "remove-and-fallback",
                    source: "previous-pointer"
                )
            }
        }

        return removalReceipt
    }

    func activeRevision() throws -> String? {
        try readPointer(activePointer)?.revisionSHA256
    }

    func installedRevisions() throws -> [String] {
        try fileManager.contentsOfDirectory(
            at: versions,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        .filter { url in
            guard url.lastPathComponent.count == 64,
                  ModelManifest.isSHA256(url.lastPathComponent),
                  let values = try? url.resourceValues(forKeys: [.isDirectoryKey]) else {
                return false
            }
            return values.isDirectory == true
        }
        .map(\.lastPathComponent)
        .sorted()
    }

    func diagnosticExport() throws -> Data {
        let active = try readPointer(activePointer)?.revisionSHA256
        let previous = try readPointer(previousPointer)?.revisionSHA256
        let revisions = try installedRevisions().map { revision -> ModelLifecycleDiagnostic.Revision in
            do {
                let package = try verifiedPackage(at: revisionDirectory(revision))
                return .init(
                    revisionSHA256: revision,
                    modelID: package.manifest.modelID,
                    backend: package.manifest.backend.rawValue,
                    artifactBytes: package.manifest.artifactBytes,
                    artifactSHA256: package.manifest.artifactSHA256,
                    valid: true,
                    failure: nil
                )
            } catch {
                return .init(
                    revisionSHA256: revision,
                    modelID: nil,
                    backend: nil,
                    artifactBytes: nil,
                    artifactSHA256: nil,
                    valid: false,
                    failure: error.localizedDescription
                )
            }
        }

        let partials = try fileManager.contentsOfDirectory(
            at: downloads,
            includingPropertiesForKeys: nil
        )
        .filter { $0.pathExtension == "partial" }
        .map(\.lastPathComponent)
        .sorted()

        let body = DiagnosticBody(
            schema: "archie-phone-model-diagnostic/v1",
            runtimeABI: "archie-phone-runtime/v1",
            activeRevisionSHA256: active,
            previousRevisionSHA256: previous,
            revisions: revisions,
            partialDownloads: partials,
            availableCapacityBytes: availableCapacity(),
            generatedAt: ISO8601DateFormatter().string(from: clock())
        )
        let bodyData = try encoder.encode(body)
        let diagnostic = ModelLifecycleDiagnostic(
            schema: body.schema,
            runtimeABI: body.runtimeABI,
            activeRevisionSHA256: body.activeRevisionSHA256,
            previousRevisionSHA256: body.previousRevisionSHA256,
            revisions: body.revisions,
            partialDownloads: body.partialDownloads,
            availableCapacityBytes: body.availableCapacityBytes,
            generatedAt: body.generatedAt,
            diagnosticDigest: Self.sha256(bodyData)
        )
        return try encoder.encode(diagnostic)
    }

    private func activate(
        _ revisionSHA256: String,
        operation: String,
        source: String
    ) throws -> ModelLifecycleReceipt {
        let package = try verifiedPackage(at: revisionDirectory(revisionSHA256))
        let current = try readPointer(activePointer)?.revisionSHA256

        if let current, current != revisionSHA256 {
            try writePointer(
                RevisionPointer(revisionSHA256: current),
                to: previousPointer
            )
        }
        try writePointer(
            RevisionPointer(revisionSHA256: revisionSHA256),
            to: activePointer
        )

        return try receipt(
            operation: operation,
            manifest: package.manifest,
            previous: current,
            source: source,
            manifestData: package.manifestData
        )
    }

    private func admittedManifest(
        manifestData: Data,
        detachedSignature: Data,
        signingPublicKey: Data
    ) throws -> ModelManifest {
        do {
            let key = try Curve25519.Signing.PublicKey(rawRepresentation: signingPublicKey)
            guard key.isValidSignature(detachedSignature, for: manifestData) else {
                throw ModelLifecycleFailure.invalidDetachedSignature
            }
        } catch let error as ModelLifecycleFailure {
            throw error
        } catch {
            throw ModelLifecycleFailure.invalidDetachedSignature
        }

        let manifest = try decoder.decode(ModelManifest.self, from: manifestData)
        try manifest.validate()
        return manifest
    }

    private func verifiedPackage(
        at directory: URL,
        expectedRevision: String? = nil
    ) throws -> (
        manifest: ModelManifest,
        manifestData: Data,
        artifact: URL
    ) {
        let manifestURL = directory.appendingPathComponent("manifest.json")
        let signatureURL = directory.appendingPathComponent("manifest.sig")
        let publicKeyURL = directory.appendingPathComponent("manifest.pub")
        let artifact = directory.appendingPathComponent("model")

        let manifestData = try Data(contentsOf: manifestURL)
        let signature = try Data(contentsOf: signatureURL)
        let publicKey = try Data(contentsOf: publicKeyURL)
        let manifest = try admittedManifest(
            manifestData: manifestData,
            detachedSignature: signature,
            signingPublicKey: publicKey
        )

        let requiredRevision = expectedRevision ?? directory.lastPathComponent
        guard manifest.revisionSHA256 == requiredRevision else {
            throw RuntimeFailure.invalidManifest("revision directory")
        }

        do {
            try verifyArtifact(at: artifact, manifest: manifest)
        } catch {
            throw ModelLifecycleFailure.corruptedRevision(manifest.revisionSHA256)
        }

        return (manifest, manifestData, artifact)
    }

    private func verifyArtifact(at url: URL, manifest: ModelManifest) throws {
        let size = try fileSize(at: url, missing: -1)
        guard size == manifest.artifactBytes else {
            throw RuntimeFailure.artifactSizeMismatch
        }
        let observed = try Self.sha256File(url)
        guard observed == manifest.artifactSHA256 else {
            throw RuntimeFailure.artifactDigestMismatch
        }
    }

    private func preflight(requiredBytes: Int64) throws {
        guard let available = availableCapacity() else { return }
        guard available >= requiredBytes else {
            throw ModelLifecycleFailure.insufficientStorage(
                requiredBytes: requiredBytes,
                availableBytes: available
            )
        }
    }

    private func availableCapacity() -> Int64? {
        let values = try? root.resourceValues(
            forKeys: [.volumeAvailableCapacityForImportantUsageKey]
        )
        return values?.volumeAvailableCapacityForImportantUsage
    }

    private func readPointer(_ url: URL) throws -> RevisionPointer? {
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        return try decoder.decode(
            RevisionPointer.self,
            from: Data(contentsOf: url)
        )
    }

    private func writePointer(_ pointer: RevisionPointer, to url: URL) throws {
        let data = try encoder.encode(pointer)
        try data.write(
            to: url,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }

    private func receipt(
        operation: String,
        manifest: ModelManifest,
        previous: String?,
        source: String,
        manifestData suppliedManifestData: Data? = nil
    ) throws -> ModelLifecycleReceipt {
        let manifestData = try suppliedManifestData ?? Data(
            contentsOf: revisionDirectory(manifest.revisionSHA256)
                .appendingPathComponent("manifest.json")
        )
        let occurredAt = ISO8601DateFormatter().string(from: clock())
        let body = ReceiptBody(
            schema: "archie-phone-model-lifecycle-receipt/v1",
            operation: operation,
            revisionSHA256: manifest.revisionSHA256,
            previousRevisionSHA256: previous,
            artifactSHA256: manifest.artifactSHA256,
            artifactBytes: manifest.artifactBytes,
            manifestSHA256: Self.sha256(manifestData),
            runtimeABI: manifest.runtimeABI,
            evidencePackageDigest: manifest.evidencePackageDigest,
            measurementAuthorityID: manifest.measurementAuthorityID,
            source: source,
            occurredAt: occurredAt
        )
        let bodyData = try encoder.encode(body)
        let value = ModelLifecycleReceipt(
            schema: body.schema,
            operation: body.operation,
            revisionSHA256: body.revisionSHA256,
            previousRevisionSHA256: body.previousRevisionSHA256,
            artifactSHA256: body.artifactSHA256,
            artifactBytes: body.artifactBytes,
            manifestSHA256: body.manifestSHA256,
            runtimeABI: body.runtimeABI,
            evidencePackageDigest: body.evidencePackageDigest,
            measurementAuthorityID: body.measurementAuthorityID,
            source: body.source,
            occurredAt: body.occurredAt,
            receiptDigest: Self.sha256(bodyData)
        )

        let safeTime = occurredAt.replacingOccurrences(of: ":", with: "-")
        let filename = "\(safeTime)-\(operation)-\(manifest.revisionSHA256.prefix(12)).json"
        try encoder.encode(value).write(
            to: receipts.appendingPathComponent(filename),
            options: .atomic
        )
        return value
    }

    private func revisionDirectory(_ revisionSHA256: String) -> URL {
        versions.appendingPathComponent(revisionSHA256, isDirectory: true)
    }

    private func partialArtifact(_ revisionSHA256: String) -> URL {
        downloads.appendingPathComponent("\(revisionSHA256).partial")
    }

    private func fileSize(at url: URL, missing: Int64) throws -> Int64 {
        guard fileManager.fileExists(atPath: url.path) else { return missing }
        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        if let value = attributes[.size] as? NSNumber {
            return value.int64Value
        }
        return missing
    }

    private func replaceFile(at destination: URL, with source: URL) throws {
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.copyItem(at: source, to: destination)
    }

    private func appendFile(at source: URL, to destination: URL) throws {
        if !fileManager.fileExists(atPath: destination.path) {
            _ = fileManager.createFile(atPath: destination.path, contents: nil)
        }

        let input = try FileHandle(forReadingFrom: source)
        let output = try FileHandle(forWritingTo: destination)
        defer {
            try? input.close()
            try? output.close()
        }

        try output.seekToEnd()
        while let chunk = try input.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            try output.write(contentsOf: chunk)
        }
        try output.synchronize()
    }

    private static func validContentRange(
        _ value: String,
        expectedStart: Int64,
        expectedTotal: Int64
    ) -> Bool {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized.hasPrefix("bytes ") else { return false }
        let payload = normalized.dropFirst("bytes ".count)
        let parts = payload.split(separator: "/", maxSplits: 1)
        guard parts.count == 2,
              let total = Int64(parts[1]),
              total == expectedTotal else {
            return false
        }
        let bounds = parts[0].split(separator: "-", maxSplits: 1)
        guard bounds.count == 2,
              let start = Int64(bounds[0]),
              let end = Int64(bounds[1]),
              start == expectedStart,
              end >= start,
              end < total else {
            return false
        }
        return true
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func sha256File(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }

        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize()
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
