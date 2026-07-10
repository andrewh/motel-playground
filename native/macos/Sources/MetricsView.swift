import Charts
import SwiftUI

private let maxChartSeries = 6

struct MetricsView: View {
    let metrics: [MetricRecord]

    var body: some View {
        if metrics.isEmpty {
            EmptyResultView(message: "No metrics captured. Run the topology with metrics enabled.")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(groupByName(metrics), id: \.name) { group in
                        MetricChartCard(name: group.name, records: group.records)
                    }
                }
                .padding(12)
            }
        }
    }

    private func groupByName(_ metrics: [MetricRecord]) -> [(name: String, records: [MetricRecord])] {
        var order: [String] = []
        var buckets: [String: [MetricRecord]] = [:]
        for metric in metrics {
            if buckets[metric.name] == nil {
                order.append(metric.name)
            }
            buckets[metric.name, default: []].append(metric)
        }
        return order.map { (name: $0, records: buckets[$0] ?? []) }
    }
}

private struct MetricChartCard: View {
    let name: String
    let records: [MetricRecord]

    var body: some View {
        // Keep only the busiest series so the legend stays readable, the
        // same rule the web charts apply.
        var peaks: [String: Double] = [:]
        for record in records {
            peaks[record.context] = max(peaks[record.context] ?? -.infinity, record.chartValue)
        }
        let visibleSeries = peaks.sorted { $0.value > $1.value }.prefix(maxChartSeries).map(\.key)
        let allowed = Set(visibleSeries)
        let visible = records.filter { allowed.contains($0.context) }
        let overTime = Set(records.map { $0.timestampMs ?? 0 }).count > 1
        let hidden = peaks.count - allowed.count
        let type = records.first?.type ?? "metric"
        let unit = records.first { $0.unit?.isEmpty == false }?.unit

        return GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                if overTime {
                    timeSeriesChart(visible)
                } else {
                    barChart(visible)
                }
                if hidden > 0 {
                    Text("+\(hidden) more series not shown")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                latestValues(visible, series: visibleSeries)
            }
            .padding(4)
        } label: {
            HStack(spacing: 6) {
                Text(name).font(.headline)
                Text(unit.map { "\(type) (\($0))" } ?? type)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func timeSeriesChart(_ records: [MetricRecord]) -> some View {
        Chart(Array(records.enumerated()), id: \.offset) { _, record in
            LineMark(
                x: .value("Time", Date(timeIntervalSince1970: Double(record.timestampMs ?? 0) / 1000)),
                y: .value("Value", record.chartValue)
            )
            .foregroundStyle(by: .value("Series", record.context))
            .symbol(by: .value("Series", record.context))
        }
        .chartLegend(position: .bottom, alignment: .leading)
        .frame(height: 160)
    }

    private func barChart(_ records: [MetricRecord]) -> some View {
        Chart(Array(records.enumerated()), id: \.offset) { _, record in
            BarMark(
                x: .value("Value", record.chartValue),
                y: .value("Series", record.context)
            )
            .foregroundStyle(by: .value("Series", record.context))
        }
        .chartLegend(.hidden)
        .frame(height: max(50, CGFloat(records.count) * 24))
    }

    private func latestValues(_ records: [MetricRecord], series: [String]) -> some View {
        let latest = series.compactMap { context in
            records.last { $0.context == context }
        }
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(latest.enumerated()), id: \.offset) { _, record in
                HStack {
                    Text(record.context)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(record.displayValue)
                        .font(.system(.caption, design: .monospaced))
                }
            }
        }
    }
}
