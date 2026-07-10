import SwiftUI

struct SummaryView: View {
    let stats: RunStats?
    let topology: TopologySummary?
    let diagnostics: [Diagnostic]
    let signals: RunSignals?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let stats {
                    GroupBox("Run statistics") {
                        statsGrid(stats)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(4)
                    }
                }
                if let topology {
                    GroupBox("Topology") {
                        topologyFacts(topology)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(4)
                    }
                }
                if let signals, !(signals.traces && signals.metrics && signals.logs) {
                    Text(disabledSignalsNote(signals))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if !diagnostics.isEmpty {
                    GroupBox("Diagnostics") {
                        diagnosticsList
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(4)
                    }
                }
                if stats == nil && topology == nil && diagnostics.isEmpty {
                    EmptyResultView(message: "Validate or run the topology to see a summary.")
                        .frame(minHeight: 200)
                }
            }
            .padding(12)
        }
    }

    private func statsGrid(_ stats: RunStats) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 10) {
            GridRow {
                statCell("Traces", "\(stats.traces)")
                statCell("Spans", "\(stats.spans)")
                statCell("Errors", "\(stats.errors)")
                statCell("Elapsed", formatMs(Double(stats.elapsedMs)))
            }
            GridRow {
                statCell("Traces/s", String(format: "%.1f", stats.tracesPerSecond))
                statCell("Spans/s", String(format: "%.1f", stats.spansPerSecond))
                statCell("Error rate", String(format: "%.2f%%", stats.errorRate * 100))
                statCell("", "")
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
        .frame(minWidth: 70, alignment: .leading)
    }

    private func topologyFacts(_ topology: TopologySummary) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 10) {
            GridRow {
                statCell("Services", "\(topology.services.count)")
                statCell("Operations", "\(topology.operations)")
                statCell("Edges", "\(topology.edges)")
                statCell("Scenarios", "\(topology.scenarios)")
            }
            GridRow {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Roots")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(topology.roots.joined(separator: ", "))
                        .font(.system(.body, design: .monospaced))
                }
                .gridCellColumns(4)
            }
        }
    }

    private var diagnosticsList: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(diagnostics.enumerated()), id: \.offset) { _, diagnostic in
                Label {
                    Text(diagnostic.message)
                        .textSelection(.enabled)
                } icon: {
                    Image(systemName: diagnostic.severity == "error" ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(diagnostic.severity == "error" ? .red : .orange)
                }
                .font(.system(.caption, design: .monospaced))
            }
        }
    }

    private func disabledSignalsNote(_ signals: RunSignals) -> String {
        var disabled: [String] = []
        if !signals.traces { disabled.append("traces") }
        if !signals.metrics { disabled.append("metrics") }
        if !signals.logs { disabled.append("logs") }
        return "Disabled for this run: \(disabled.joined(separator: ", "))."
    }
}
