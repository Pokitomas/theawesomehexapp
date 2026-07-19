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

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    hero
                    promptComposer
                    if runtime.state == .active || runtime.state == .loading || !runtime.output.isEmpty {
                        liveBuild
                    }
                    recentBuilds
                    samples
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
            Text("Describe the app in normal language. Archie keeps the technical machinery out of your way.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
    }

    private var promptComposer: some View {
        VStack(alignment: .leading, spacing: 14) {
            TextField("A tiny budgeting app that feels calm and works offline…", text: $runtime.objective, axis: .vertical)
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
                .disabled(runtime.objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || runtime.state == .active || runtime.state == .loading)

                if runtime.state == .active || runtime.state == .loading {
                    Button("Stop") { runtime.stop() }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                }
            }

            HStack(spacing: 8) {
                Label("Local-first", systemImage: "iphone")
                Text("•")
                Text("Permission-aware")
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
                Label("Live build", systemImage: "hammer.fill")
                    .font(.headline)
                Spacer()
                if runtime.state == .active || runtime.state == .loading { ProgressView() }
            }

            if runtime.output.isEmpty {
                Text("Archie is opening the local mind and preparing the build.")
                    .foregroundStyle(.secondary)
            } else {
                Text(runtime.output)
                    .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
                    .textSelection(.enabled)
            }

            if !runtime.output.isEmpty && runtime.state == .resting {
                Button {
                    runtime.objective = "Refine the current app. Keep what works and make the next useful improvement.\n\nCurrent result:\n\(runtime.output)"
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

    private var recentBuilds: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent apps").font(.title2.bold())
                Spacer()
                Text("\(runtime.runs.count)").foregroundStyle(.secondary)
            }

            if runtime.runs.isEmpty {
                ContentUnavailableView("Your apps will live here", systemImage: "square.grid.2x2", description: Text("Start with one clear idea. Archie will preserve the run so you can reopen and refine it."))
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

    private var samples: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Start from a spark").font(.title2.bold())
            ForEach(sampleIdeas, id: \.self) { idea in
                Button {
                    runtime.objective = idea
                    runtime.mode = .operatorMode
                    promptFocused = true
                } label: {
                    HStack {
                        Text(idea).multilineTextAlignment(.leading)
                        Spacer()
                        Image(systemName: "arrow.up.right")
                    }
                    .padding(15)
                    .background(Color.secondary.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
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

    private var buildButtonTitle: String {
        runtime.runs.isEmpty ? "Make the app" : "Build it"
    }

    private var statusText: String {
        switch runtime.state {
        case .resting: return "Ready on this phone"
        case .loading: return "Opening local intelligence"
        case .active: return "Building"
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

    private let sampleIdeas = [
        "Make a one-thumb habit tracker that feels rewarding, not guilty.",
        "Build a private trip planner from screenshots and notes.",
        "Create a tiny inventory app for clothes I want to sell."
    ]
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
                            Label("Preserved run", systemImage: "checkmark.seal")
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
                    ContentUnavailableView("No apps yet", systemImage: "square.grid.2x2", description: Text("Anything Archie completes will appear here as a preserved, refinable run."))
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
                    Text("Teach is secondary to making. A completed build can become training material only after its trajectory and evidence are preserved.")
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
                    Text("No build is labeled learned, promoted, or improved until independent training and evaluation gates pass.")
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
                Section("Local runtime") {
                    LabeledContent("Inference", value: "On device")
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
                    Text("Archie uses the admitted local model when available and preserves local experience. It does not claim tools, sensors, app export, deployment, or training success unless those systems return real evidence.")
                }
                Section {
                    Button("Release model memory") { Task { await runtime.unload() } }
                }
            }
            .navigationTitle("Advanced")
        }
    }
}
