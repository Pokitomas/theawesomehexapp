import XCTest
@testable import ArchiePhone

final class ArchieStarterTests: XCTestCase {
    func testCatalogCoversEveryTargetAudience() {
        let covered = Set(ArchieStarter.catalog.map(\.audience))
        XCTAssertEqual(covered, Set(ArchieStarter.Audience.allCases))
    }

    func testStarterIdentifiersAndBriefsAreDistinctAndActionable() {
        let starters = ArchieStarter.catalog
        XCTAssertEqual(Set(starters.map(\.id)).count, starters.count)
        XCTAssertGreaterThanOrEqual(starters.count, 6)

        for starter in starters {
            XCTAssertFalse(starter.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            XCTAssertGreaterThan(starter.creationBrief.count, 220)
            XCTAssertTrue(starter.creationBrief.localizedCaseInsensitiveContains("build"))
        }
    }

    func testStartersDoNotClaimUnavailableIntegrations() {
        for starter in ArchieStarter.catalog {
            XCTAssertTrue(
                starter.creationBrief.localizedCaseInsensitiveContains("do not claim") ||
                starter.creationBrief.localizedCaseInsensitiveContains("do not imply") ||
                starter.creationBrief.localizedCaseInsensitiveContains("avoid pretending")
            )
        }
    }

    func testModelReadinessRequiresARealReadyCase() {
        XCTAssertFalse(ModelReadiness.checking.isReady)
        XCTAssertFalse(ModelReadiness.missing.isReady)
        XCTAssertFalse(ModelReadiness.invalid("bad digest").isReady)

        let ready = ModelReadiness.ready(
            ActiveModelSummary(
                modelID: "archie-test",
                revision: String(repeating: "a", count: 64),
                backend: "coreml",
                contextTokens: 1024,
                artifactBytes: 4096
            )
        )
        XCTAssertTrue(ready.isReady)
    }
}
