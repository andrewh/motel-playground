import SwiftUI
import UniformTypeIdentifiers

enum ResultTab: String, CaseIterable, Identifiable {
    case summary = "Summary"
    case spans = "Spans"
    case metrics = "Metrics"
    case logs = "Logs"
    case map = "Map"
    case raw = "Raw"

    var id: String { rawValue }
}

struct ContentView: View {
    @State private var yaml = sampleTopology
    @State private var durationSeconds = 1.0
    @State private var seed = 1
    @State private var slowThresholdMs = 0.0
    @State private var traces = true
    @State private var metrics = true
    @State private var logs = true
    @State private var status = "Ready"
    @State private var running = false
    @State private var rawJSON: String
    @State private var runResult: RunResult?
    @State private var validation: ValidationResult?
    @State private var tab: ResultTab

    init(runResult: RunResult? = nil, rawJSON: String = "", tab: ResultTab = .summary) {
        _runResult = State(initialValue: runResult)
        _rawJSON = State(initialValue: rawJSON)
        _tab = State(initialValue: tab)
    }

    private var topology: TopologySummary? {
        runResult?.topology ?? validation?.topology
    }

    private var diagnostics: [Diagnostic] {
        runResult?.errors ?? validation?.diagnostics ?? []
    }

    // Service names in graph order, so colours stay stable across views.
    private var serviceOrder: [String] {
        topology?.graph.nodes.map(\.id) ?? []
    }

    var body: some View {
        NavigationStack {
            HSplitView {
                editorPane
                    .frame(minWidth: 360, idealWidth: 460)
                resultsPane
                    .frame(minWidth: 560, maxWidth: .infinity)
            }
            .toolbar { toolbarContent }
        }
        .frame(minWidth: 1020, minHeight: 640)
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup {
            Button {
                openTopology()
            } label: {
                Label("Open", systemImage: "folder")
            }
            .help("Open a topology YAML file")
            Button {
                saveTopology()
            } label: {
                Label("Save", systemImage: "square.and.arrow.down")
            }
            .help("Save the topology YAML to a file")
            Button {
                yaml = sampleTopology
                status = "Sample topology loaded"
            } label: {
                Label("Sample", systemImage: "arrow.counterclockwise")
            }
            .help("Replace the editor with the sample topology")
        }
        ToolbarItemGroup {
            Button {
                validateTopology()
            } label: {
                Label("Validate", systemImage: "checkmark.seal")
            }
            .disabled(running)
            .help("Validate the topology YAML")
            Button {
                runTopology()
            } label: {
                Label("Run", systemImage: "play.fill")
            }
            .disabled(running)
            .keyboardShortcut(.return, modifiers: .command)
            .help("Run the topology (⌘↩)")
        }
    }

    private var editorPane: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Topology YAML")
                .font(.headline)
            TextEditor(text: $yaml)
                .font(.system(.body, design: .monospaced))
                .autocorrectionDisabled()
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.3))
                )
        }
        .padding(10)
    }

    private var resultsPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            runControls
            Picker("Result view", selection: $tab) {
                ForEach(ResultTab.allCases) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            resultView
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.3))
                )
            statusBar
        }
        .padding(10)
    }

    private var runControls: some View {
        HStack(spacing: 14) {
            labelledField("Duration (s)") {
                TextField("Duration (s)", value: $durationSeconds, format: .number)
                    .frame(width: 52)
            }
            labelledField("Seed") {
                TextField("Seed", value: $seed, format: .number)
                    .frame(width: 64)
            }
            labelledField("Slow ≥ (ms)") {
                TextField("Slow ≥ (ms)", value: $slowThresholdMs, format: .number)
                    .frame(width: 52)
            }
            Divider().frame(height: 18)
            Toggle("Traces", isOn: $traces)
            Toggle("Metrics", isOn: $metrics)
            Toggle("Logs", isOn: $logs)
            Spacer()
        }
        .controlSize(.small)
    }

    private func labelledField(_ label: String, @ViewBuilder field: () -> some View) -> some View {
        HStack(spacing: 5) {
            Text(label)
                .foregroundStyle(.secondary)
            field()
                .multilineTextAlignment(.trailing)
        }
        .fixedSize()
    }

    private var resultView: some View {
        ResultDetailView(
            tab: tab,
            runResult: runResult,
            topology: topology,
            diagnostics: diagnostics,
            rawJSON: rawJSON
        )
    }

    private var statusBar: some View {
        HStack(spacing: 8) {
            if running {
                ProgressView()
                    .controlSize(.small)
            }
            Text(status)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if let stats = runResult?.stats {
                Text("\(stats.traces) traces · \(stats.spans) spans · \(stats.errors) errors")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(height: 18)
    }

    private func validateTopology() {
        let json = Engine.validate(yaml)
        rawJSON = json
        runResult = nil
        if let result = decodeResult(ValidationResult.self, from: json) {
            validation = result
            status = result.ok ? "Topology is valid" : "Topology has errors"
            if !result.ok {
                tab = .summary
            }
        } else {
            validation = nil
            status = "Could not decode validation result"
        }
    }

    private func runTopology() {
        running = true
        status = "Running…"
        let source = yaml
        let seconds = durationSeconds
        let seedValue = UInt64(max(seed, 0))
        let slowMs = slowThresholdMs
        let signals = (traces: traces, metrics: metrics, logs: logs)
        Task.detached(priority: .userInitiated) {
            let json = Engine.run(
                source,
                seconds: seconds,
                seed: seedValue,
                traces: signals.traces,
                metrics: signals.metrics,
                logs: signals.logs,
                slowThresholdMs: slowMs
            )
            await MainActor.run {
                rawJSON = json
                running = false
                if let result = decodeResult(RunResult.self, from: json) {
                    runResult = result
                    validation = nil
                    status = result.ok ? "Run complete" : "Run failed"
                    if !result.ok {
                        tab = .summary
                    }
                } else {
                    status = "Could not decode run result"
                }
            }
        }
    }

    private func openTopology() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.yaml]
        panel.allowsOtherFileTypes = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            yaml = try String(contentsOf: url, encoding: .utf8)
            status = "Loaded \(url.lastPathComponent)"
        } catch {
            status = "Could not read \(url.lastPathComponent): \(error.localizedDescription)"
        }
    }

    private func saveTopology() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.yaml]
        panel.nameFieldStringValue = "topology.yaml"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try yaml.write(to: url, atomically: true, encoding: .utf8)
            status = "Saved \(url.lastPathComponent)"
        } catch {
            status = "Could not save \(url.lastPathComponent): \(error.localizedDescription)"
        }
    }
}
