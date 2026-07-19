import SwiftUI

@main
struct ArchieApp: App {
    @StateObject private var runtime = ArchieRuntime()
    var body: some Scene {
        WindowGroup {
            RootSurface().environmentObject(runtime)
        }
    }
}

struct RootSurface: View {
    var body: some View {
        TabView {
            NowSurface().tabItem { Label("Now", systemImage: "circle.fill") }
            GroveSurface().tabItem { Label("Grove", systemImage: "tree.fill") }
            RunsSurface().tabItem { Label("Rings", systemImage: "circle.hexagongrid.fill") }
            MindSurface().tabItem { Label("Mind", systemImage: "iphone.gen3") }
        }
        .tint(.primary)
    }
}

struct NowSurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    presenceHeader
                    modeRail
                    continuation
                    objectiveField
                    if !runtime.runs.isEmpty {
                        Button { runtime.continueLast() } label: {
                            Label("Resume the living thread", systemImage: "arrow.trianglehead.clockwise")
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding(18)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) { statusBar }
        }
    }

    private var presenceHeader: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text("ARCHIE").font(.caption.weight(.black)).tracking(2.4)
                Text(headerLine).font(.title2.weight(.semibold))
            }
            Spacer()
            Circle()
                .fill(statusColor)
                .frame(width: 11, height: 11)
                .shadow(color: statusColor.opacity(0.5), radius: 8)
        }
    }

    private var modeRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 9) {
                ForEach(ArchieMode.allCases) { mode in
                    Button {
                        runtime.mode = mode
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Image(systemName: mode.icon)
                            Text(mode.rawValue).font(.caption.weight(.semibold))
                        }
                        .frame(width: 78, height: 58, alignment: .leading)
                        .padding(10)
                        .background(runtime.mode == mode ? Color.primary : Color.secondary.opacity(0.1))
                        .foregroundStyle(runtime.mode == mode ? Color(uiColor: .systemBackground) : .primary)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var continuation: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(runtime.mode.rawValue, systemImage: runtime.mode.icon)
                    .font(.headline)
                Spacer()
                if runtime.state == .active { ProgressView() }
            }
            Text(runtime.output.isEmpty ? emptyText : runtime.output)
                .font(.body)
                .frame(maxWidth: .infinity, minHeight: 220, alignment: .topLeading)
                .textSelection(.enabled)
        }
        .padding(20)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    private var objectiveField: some View {
        VStack(spacing: 12) {
            TextField(promptText, text: $runtime.objective, axis: .vertical)
                .lineLimit(2...9)
                .padding(17)
                .background(Color.secondary.opacity(0.09))
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            HStack {
                Button { runtime.run() } label: {
                    Label("Move", systemImage: "arrow.up.right.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(runtime.objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if runtime.state == .active || runtime.state == .loading {
                    Button("Stop") { runtime.stop() }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                }
            }
        }
    }

    private var statusBar: some View {
        HStack(spacing: 9) {
            Circle().fill(statusColor).frame(width: 7, height: 7)
            Text(statusText).font(.footnote)
            Spacer()
            Text("\(runtime.oak.features.count) features · \(runtime.oak.options.count) options")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .background(.ultraThinMaterial)
    }

    private var headerLine: String {
        switch runtime.mode {
        case .quiet: return "Nothing false. Nothing loud."
        case .companion: return "Stay with what is alive."
        case .operatorMode: return "Turn intent into matter."
        case .focus: return "One thread. Keep it moving."
        case .world: return "Objects first. Relations next."
        }
    }

    private var emptyText: String {
        switch runtime.mode {
        case .quiet: return "Archie is resting inside the phone."
        case .companion: return "Leave a thought, a feeling, or a half-made thing."
        case .operatorMode: return "Name the outcome. Archie will preserve the path."
        case .focus: return "Put the one real objective here."
        case .world: return "Open a subject. Archie will grow its map."
        }
    }

    private var promptText: String {
        switch runtime.mode {
        case .quiet: return "What should remain in awareness?"
        case .companion: return "What is happening?"
        case .operatorMode: return "What must become true?"
        case .focus: return "What are we carrying through?"
        case .world: return "What should Archie understand?"
        }
    }

    private var statusText: String {
        switch runtime.state {
        case .resting: return "Local and still"
        case .loading: return "Opening the local mind"
        case .active: return "Growing a continuation"
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

struct GroveSurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime

    var body: some View {
        NavigationStack {
            List {
                Section("Growing features") {
                    ForEach(runtime.oak.features.sorted { $0.utility > $1.utility }.prefix(30)) { feature in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(feature.label).font(.headline)
                            HStack {
                                Text("seen \(feature.observations) times")
                                Spacer()
                                Text("utility \(feature.utility, format: .number.precision(.fractionLength(2)))")
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Reusable ways through") {
                    ForEach(runtime.oak.options.sorted { $0.meanReward > $1.meanReward }.prefix(30)) { option in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(option.instruction).lineLimit(4)
                            Text("\(option.attempts) uses · reward \(option.meanReward, format: .number.precision(.fractionLength(2)))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .overlay {
                if runtime.oak.features.isEmpty {
                    ContentUnavailableView("The grove is new", systemImage: "tree", description: Text("Features and reusable options appear as Archie works from lived runs."))
                }
            }
            .navigationTitle("Grove")
        }
    }
}

struct RunsSurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime

    var body: some View {
        NavigationStack {
            List(runtime.runs) { run in
                VStack(alignment: .leading, spacing: 7) {
                    Label(run.mode.rawValue, systemImage: run.mode.icon)
                        .font(.caption).foregroundStyle(.secondary)
                    Text(run.objective).font(.headline).lineLimit(2)
                    Text(run.output).lineLimit(4).foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }
            .overlay {
                if runtime.runs.isEmpty {
                    ContentUnavailableView("No rings yet", systemImage: "circle.hexagongrid", description: Text("Each completed local continuation leaves a resumable ring."))
                }
            }
            .navigationTitle("Rings")
        }
    }
}

struct MindSurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime

    var body: some View {
        NavigationStack {
            Form {
                Section("Local body") {
                    LabeledContent("Inference", value: "On device")
                    LabeledContent("Power adaptation", value: runtime.lowPowerMode ? "Reduced" : "Full")
                    LabeledContent("Thermal state", value: String(describing: runtime.thermalState))
                }
                Section("Experience") {
                    LabeledContent("Events", value: "\(runtime.oak.events.count)")
                    LabeledContent("Features", value: "\(runtime.oak.features.count)")
                    LabeledContent("Options", value: "\(runtime.oak.options.count)")
                    LabeledContent("Outcome models", value: "\(runtime.oak.models.count)")
                }
                Section("Boundary") {
                    Text("The base model generates. The growth-ring layer learns from runs, retrieves reusable options, and plans locally. Archie does not claim sensors, tools, or permissions it has not actually received.")
                }
                Section {
                    Button("Release model memory") { Task { await runtime.unload() } }
                }
            }
            .navigationTitle("Mind")
        }
    }
}
