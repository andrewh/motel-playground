import SwiftUI

func formatNumber(_ value: Double) -> String {
    if value == value.rounded() && abs(value) < 1_000_000 {
        return String(format: "%.0f", value)
    }
    if abs(value) >= 100 {
        return String(format: "%.1f", value)
    }
    return String(format: "%.2f", value)
}

func formatMs(_ ms: Double) -> String {
    if ms >= 1000 {
        return String(format: "%.2fs", ms / 1000)
    }
    if ms >= 10 {
        return String(format: "%.0fms", ms)
    }
    return String(format: "%.1fms", ms)
}

func formatClock(_ timestampMs: Int64?) -> String {
    guard let timestampMs, timestampMs > 0 else { return "—" }
    let date = Date(timeIntervalSince1970: Double(timestampMs) / 1000)
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"
    return formatter.string(from: date)
}

func shortTraceID(_ id: String) -> String {
    String(id.prefix(8))
}

// Stable colour per service so the waterfall, map, and charts agree.
let servicePalette: [Color] = [
    .blue, .green, .orange, .purple, .teal, .pink, .indigo, .brown,
]

func serviceColor(_ service: String, order: [String]) -> Color {
    if let index = order.firstIndex(of: service) {
        return servicePalette[index % servicePalette.count]
    }
    var hash = 0
    for scalar in service.unicodeScalars {
        hash = (hash &* 31 &+ Int(scalar.value)) & 0x7fffffff
    }
    return servicePalette[hash % servicePalette.count]
}

func severityColor(_ severity: String) -> Color {
    switch severity.uppercased() {
    case "ERROR", "FATAL": return .red
    case "WARN", "WARNING": return .orange
    case "DEBUG", "TRACE": return .secondary
    default: return .primary
    }
}
