import XCTest
@testable import ArchiePhone

final class ModelManifestTests: XCTestCase {
    func testRejectsWeakRevisionAndWrongABI() {
        let manifest = ModelManifest(
            schema: "archie-phone-model-manifest/v1",
            modelID: "test",
            revisionSHA256: "not-a-digest",
            artifactSHA256: String(repeating: "a", count: 64),
            artifactBytes: 1,
            runtimeABI: "wrong",
            backend: .coreML,
            tokenizer: .byteV1,
            quantizationDesignID: "coreml-pal4-g16",
            inputIDsName: "input_ids",
            logitsName: "logits",
            maximumContextTokens: 4096,
            evidencePackageDigest: String(repeating: "b", count: 64),
            measurementAuthorityID: "lab"
        )
        XCTAssertThrowsError(try manifest.validate())
    }

    func testAcceptsExactDigestBoundManifest() throws {
        let manifest = ModelManifest(
            schema: "archie-phone-model-manifest/v1",
            modelID: "test",
            revisionSHA256: String(repeating: "1", count: 64),
            artifactSHA256: String(repeating: "a", count: 64),
            artifactBytes: 1024,
            runtimeABI: "archie-phone-runtime/v1",
            backend: .coreML,
            tokenizer: .byteV1,
            quantizationDesignID: "coreml-pal4-g16",
            inputIDsName: "input_ids",
            logitsName: "logits",
            maximumContextTokens: 4096,
            evidencePackageDigest: String(repeating: "b", count: 64),
            measurementAuthorityID: "physical-lab-one"
        )
        XCTAssertNoThrow(try manifest.validate())
    }
}
