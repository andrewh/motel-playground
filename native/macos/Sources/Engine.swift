import Foundation

// Swift-facing surface of the motel engine, linked in as a Go C archive
// (native/macos/gen/motelbridge.a). Calls are synchronous and can take as
// long as the requested run duration, so callers should dispatch off the
// main thread.
enum Engine {
    static func validate(_ yaml: String) -> String {
        bridgeCall(yaml) { MotelValidate($0) }
    }

    static func run(
        _ yaml: String,
        seconds: Double,
        seed: UInt64,
        traces: Bool,
        metrics: Bool,
        logs: Bool,
        slowThresholdMs: Double = 0
    ) -> String {
        bridgeCall(yaml) {
            MotelRun(
                $0,
                seconds,
                seed,
                traces ? 1 : 0,
                metrics ? 1 : 0,
                logs ? 1 : 0,
                slowThresholdMs
            )
        }
    }

    private static func bridgeCall(
        _ yaml: String,
        _ invoke: (UnsafeMutablePointer<CChar>?) -> UnsafeMutablePointer<CChar>?
    ) -> String {
        let source = strdup(yaml)
        defer { free(source) }
        guard let result = invoke(source) else {
            return #"{"ok":false,"diagnostics":[{"severity":"error","message":"engine returned no result"}]}"#
        }
        defer { MotelFree(result) }
        return String(cString: result)
    }
}

struct Diagnostic: Decodable {
    let severity: String
    let message: String
}

struct ValidationResult: Decodable {
    let ok: Bool
    let diagnostics: [Diagnostic]?
    let topology: TopologySummary?
}

struct RunStats: Decodable {
    let traces: Int
    let spans: Int
    let errors: Int
    let elapsedMs: Int
    let tracesPerSecond: Double
    let spansPerSecond: Double
    let errorRate: Double

    enum CodingKeys: String, CodingKey {
        case traces, spans, errors
        case elapsedMs = "elapsed_ms"
        case tracesPerSecond = "traces_per_second"
        case spansPerSecond = "spans_per_second"
        case errorRate = "error_rate"
    }
}

struct RunSignals: Decodable {
    let traces: Bool
    let metrics: Bool
    let logs: Bool
}

struct RunResult: Decodable {
    let ok: Bool
    let stats: RunStats?
    let topology: TopologySummary?
    let spans: [SpanRecord]?
    let metrics: [MetricRecord]?
    let logs: [LogRecord]?
    let errors: [Diagnostic]?
    let signals: RunSignals?
}

struct TopologySummary: Decodable {
    let services: [ServiceSummary]
    let roots: [String]
    let operations: Int
    let edges: Int
    let scenarios: Int
    let graph: GraphData
}

struct ServiceSummary: Decodable {
    let name: String
}

struct GraphData: Decodable {
    let nodes: [GraphNode]
    let edges: [GraphEdge]
    let gridCols: Int
    let gridRows: Int
}

struct GraphNode: Decodable {
    let id: String
    let operations: [String]
    let isRoot: Bool
    let col: Int
    let row: Int
}

struct GraphEdge: Decodable {
    let source: String
    let target: String
    let weight: Double
    let async: Bool
}

struct SpanRecord: Decodable {
    let traceID: String
    let spanID: String
    let service: String
    let operation: String
    let parentService: String?
    let parentOperation: String?
    let timestampMs: Int64
    let durationMs: Double
    let isError: Bool
    let kind: String

    enum CodingKeys: String, CodingKey {
        case traceID = "trace_id"
        case spanID = "span_id"
        case service, operation, kind
        case parentService = "parent_service"
        case parentOperation = "parent_operation"
        case timestampMs = "timestamp_ms"
        case durationMs = "duration_ms"
        case isError = "is_error"
    }
}

struct MetricRecord: Decodable {
    let name: String
    let type: String
    let unit: String?
    let service: String?
    let operation: String?
    let value: Double?
    let count: UInt64?
    let sum: Double?
    let timestampMs: Int64?

    enum CodingKeys: String, CodingKey {
        case name, type, unit, service, operation, value, count, sum
        case timestampMs = "timestamp_ms"
    }

    // The service.operation context this record was measured for.
    var context: String {
        let service = service ?? "unknown"
        guard let operation, !operation.isEmpty else { return service }
        return "\(service).\(operation)"
    }

    // A numeric value suitable for plotting; histograms collapse to their
    // mean so a single series stays comparable with gauge/counter values.
    var chartValue: Double {
        if type == "histogram", let count, count > 0 {
            return (sum ?? 0) / Double(count)
        }
        return value ?? sum ?? 0
    }

    var displayValue: String {
        let suffix = unit.map { " \($0)" } ?? ""
        if let count, count > 0 {
            return "\(count) samples, sum \(formatNumber(sum ?? 0))\(suffix)"
        }
        return "\(formatNumber(value ?? 0))\(suffix)"
    }
}

struct LogRecord: Decodable {
    let severity: String
    let body: String
    let service: String?
    let operation: String?
    let timestampMs: Int64?
    let traceID: String?

    enum CodingKeys: String, CodingKey {
        case severity, body, service, operation
        case timestampMs = "timestamp_ms"
        case traceID = "trace_id"
    }
}

func decodeResult<T: Decodable>(_ type: T.Type, from json: String) -> T? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
}
