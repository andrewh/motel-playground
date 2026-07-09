import SwiftUI

struct ContentView: View {
    @State private var yaml = sampleTopology
    @State private var durationSeconds = 1.0
    @State private var seed = 1
    @State private var traces = true
    @State private var metrics = true
    @State private var logs = true
    @State private var status = "Ready"
    @State private var stats: RunStats?
    @State private var diagnostics: [Diagnostic] = []
    @State private var rawJSON = ""
    @State private var running = false

    var body: some View {
        HSplitView {
            editorPane
                .frame(minWidth: 380)
            resultsPane
                .frame(minWidth: 420)
        }
        .frame(minWidth: 900, minHeight: 600)
    }

    private var editorPane: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Topology YAML")
                .font(.headline)
            TextEditor(text: $yaml)
                .font(.system(.body, design: .monospaced))
                .autocorrectionDisabled()
        }
        .padding(10)
    }

    private var resultsPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            controls
            Divider()
            if let stats {
                statsGrid(stats)
            }
            if !diagnostics.isEmpty {
                diagnosticsList
            }
            Text("Raw JSON")
                .font(.headline)
            ScrollView {
                Text(rawJSON.isEmpty ? "Validate or run the topology to see output." : rawJSON)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color(nsColor: .textBackgroundColor))
        }
        .padding(10)
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                TextField("Duration (s)", value: $durationSeconds, format: .number)
                    .frame(width: 90)
                TextField("Seed", value: $seed, format: .number)
                    .frame(width: 90)
                Toggle("Traces", isOn: $traces)
                Toggle("Metrics", isOn: $metrics)
                Toggle("Logs", isOn: $logs)
            }
            HStack(spacing: 12) {
                Button("Validate") { validateTopology() }
                    .disabled(running)
                Button("Run") { runTopology() }
                    .disabled(running)
                    .keyboardShortcut(.return, modifiers: .command)
                Text(status)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func statsGrid(_ stats: RunStats) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 4) {
            GridRow {
                statCell("Traces", "\(stats.traces)")
                statCell("Spans", "\(stats.spans)")
                statCell("Errors", "\(stats.errors)")
            }
            GridRow {
                statCell("Traces/s", String(format: "%.1f", stats.tracesPerSecond))
                statCell("Spans/s", String(format: "%.1f", stats.spansPerSecond))
                statCell("Error rate", String(format: "%.2f%%", stats.errorRate * 100))
            }
        }
    }

    private func statCell(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.title3, design: .monospaced))
        }
    }

    private var diagnosticsList: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(diagnostics.enumerated()), id: \.offset) { _, diagnostic in
                Text("\(diagnostic.severity): \(diagnostic.message)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(diagnostic.severity == "error" ? .red : .orange)
                    .textSelection(.enabled)
            }
        }
    }

    private func validateTopology() {
        let json = Engine.validate(yaml)
        rawJSON = json
        stats = nil
        if let result = decodeResult(ValidationResult.self, from: json) {
            diagnostics = result.diagnostics ?? []
            status = result.ok ? "Topology is valid" : "Topology has errors"
        } else {
            diagnostics = []
            status = "Could not decode validation result"
        }
    }

    private func runTopology() {
        running = true
        status = "Running…"
        stats = nil
        diagnostics = []
        let source = yaml
        let seconds = durationSeconds
        let seedValue = UInt64(max(seed, 0))
        let signals = (traces: traces, metrics: metrics, logs: logs)
        Task.detached(priority: .userInitiated) {
            let json = Engine.run(
                source,
                seconds: seconds,
                seed: seedValue,
                traces: signals.traces,
                metrics: signals.metrics,
                logs: signals.logs
            )
            await MainActor.run {
                rawJSON = json
                running = false
                if let result = decodeResult(RunResult.self, from: json) {
                    stats = result.stats
                    diagnostics = result.errors ?? []
                    status = result.ok ? "Run complete" : "Run failed"
                } else {
                    status = "Could not decode run result"
                }
            }
        }
    }
}
