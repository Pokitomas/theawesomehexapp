import Foundation
import CryptoKit

struct ExperienceEvent: Codable, Hashable, Identifiable, Sendable {
    let id: UUID
    let objective: String
    let mode: String
    let result: String
    let featureKeys: [String]
    let optionID: String?
    let reward: Double
    let createdAt: Date
}

struct ArchieFeature: Codable, Hashable, Identifiable, Sendable {
    let id: String
    var label: String
    var observations: Int
    var utility: Double
    var lastSeenAt: Date
}

struct ArchieOption: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let featureID: String
    var instruction: String
    var attempts: Int
    var meanReward: Double
    var lastUsedAt: Date
}

struct OptionModel: Codable, Hashable, Sendable {
    let optionID: String
    var expectedReward: Double
    var confidence: Double
    var observedTransitions: Int
}

struct OakSnapshot: Codable, Sendable {
    var events: [ExperienceEvent] = []
    var features: [ArchieFeature] = []
    var options: [ArchieOption] = []
    var models: [OptionModel] = []
}

struct OakPlan: Sendable {
    let featureKeys: [String]
    let selectedOption: ArchieOption?
    let context: String
}

actor OakExperienceStore {
    private let root: URL
    private let fileURL: URL
    private var snapshot: OakSnapshot
    private let encoder: JSONEncoder

    init(root overrideRoot: URL? = nil, fileManager: FileManager = .default) throws {
        if let overrideRoot {
            root = overrideRoot
        } else {
            let base = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            root = base.appendingPathComponent("ArchieExperience", isDirectory: true)
        }
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        try? fileManager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
        fileURL = root.appendingPathComponent("oak-v1.json")
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        if let data = try? Data(contentsOf: fileURL) {
            do {
                snapshot = try JSONDecoder().decode(OakSnapshot.self, from: data)
            } catch {
                let quarantine = root.appendingPathComponent("oak-v1.corrupt-\(UUID().uuidString).json")
                try? fileManager.moveItem(at: fileURL, to: quarantine)
                snapshot = OakSnapshot()
            }
        } else {
            snapshot = OakSnapshot()
        }
    }

    func plan(objective: String, mode: String) -> OakPlan {
        let keys = Self.featureKeys(for: objective)
        let matching = snapshot.options.filter { keys.contains($0.featureID) && $0.attempts > 0 }
        let selected = matching.max { lhs, rhs in
            let lm = snapshot.models.first(where: { $0.optionID == lhs.id })
            let rm = snapshot.models.first(where: { $0.optionID == rhs.id })
            return Self.score(option: lhs, model: lm) < Self.score(option: rhs, model: rm)
        }
        let featureLines = snapshot.features
            .filter { keys.contains($0.id) }
            .sorted { $0.utility > $1.utility }
            .prefix(6)
            .map { "feature=\($0.label); observations=\($0.observations); utility=\(String(format: "%.2f", $0.utility))" }
        let optionLine = selected.map { "reusable_option=\($0.instruction); observed_reward=\(String(format: "%.2f", $0.meanReward)); attempts=\($0.attempts)" }
        let context = (["mode=\(mode)"] + featureLines + [optionLine].compactMap { $0 }).joined(separator: "\n")
        return OakPlan(featureKeys: keys, selectedOption: selected, context: context)
    }

    func record(objective: String, mode: String, result: String, plan: OakPlan, reward: Double) throws {
        let boundedReward = max(0, min(1, reward))
        let now = Date()
        for key in plan.featureKeys {
            if let index = snapshot.features.firstIndex(where: { $0.id == key }) {
                snapshot.features[index].observations += 1
                snapshot.features[index].utility += 0.08 * (boundedReward - snapshot.features[index].utility)
                snapshot.features[index].lastSeenAt = now
            } else {
                snapshot.features.append(ArchieFeature(id: key, label: Self.label(for: key, objective: objective), observations: 1, utility: boundedReward, lastSeenAt: now))
            }
        }

        let optionID: String
        if let selected = plan.selectedOption {
            optionID = selected.id
        } else {
            let featureID = plan.featureKeys.first ?? Self.digest(objective)
            optionID = Self.digest("\(featureID)|\(mode)")
            if !snapshot.options.contains(where: { $0.id == optionID }) {
                snapshot.options.append(ArchieOption(id: optionID, featureID: featureID, instruction: Self.optionInstruction(objective: objective, mode: mode), attempts: 0, meanReward: 0, lastUsedAt: now))
            }
        }

        if let index = snapshot.options.firstIndex(where: { $0.id == optionID }) {
            let attempts = snapshot.options[index].attempts
            snapshot.options[index].attempts += 1
            snapshot.options[index].meanReward = (snapshot.options[index].meanReward * Double(attempts) + boundedReward) / Double(attempts + 1)
            snapshot.options[index].lastUsedAt = now
        }
        if let index = snapshot.models.firstIndex(where: { $0.optionID == optionID }) {
            snapshot.models[index].observedTransitions += 1
            snapshot.models[index].expectedReward += 0.12 * (boundedReward - snapshot.models[index].expectedReward)
            snapshot.models[index].confidence = min(0.98, 1 - exp(-Double(snapshot.models[index].observedTransitions) / 8))
        } else {
            snapshot.models.append(OptionModel(optionID: optionID, expectedReward: boundedReward, confidence: 0.12, observedTransitions: 1))
        }

        snapshot.events.insert(ExperienceEvent(id: UUID(), objective: objective, mode: mode, result: result, featureKeys: plan.featureKeys, optionID: optionID, reward: boundedReward, createdAt: now), at: 0)
        snapshot.events = Array(snapshot.events.prefix(300))
        snapshot.features = Array(snapshot.features.sorted { $0.lastSeenAt > $1.lastSeenAt }.prefix(500))
        snapshot.options = Array(snapshot.options.sorted { $0.lastUsedAt > $1.lastUsedAt }.prefix(300))
        let admittedOptionIDs = Set(snapshot.options.map(\.id))
        snapshot.models = Array(snapshot.models.filter { admittedOptionIDs.contains($0.optionID) }.prefix(300))
        try persist()
    }

    func currentSnapshot() -> OakSnapshot { snapshot }

    private func persist() throws {
        try encoder.encode(snapshot).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static func score(option: ArchieOption, model: OptionModel?) -> Double {
        let confidence = model?.confidence ?? 0
        let expected = model?.expectedReward ?? option.meanReward
        return expected * (0.55 + 0.45 * confidence) + min(0.08, log1p(Double(option.attempts)) * 0.015)
    }

    private static func featureKeys(for text: String) -> [String] {
        let words = text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
        let stop: Set<String> = ["the","a","an","to","and","or","of","for","in","on","with","this","that","my","me","i","it","is","be"]
        let useful = words.filter { $0.count > 2 && !stop.contains($0) }
        let singles = useful.prefix(6).map(digest)
        let pairs = zip(useful, useful.dropFirst()).prefix(3).map { digest("\($0.0) \($0.1)") }
        return Array(Set(singles + pairs)).sorted()
    }

    private static func label(for key: String, objective: String) -> String {
        objective.split(separator: " ").prefix(4).joined(separator: " ")
    }

    private static func optionInstruction(objective: String, mode: String) -> String {
        "For \(mode.lowercased()) work resembling ‘\(objective.prefix(96))’, first recover the concrete state, choose one reversible next move, execute or explain it, then preserve the result for continuation."
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).prefix(10).map { String(format: "%02x", $0) }.joined()
    }
}
