import SwiftUI

struct LogsView: View {
    let logs: [LogRecord]

    private struct Row: Identifiable {
        let id: Int
        let record: LogRecord
    }

    var body: some View {
        if logs.isEmpty {
            EmptyResultView(message: "No logs captured. Run the topology with logs enabled.")
        } else {
            let rows = logs.enumerated().map { Row(id: $0.offset, record: $0.element) }
            Table(rows) {
                TableColumn("Time") { row in
                    Text(formatClock(row.record.timestampMs))
                        .font(.system(.body, design: .monospaced))
                }
                .width(min: 90, ideal: 100, max: 120)
                TableColumn("Severity") { row in
                    Text(row.record.severity)
                        .foregroundStyle(severityColor(row.record.severity))
                }
                .width(min: 60, ideal: 70, max: 90)
                TableColumn("Source") { row in
                    Text(sourceLabel(row.record))
                        .font(.system(.body, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .width(min: 120, ideal: 170, max: 260)
                TableColumn("Body") { row in
                    Text(row.record.body)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(row.record.body)
                }
            }
        }
    }

    private func sourceLabel(_ record: LogRecord) -> String {
        let service = record.service ?? "unknown"
        guard let operation = record.operation, !operation.isEmpty else { return service }
        return "\(service).\(operation)"
    }
}
