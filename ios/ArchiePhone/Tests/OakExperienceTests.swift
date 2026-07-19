import XCTest
@testable import ArchiePhone

final class OakExperienceTests: XCTestCase {
    func testRecordedExperienceSurvivesStoreReload() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = try OakExperienceStore(root: root)
        let plan = await store.plan(objective: "Finish the native Archie release", mode: ArchieMode.operatorMode.rawValue)
        try await store.record(
            objective: "Finish the native Archie release",
            mode: ArchieMode.operatorMode.rawValue,
            result: "Completed the release gate and preserved the next action.",
            plan: plan,
            reward: 0.9
        )

        let recorded = await store.currentSnapshot()
        XCTAssertEqual(recorded.events.count, 1)
        XCTAssertFalse(recorded.features.isEmpty)
        XCTAssertEqual(recorded.options.first?.attempts, 1)
        XCTAssertEqual(recorded.models.first?.observedTransitions, 1)

        let reloaded = try OakExperienceStore(root: root)
        let restored = await reloaded.currentSnapshot()
        XCTAssertEqual(restored.events, recorded.events)
        XCTAssertEqual(restored.features, recorded.features)
        XCTAssertEqual(restored.options, recorded.options)
        XCTAssertEqual(restored.models, recorded.models)
    }

    func testCorruptSnapshotIsQuarantinedAndStartsClean() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("not-json".utf8).write(to: root.appendingPathComponent("oak-v1.json"))

        let store = try OakExperienceStore(root: root)
        let snapshot = await store.currentSnapshot()
        XCTAssertTrue(snapshot.events.isEmpty)
        XCTAssertTrue(snapshot.features.isEmpty)
        XCTAssertTrue(snapshot.options.isEmpty)
        XCTAssertTrue(snapshot.models.isEmpty)

        let names = try FileManager.default.contentsOfDirectory(atPath: root.path)
        XCTAssertTrue(names.contains { $0.hasPrefix("oak-v1.corrupt-") })
        XCTAssertFalse(names.contains("oak-v1.json"))
    }

    func testRewardIsClampedBeforeLearning() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = try OakExperienceStore(root: root)
        let plan = await store.plan(objective: "Map a stable world object", mode: ArchieMode.world.rawValue)
        try await store.record(
            objective: "Map a stable world object",
            mode: ArchieMode.world.rawValue,
            result: "Object and relation preserved.",
            plan: plan,
            reward: 9
        )

        let snapshot = await store.currentSnapshot()
        XCTAssertEqual(snapshot.events.first?.reward, 1)
        XCTAssertEqual(snapshot.options.first?.meanReward, 1)
        XCTAssertEqual(snapshot.models.first?.expectedReward, 1)
    }

    private func temporaryRoot() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("OakExperienceTests-\(UUID().uuidString)", isDirectory: true)
    }
}
