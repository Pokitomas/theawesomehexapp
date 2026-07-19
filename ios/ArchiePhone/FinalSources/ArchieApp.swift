import SwiftUI

@main
struct ArchieApp: App {
    @StateObject private var runtime = ArchieRuntime()

    var body: some Scene {
        WindowGroup {
            ProductRoot().environmentObject(runtime)
        }
    }
}

struct ProductRoot: View {
    var body: some View {
        TabView {
            AskSurface()
                .tabItem { Label("Ask", systemImage: "arrow.up.circle.fill") }
            HistorySurface()
                .tabItem { Label("History", systemImage: "clock.fill") }
            AdvancedSurface()
                .tabItem { Label("Advanced", systemImage: "slider.horizontal.3") }
        }
        .tint(.primary)
    }
}

struct AskSurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime
    @FocusState private var promptFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    intro
                    composer
                    examples
                    truthBoundary
                    if shouldShowResult {
                        result
                    }
                }
                .padding(18)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Archie")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Tell Archie what you need handled.")
                .font(.largeTitle.bold())
            Text("Give it the messy version. Archie will return one useful result.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
    }

    private var composer: some View {
        VStack(spacing: 12) {
            TextField("Paste text, explain the situation, or say what you need next.", text: $runtime.objective, axis: .vertical)
                .focused($promptFocused)
                .lineLimit(5...12)
                .font(.title3)
                .padding(18)
                .background(Color(uiColor: .secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .accessibilityLabel("Tell Archie what you need handled")

            HStack(spacing: 10) {
                Button("Clear") {
                    runtime.objective = ""
                    promptFocused = true
                }
                .buttonStyle(.bordered)
                .controlSize(.large)

                Button {
                    runtime.mode = .operatorMode
                    runtime.run()
                } label: {
                    Label("Ask Archie", systemImage: "arrow.up.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(runtime.objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isRunning)
            }

            if isRunning {
                Button("Stop") { runtime.stop() }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var examples: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Examples")
                .font(.headline)
            ForEach(examplePrompts, id: \.self) { prompt in
                Button {
                    runtime.objective = prompt
                    promptFocused = true
                } label: {
                    HStack {
                        Text(prompt)
                            .multilineTextAlignment(.leading)
                        Spacer()
                        Image(systemName: "arrow.up.right")
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 14)
                    .background(Color.secondary.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var truthBoundary: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Model truth", systemImage: "checkmark.shield")
                .font(.headline)
            Text("Archie attempts local Core ML inference only after activeModel() returns a verified package. There is no silent remote fallback. If no admitted model is present, Archie reports that boundary instead of pretending it answered.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var result: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(resultTitle)
                    .font(.headline)
                Spacer()
                if isRunning { ProgressView() }
            }

            if runtime.output.isEmpty {
                Text(statusText)
                    .foregroundStyle(statusIsFailure ? .red : .secondary)
            } else {
                Text(runtime.output)
                    .frame(maxWidth: .infinity, minHeight: 140, alignment: .topLeading)
                    .textSelection(.enabled)
            }
        }
        .padding(18)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private var isRunning: Bool {
        runtime.state == .active || runtime.state == .loading
    }

    private var shouldShowResult: Bool {
        isRunning || !runtime.output.isEmpty || statusIsFailure
    }

    private var statusIsFailure: Bool {
        if case .failed = runtime.state { return true }
        if case .paused = runtime.state { return true }
        return false
    }

    private var resultTitle: String {
        isRunning ? "Working locally" : "Result"
    }

    private var statusText: String {
        switch runtime.state {
        case .resting: return "Ready."
        case .loading: return "Verifying and opening the admitted local model."
        case .active: return "Generating on this phone."
        case .paused(let reason): return reason
        case .failed(let reason): return reason
        }
    }

    private let examplePrompts = [
        "Turn this messy thought into a short plan.",
        "Summarize the text I paste next.",
        "Draft a clear follow-up message.",
        "Break this assignment into the next few steps."
    ]
}

struct HistorySurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime

    var body: some View {
        NavigationStack {
            List {
                ForEach(runtime.runs) { run in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(run.objective)
                            .font(.headline)
                            .lineLimit(3)
                        Text(run.output)
                            .foregroundStyle(.secondary)
                            .lineLimit(6)
                        HStack {
                            Label("Saved locally", systemImage: "iphone")
                            Spacer()
                            Text(run.createdAt, style: .relative)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 7)
                }
            }
            .overlay {
                if runtime.runs.isEmpty {
                    ContentUnavailableView(
                        "No history yet",
                        systemImage: "clock",
                        description: Text("Archie is new. Completed local requests will appear here after a verified model produces a result.")
                    )
                }
            }
            .navigationTitle("History")
        }
    }
}

struct AdvancedSurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime

    var body: some View {
        NavigationStack {
            Form {
                Section("Local runtime") {
                    LabeledContent("Model", value: "Verified at run time")
                    LabeledContent("Remote fallback", value: "Off")
                    LabeledContent("Power", value: runtime.lowPowerMode ? "Reduced" : "Full")
                    LabeledContent("Thermal", value: String(describing: runtime.thermalState))
                }

                Section("Local experience") {
                    LabeledContent("Saved results", value: "\(runtime.runs.count)")
                    LabeledContent("Features", value: "\(runtime.oak.features.count)")
                    LabeledContent("Reusable options", value: "\(runtime.oak.options.count)")
                    LabeledContent("Outcome models", value: "\(runtime.oak.models.count)")
                }

                Section("Truth boundary") {
                    Text("No on-device model is claimed unless activeModel() validates the manifest and SHA-256 artifact and returns the exact active revision. Archie does not claim app generation, external tool use, deployment, training success, or model admission without real evidence.")
                }

                Section {
                    Button("Release model memory") {
                        Task { await runtime.unload() }
                    }
                }
            }
            .navigationTitle("Advanced")
        }
    }
}
