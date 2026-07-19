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
            CreateSurface()
                .tabItem { Label("Create", systemImage: "sparkles.rectangle.stack.fill") }
            AppsSurface()
                .tabItem { Label("Apps", systemImage: "square.grid.2x2.fill") }
            TeachSurface()
                .tabItem { Label("Teach", systemImage: "graduationcap.fill") }
            MindSurface()
                .tabItem { Label("Advanced", systemImage: "slider.horizontal.3") }
        }
        .tint(.primary)
    }
}

struct CreateSurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime
    @FocusState private var promptFocused: Bool
    @State private var selectedAudience: ArchieStarter.Audience = .creator

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    hero
                    modelCard
                    promptComposer
                    if runtime.state == .active || runtime.state == .loading || !runtime.output.isEmpty {
                        liveBuild
                    }
                    starterLibrary
                    recentBuilds
                }
                .padding(18)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Archie")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) { statusBar }
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("MAKE SOMETHING REAL")
                .font(.caption.weight(.black))
                .tracking(2.2)
                .foregroundStyle(.secondary)
            Text("What should Archie make?")
                .font(.largeTitle.bold())
                .minimumScaleFactor(0.8)
            Text("A private app studio for creators, sellers, organizers, and students who need useful phone software without learning code.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
    }

    private var modelCard: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: modelSymbol)
                .font(.title2)
                .frame(width: 36, height: 36)
                .background(modelColor.opacity(0.12))
                .foregroundStyle(modelColor)
                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))

            VStack(alignment: .leading, spacing: 5) {
                Text(modelTitle).font(.headline)
                Text(modelDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            Spacer()

            if case .checking = runtime.modelReadiness {
                ProgressView()
            } else if !runtime.modelReadiness.isReady {
                Button("Check") { Task { await runtime.refreshModelStatus() } }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var promptComposer: some View {
        VStack(alignment: .leading, spacing: 14) {
            TextField("Describe the app, who it is for, and what should feel effortless…", text: $runtime.objective, axis: .vertical)
                .focused($promptFocused)
                .lineLimit(4...10)
                .font(.title3)
                .padding(18)
                .background(Color(uiColor: .secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))

            HStack(spacing: 12) {
                Button {
                    runtime.mode = .operatorMode
                    runtime.run()
                } label: {
                    Label(buildButtonTitle, systemImage: "arrow.up.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!canBuild)

                if runtime.state == .active || runtime.state == .loading {
                    Button("Stop") { runtime.stop() }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                }
            }

            HStack(spacing: 8) {
                Label("Verified local model", systemImage: "checkmark.shield")
                Text("•")
                Text("Private runs")
                Text("•")
                Text("Evidence preserved")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private var liveBuild: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label("Local model output", systemImage: "cpu.fill")
                    .font(.headline)
                Spacer()
                if runtime.state == .active || runtime.state == .loading { ProgressView() }
            }

            if runtime.output.isEmpty {
                Text("Archie is opening the verified local model and preparing the next durable product object.")
                    .foregroundStyle(.secondary)
            } else {
                Text(runtime.output)
                    .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
                    .textSelection(.enabled)
            }

            if !runtime.output.isEmpty && runtime.state == .resting {
                Button {
                    runtime.objective = "Refine the current app. Keep what works, remove unnecessary complexity, and make the next useful phone-first improvement.\n\nCurrent result:\n\(runtime.output)"
                    promptFocused = true
                } label: {
                    Label("Refine this app", systemImage: "wand.and.stars")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(20)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    private var starterLibrary: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("App starters").font(.title2.bold())
                Text("Focused briefs for people Archie is built to help first.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(ArchieStarter.Audience.allCases) { audience in
                        Button(audience.rawValue) { selectedAudience = audience }
                            .buttonStyle(.bordered)
                            .tint(selectedAudience == audience ? .primary : .secondary)
                    }
                }
            }

            ForEach(filteredStarters) { starter in
                Button {
                    runtime.useStarter(starter)
                    promptFocused = true
                } label: {
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: starter.symbol)
                            .font(.title3)
                            .frame(width: 38, height: 38)
                            .background(Color.primary.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                        VStack(alignment: .leading, spacing: 5) {
                            Text(starter.title).font(.headline)
                            Text(starter.subtitle)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.leading)
                        }
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .foregroundStyle(.secondary)
                    }
                    .padding(16)
                    .background(Color(uiColor: .secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var recentBuilds: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent apps").font(.title2.bold())
                Spacer()
                Text("\(runtime.runs.count)").foregroundStyle(.secondary)
            }

            if runtime.runs.isEmpty {
                ContentUnavailableView("Your apps will live here", systemImage: "square.grid.2x2", description: Text("Choose a starter or describe one clear idea. Archie preserves every completed local run."))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            } else {
                ForEach(runtime.runs.prefix(3)) { run in
                    Button {
                        runtime.mode = .operatorMode
                        runtime.objective = "Continue building this app from its preserved state:\n\(run.objective)\n\nCurrent result:\n\(run.output)"
                        promptFocused = true
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(run.objective).font(.headline).lineLimit(2)
                            Text(run.output).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .background(Color(uiColor: .secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var statusBar: some View {
        HStack(spacing: 9) {
            Circle().fill(statusColor).frame(width: 7, height: 7)
            Text(statusText).font(.footnote)
            Spacer()
            Text("\(runtime.runs.count) saved runs")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .background(.ultraThinMaterial)
    }

    private var filteredStarters: [ArchieStarter] {
        ArchieStarter.catalog.filter { $0.audience == selectedAudience }
    }

    private var canBuild: Bool {
        runtime.modelReadiness.isReady &&
        !runtime.objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        runtime.state != .active && runtime.state != .loading
    }

    private var buildButtonTitle: String {
        runtime.runs.isEmpty ? "Make the app" : "Build it"
    }

    private var modelTitle: String {
        switch runtime.modelReadiness {
        case .checking: return "Checking the local model"
        case .ready(let model): return model.modelID
        case .missing: return "Local model required"
        case .invalid: return "Local model failed verification"
        }
    }

    private var modelDetail: String {
        switch runtime.modelReadiness {
        case .checking:
            return "Reading the active content-addressed model package."
        case .ready(let model):
            return "\(model.backend.uppercased()) · revision \(model.shortRevision) · \(model.contextTokens) token context · \(ByteCountFormatter.string(fromByteCount: model.artifactBytes, countStyle: .file))"
        case .missing:
            return "Install an admitted Core ML model package before creating. Archie will not silently substitute a remote model or pretend inference happened."
        case .invalid(let reason):
            return reason
        }
    }

    private var modelSymbol: String {
        switch runtime.modelReadiness {
        case .checking: return "hourglass"
        case .ready: return "checkmark.seal.fill"
        case .missing: return "square.and.arrow.down"
        case .invalid: return "exclamationmark.triangle.fill"
        }
    }

    private var modelColor: Color {
        switch runtime.modelReadiness {
        case .checking: return .secondary
        case .ready: return .green
        case .missing: return .orange
        case .invalid: return .red
        }
    }

    private var statusText: String {
        switch runtime.state {
        case .resting: return runtime.modelReadiness.isReady ? "Verified model ready" : "Waiting for a verified model"
        case .loading: return "Opening local intelligence"
        case .active: return "Generating locally"
        case .paused(let reason): return reason
        case .failed(let reason): return reason
        }
    }

    private var statusColor: Color {
        switch runtime.state {
        case .failed: return .red
        case .paused: return .orange
        case .active, .loading: return .green
        case .resting: return runtime.modelReadiness.isReady ? .green : .secondary
        }
    }
}

struct AppsSurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime

    var body: some View {
        NavigationStack {
            List {
                ForEach(runtime.runs) { run in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(run.objective).font(.headline).lineLimit(2)
                        Text(run.output).foregroundStyle(.secondary).lineLimit(5)
                        HStack {
                            Label("Preserved local run", systemImage: "checkmark.seal")
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
                    ContentUnavailableView("No apps yet", systemImage: "square.grid.2x2", description: Text("Completed local-model runs appear here so they can be reopened and refined."))
                }
            }
            .navigationTitle("Apps")
        }
    }
}

struct TeachSurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Teach is secondary to making. A completed build becomes eligible training material only after its trajectory and evidence are preserved.")
                }

                Section("Eligible runs") {
                    if runtime.runs.isEmpty {
                        Text("Complete an app first.").foregroundStyle(.secondary)
                    } else {
                        ForEach(runtime.runs.prefix(20)) { run in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(run.objective).font(.headline).lineLimit(2)
                                Label("Trajectory preserved", systemImage: "checkmark.circle.fill")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Label("Candidate not admitted", systemImage: "lock.shield")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 5)
                        }
                    }
                }

                Section("Boundary") {
                    Text("No build is labeled learned, promoted, or improved until independent training, held-out evaluation, reproduction, and admission gates pass.")
                }
            }
            .navigationTitle("Teach Archie")
        }
    }
}

struct MindSurface: View {
    @EnvironmentObject private var runtime: ArchieRuntime

    var body: some View {
        NavigationStack {
            Form {
                Section("Verified local model") {
                    switch runtime.modelReadiness {
                    case .checking:
                        LabeledContent("Status", value: "Checking")
                    case .ready(let model):
                        LabeledContent("Status", value: "Ready")
                        LabeledContent("Model", value: model.modelID)
                        LabeledContent("Revision", value: model.shortRevision)
                        LabeledContent("Backend", value: model.backend.uppercased())
                        LabeledContent("Context", value: "\(model.contextTokens) tokens")
                    case .missing:
                        LabeledContent("Status", value: "Not installed")
                    case .invalid(let reason):
                        LabeledContent("Status", value: "Invalid")
                        Text(reason).foregroundStyle(.secondary)
                    }
                    Button("Verify again") { Task { await runtime.refreshModelStatus() } }
                }

                Section("Phone runtime") {
                    LabeledContent("Compute", value: "Core ML on device")
                    LabeledContent("Power", value: runtime.lowPowerMode ? "Reduced" : "Full")
                    LabeledContent("Thermal", value: String(describing: runtime.thermalState))
                }

                Section("Experience") {
                    LabeledContent("Runs", value: "\(runtime.runs.count)")
                    LabeledContent("Features", value: "\(runtime.oak.features.count)")
                    LabeledContent("Reusable options", value: "\(runtime.oak.options.count)")
                    LabeledContent("Outcome models", value: "\(runtime.oak.models.count)")
                }

                Section("Behavior") {
                    Picker("Runtime contract", selection: $runtime.mode) {
                        ForEach(ArchieMode.allCases) { mode in
                            Label(mode.rawValue, systemImage: mode.icon).tag(mode)
                        }
                    }
                }

                Section("Truth boundary") {
                    Text("The app loads only the active digest-verified admitted model package. It does not silently use a hosted model and does not claim executable app export, deployment, integrations, or training success unless those systems return real evidence.")
                }

                Section {
                    Button("Release model memory") { Task { await runtime.unload() } }
                }
            }
            .navigationTitle("Advanced")
        }
    }
}
