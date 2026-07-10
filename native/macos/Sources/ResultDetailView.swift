import SwiftUI

private let maxRawDisplayLength = 400_000

// The active result tab's content, shared by the interactive window and the
// --snapshot harness.
struct ResultDetailView: View {
    let tab: ResultTab
    let runResult: RunResult?
    let topology: TopologySummary?
    let diagnostics: [Diagnostic]
    let rawJSON: String

    private var serviceOrder: [String] {
        topology?.graph.nodes.map(\.id) ?? []
    }

    var body: some View {
        switch tab {
        case .summary:
            SummaryView(
                stats: runResult?.stats,
                topology: topology,
                diagnostics: diagnostics,
                signals: runResult?.signals
            )
        case .spans:
            WaterfallView(spans: runResult?.spans ?? [], serviceOrder: serviceOrder)
        case .metrics:
            MetricsView(metrics: runResult?.metrics ?? [])
        case .logs:
            LogsView(logs: runResult?.logs ?? [])
        case .map:
            ServiceMapView(
                graph: topology?.graph ?? GraphData(nodes: [], edges: [], gridCols: 1, gridRows: 1),
                serviceOrder: serviceOrder
            )
        case .raw:
            rawView
        }
    }

    private var rawView: some View {
        ScrollView {
            let truncated = rawJSON.count > maxRawDisplayLength
            VStack(alignment: .leading, spacing: 6) {
                if truncated {
                    Text("Output truncated to \(maxRawDisplayLength / 1000) kB for display.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(rawJSON.isEmpty ? "Validate or run the topology to see output." : String(rawJSON.prefix(maxRawDisplayLength)))
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(8)
        }
    }
}
