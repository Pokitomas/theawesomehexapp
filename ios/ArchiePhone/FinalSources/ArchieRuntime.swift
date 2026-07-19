import Foundation
import UIKit

struct RunRecord: Identifiable, Hashable {
    let id: UUID
    let objective: String
    let mode: ArchieMode
    var output: String
    let createdAt: Date

    init(id: UUID = UUID(), objective: String, mode: ArchieMode, output: String, createdAt: Date = Date()) {
        self.id = id
        self.objective = objective
        self.mode = mode
        self.output = output
        self.createdAt = createdAt
    }
}

enum ArchieMode: String, CaseIterable, Identifiable {
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
        case .world: return "point.3.connected.trianglepath.dotted"
        }
    }
    var contract: String {
        switch self {
        case .quiet: return "Observe. Surface only a material change or required action."
        case .companion: return "Stay continuous with the person and situation. Speak naturally only when useful."
        case .operatorMode: return "Turn the objective into completed work. Return the result or the exact permission boundary."
        case .focus: return "Protect the active objective. Remove noise and produce the next irreversible gain."
        case .world: return "Build an object-and-relation model with evidence, uncertainty, and paths for action."
        }
    }
}

@MainActor
final class ArchieRuntime: ObservableObject {
    enum State: Equatable { case resting, loading, active, paused(String), failed(String) }

    @Published var mode: ArchieMode = .companion
    @Published var objective = ""
    @Published private(set) var output = ""
    @Published private(set) var runs: [RunRecord] = []
    @Published private(set) var oak = OakSnapshot()
    @Published private(set) var state: State = .resting
    @Published private(set) var lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
    @Published private(set) var thermalState = ProcessInfo.processInfo.thermalState

    private let modelStore: ModelStore
    private let experience: OakExperienceStore
    private var backend: (any PhoneInferenceBackend)?
    private var task: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []

    init() {
        do {
            modelStore = try ModelStore()
            experience = try OakExperienceStore()
        } catch {
            fatalError("Archie local storage failed: \(error)")
        }
        observePhone()
        Task { [weak self] in
            guard let self else { return }
            let snapshot = await self.experience.currentSnapshot()
            self.oak = snapshot
            self.runs = snapshot.events.compactMap(Self.runRecord(from:))
        }
    }

    func run() {
        let goal = objective.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !goal.isEmpty else { return }
        stop()
        output = ""
        let activeMode = mode
        task = Task { [weak self] in
            guard let self else { return }
            do {
                try self.guardPhone()
                self.state = .loading
                let plan = await self.experience.plan(objective: goal, mode: activeMode.rawValue)
                guard let (manifest, modelURL) = try await self.modelStore.activeModel() else { throw RuntimeFailure.noAdmittedModel }
                self.backend = try CoreMLAutoregressiveBackend(modelURL: modelURL, manifest: manifest)
                self.state = .active
                let prompt = Self.envelope(goal: goal, mode: activeMode, plan: plan)
                guard let backend = self.backend else { throw RuntimeFailure.noAdmittedModel }
                for try await token in backend.generate(prompt: prompt, maximumNewTokens: self.lowPowerMode ? 96 : 256) {
                    try self.guardPhone()
                    self.output += token
                }
                let final = self.output.trimmingCharacters(in: .whitespacesAndNewlines)
                let reward = Self.proxyReward(result: final)
                try await self.experience.record(objective: goal, mode: activeMode.rawValue, result: final, plan: plan, reward: reward)
                self.runs.insert(RunRecord(objective: goal, mode: activeMode, output: final), at: 0)
                self.runs = Array(self.runs.prefix(100))
                self.oak = await self.experience.currentSnapshot()
                self.objective = ""
                self.state = .resting
            } catch is CancellationError {
                self.state = .resting
            } catch {
                self.state = .failed(error.localizedDescription)
                await self.unload()
            }
        }
    }

    func continueLast() {
        guard let last = runs.first else { return }
        mode = last.mode
        objective = "Continue this objective from its preserved state:\n\(last.objective)\nCurrent result:\n\(last.output)"
        run()
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

    private static func runRecord(from event: ExperienceEvent) -> RunRecord? {
        guard let mode = ArchieMode(rawValue: event.mode) else { return nil }
        return RunRecord(id: event.id, objective: event.objective, mode: mode, output: event.result, createdAt: event.createdAt)
    }

    private static func envelope(goal: String, mode: ArchieMode, plan: OakPlan) -> String {
        """
        [ARCHIE]
        execution=private_local_phone
        contract=\(mode.contract)
        objective=\(goal)
        learned_context:
        \(plan.context)
        rule=Continue the real objective. Do not imitate a chat transcript. Prefer durable objects, completed actions, and resumable state. Never claim a tool or sensor was used unless its result is present.
        [CONTINUATION]
        """
    }

    private static func proxyReward(result: String) -> Double {
        guard !result.isEmpty else { return 0 }
        var reward = min(0.65, Double(result.count) / 900)
        if result.contains("\n") { reward += 0.08 }
        if result.contains("done") || result.contains("completed") || result.contains("next") { reward += 0.12 }
        if result.count > 1800 { reward -= 0.08 }
        return max(0, min(1, reward))
    }

    private func observePhone() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
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
            Task { @MainActor [weak self] in
                self?.lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
            }
        })
        observers.append(center.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.stop()
                self.state = .paused("Memory released")
                await self.unload()
            }
        })
    }
}
