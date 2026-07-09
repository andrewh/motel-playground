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

struct RunResult: Decodable {
    let ok: Bool
    let stats: RunStats?
    let errors: [Diagnostic]?
}

func decodeResult<T: Decodable>(_ type: T.Type, from json: String) -> T? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
}
