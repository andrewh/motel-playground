import SwiftUI

struct TraceGroup: Identifiable {
    let id: String
    let spans: [SpanRecord]
    let startMs: Int64
    let durationMs: Double
    let hasError: Bool

    init(id: String, spans: [SpanRecord]) {
        self.id = id
        let ordered = spans.sorted {
            $0.timestampMs == $1.timestampMs
                ? $0.durationMs > $1.durationMs
                : $0.timestampMs < $1.timestampMs
        }
        self.spans = ordered
        let start = ordered.map(\.timestampMs).min() ?? 0
        self.startMs = start
        let end = ordered.map { Double($0.timestampMs - start) + $0.durationMs }.max() ?? 0
        self.durationMs = max(end, 0.001)
        self.hasError = ordered.contains(where: \.isError)
    }

    static func group(_ spans: [SpanRecord]) -> [TraceGroup] {
        var order: [String] = []
        var buckets: [String: [SpanRecord]] = [:]
        for span in spans {
            if buckets[span.traceID] == nil {
                order.append(span.traceID)
            }
            buckets[span.traceID, default: []].append(span)
        }
        return order.map { TraceGroup(id: $0, spans: buckets[$0] ?? []) }
    }
}

struct WaterfallView: View {
    let spans: [SpanRecord]
    let serviceOrder: [String]
    @State private var selectedTraceID: String?

    private var traces: [TraceGroup] {
        TraceGroup.group(spans)
    }

    var body: some View {
        if spans.isEmpty {
            EmptyResultView(message: "No spans captured. Run the topology with traces enabled.")
        } else {
            let traces = traces
            let selected = traces.first { $0.id == selectedTraceID } ?? traces.first
            HSplitView {
                tracePicker(traces, selected: selected)
                    .frame(minWidth: 190, idealWidth: 220, maxWidth: 300)
                if let selected {
                    waterfall(selected)
                        .frame(minWidth: 320, maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }

    private func tracePicker(_ traces: [TraceGroup], selected: TraceGroup?) -> some View {
        List(traces, selection: $selectedTraceID) { trace in
            HStack(spacing: 6) {
                Circle()
                    .fill(trace.hasError ? Color.red : Color.green)
                    .frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 1) {
                    Text(shortTraceID(trace.id))
                        .font(.system(.body, design: .monospaced))
                    Text("\(trace.spans.count) spans · \(formatMs(trace.durationMs))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tag(trace.id)
        }
        .listStyle(.inset)
    }

    private func waterfall(_ trace: TraceGroup) -> some View {
        ScrollView([.vertical]) {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(trace.spans.enumerated()), id: \.offset) { _, span in
                    spanRow(span, trace: trace)
                }
            }
            .padding(10)
        }
    }

    private func spanRow(_ span: SpanRecord, trace: TraceGroup) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                Text(span.service)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(span.operation)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(width: 150, alignment: .leading)
            GeometryReader { proxy in
                let offset = Double(span.timestampMs - trace.startMs) / trace.durationMs
                let width = max(span.durationMs / trace.durationMs, 0.004)
                RoundedRectangle(cornerRadius: 3)
                    .fill(span.isError ? Color.red : serviceColor(span.service, order: serviceOrder))
                    .frame(width: max(proxy.size.width * width, 2))
                    .offset(x: proxy.size.width * offset)
                    .opacity(span.isError ? 0.9 : 0.75)
            }
            .frame(height: 14)
            Text(formatMs(span.durationMs))
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 58, alignment: .trailing)
        }
        .help("\(span.service).\(span.operation) — \(formatMs(span.durationMs))\(span.isError ? " (error)" : "") · \(span.kind)")
    }
}

struct EmptyResultView: View {
    let message: String

    var body: some View {
        VStack {
            Spacer()
            Text(message)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
            Spacer()
        }
    }
}
