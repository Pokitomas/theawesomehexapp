import XCTest
import CryptoKit
@testable import ArchiePhone

final class RangeURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var payload = Data()

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "archie.test"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let payload = Self.payload
        let range = request.value(forHTTPHeaderField: "Range")
        let start: Int
        let status: Int
        var headers = ["Content-Length": "\(payload.count)"]
        if let range, range.hasPrefix("bytes="), let parsed = Int(range.dropFirst(6).dropLast()) {
            start = parsed
            status = 206
            headers["Content-Range"] = "bytes \(start)-\(payload.count - 1)/\(payload.count)"
            headers["Content-Length"] = "\(max(0, payload.count - start))"
        } else {
            start = 0
            status = 200
        }
        guard start <= payload.count,
              let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
              ) else {
            client?.urlProtocol(self, didFailWithError: ModelLifecycleFailure.invalidContentRange)
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload.subdata(in: start..<payload.count))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class ModelLifecycleTests: XCTestCase {
    struct SignedFixture {
        let manifest: ModelManifest
        let manifestData: Data
        let signature: Data
        let publicKey: Data
        let artifact: URL
        let artifactData: Data
    }

    private func temporaryRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("archie-phone-lifecycle-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func fixture(root: URL, revision: Character, bytes: Data) throws -> SignedFixture {
        let artifact = root.appendingPathComponent("artifact-\(revision)")
        try bytes.write(to: artifact)
        let manifest = ModelManifest(
            schema: "archie-phone-model-manifest/v1",
            modelID: "fixture-\(revision)",
            revisionSHA256: String(repeating: String(revision), count: 64),
            artifactSHA256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
            artifactBytes: Int64(bytes.count),
            runtimeABI: "archie-phone-runtime/v1",
            backend: .coreML,
            tokenizer: .byteV1,
            quantizationDesignID: "coreml-pal4-g16",
            inputIDsName: "input_ids",
            logitsName: "logits",
            maximumContextTokens: 4096,
            evidencePackageDigest: String(repeating: "e", count: 64),
            measurementAuthorityID: "simulator-independent-fixture"
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let manifestData = try encoder.encode(manifest)
        let privateKey = Curve25519.Signing.PrivateKey()
        return SignedFixture(
            manifest: manifest,
            manifestData: manifestData,
            signature: try privateKey.signature(for: manifestData),
            publicKey: privateKey.publicKey.rawRepresentation,
            artifact: artifact,
            artifactData: bytes
        )
    }

    func testSignedInstallActivationRollbackRemovalAndDiagnostics() async throws {
        let root = try temporaryRoot()
        let manager = try ModelLifecycleManager(root: root, clock: { Date(timeIntervalSince1970: 1_700_000_000) })
        let first = try fixture(root: root, revision: "1", bytes: Data("first-model".utf8))
        let second = try fixture(root: root, revision: "2", bytes: Data("second-model".utf8))

        let firstReceipt = try await manager.install(
            manifestData: first.manifestData,
            detachedSignature: first.signature,
            signingPublicKey: first.publicKey,
            artifact: first.artifact
        )
        XCTAssertEqual(firstReceipt.operation, "install")
        let activeAfterFirst = try await manager.activeRevision()
        XCTAssertEqual(activeAfterFirst, first.manifest.revisionSHA256)

        _ = try await manager.install(
            manifestData: second.manifestData,
            detachedSignature: second.signature,
            signingPublicKey: second.publicKey,
            artifact: second.artifact
        )
        let activeAfterSecond = try await manager.activeRevision()
        XCTAssertEqual(activeAfterSecond, second.manifest.revisionSHA256)

        let rollback = try await manager.rollback()
        XCTAssertEqual(rollback.operation, "rollback")
        let activeAfterRollback = try await manager.activeRevision()
        XCTAssertEqual(activeAfterRollback, first.manifest.revisionSHA256)

        let removal = try await manager.removeRevision(second.manifest.revisionSHA256)
        XCTAssertEqual(removal?.operation, "remove")
        let installed = try await manager.installedRevisions()
        XCTAssertEqual(installed, [first.manifest.revisionSHA256])

        let diagnosticData = try await manager.diagnosticExport()
        let diagnostic = try JSONDecoder().decode(ModelLifecycleDiagnostic.self, from: diagnosticData)
        XCTAssertEqual(diagnostic.activeRevisionSHA256, first.manifest.revisionSHA256)
        XCTAssertEqual(diagnostic.revisions.count, 1)
        XCTAssertTrue(diagnostic.revisions[0].valid)
        XCTAssertEqual(diagnostic.diagnosticDigest.count, 64)
    }

    func testRejectsInvalidManifestSignatureBeforeInstallation() async throws {
        let root = try temporaryRoot()
        let manager = try ModelLifecycleManager(root: root)
        let item = try fixture(root: root, revision: "3", bytes: Data("signed-model".utf8))
        do {
            _ = try await manager.install(
                manifestData: item.manifestData,
                detachedSignature: Data(repeating: 0, count: item.signature.count),
                signingPublicKey: item.publicKey,
                artifact: item.artifact
            )
            XCTFail("Invalid signatures must fail closed")
        } catch {
            XCTAssertEqual(error as? ModelLifecycleFailure, .invalidDetachedSignature)
        }
        let installed = try await manager.installedRevisions()
        XCTAssertEqual(installed, [])
    }

    func testResumesRangeDownloadAndActivatesOnlyAfterFullDigestVerification() async throws {
        let root = try temporaryRoot()
        let payload = Data((0..<4096).map { UInt8($0 % 251) })
        let item = try fixture(root: root, revision: "4", bytes: payload)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RangeURLProtocol.self]
        let session = URLSession(configuration: configuration)
        RangeURLProtocol.payload = payload
        let manager = try ModelLifecycleManager(root: root, session: session)

        let partialDirectory = root.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: partialDirectory, withIntermediateDirectories: true)
        let partial = partialDirectory.appendingPathComponent("\(item.manifest.revisionSHA256).partial")
        try Data(payload.prefix(1024)).write(to: partial)

        let receipt = try await manager.resumeDownload(
            from: URL(string: "https://archie.test/model")!,
            manifestData: item.manifestData,
            detachedSignature: item.signature,
            signingPublicKey: item.publicKey
        )
        XCTAssertEqual(receipt.source, "resumable-download")
        let active = try await manager.activeRevision()
        XCTAssertEqual(active, item.manifest.revisionSHA256)
        XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
    }

    func testRecoversFromCorruptedActiveRevisionToVerifiedPreviousRevision() async throws {
        let root = try temporaryRoot()
        let manager = try ModelLifecycleManager(root: root)
        let first = try fixture(root: root, revision: "5", bytes: Data("stable-model".utf8))
        let second = try fixture(root: root, revision: "6", bytes: Data("corrupt-me".utf8))
        _ = try await manager.install(
            manifestData: first.manifestData,
            detachedSignature: first.signature,
            signingPublicKey: first.publicKey,
            artifact: first.artifact
        )
        _ = try await manager.install(
            manifestData: second.manifestData,
            detachedSignature: second.signature,
            signingPublicKey: second.publicKey,
            artifact: second.artifact
        )

        let activeArtifact = root
            .appendingPathComponent("versions")
            .appendingPathComponent(second.manifest.revisionSHA256)
            .appendingPathComponent("model")
        try Data("tampered".utf8).write(to: activeArtifact)

        let recovery = try await manager.recoverActiveModel()
        XCTAssertEqual(recovery.operation, "recover")
        let active = try await manager.activeRevision()
        XCTAssertEqual(active, first.manifest.revisionSHA256)
    }
}
