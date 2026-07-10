import Foundation

// Headless check that the Go engine is linked and working: validates the
// sample topology, runs it for one second, and checks the decoded results.
// Returns a process exit code; prints one line per check.
func runSelfTest() -> Int32 {
    var failures = 0

    func check(_ name: String, _ condition: Bool) {
        print("\(condition ? "PASS" : "FAIL") \(name)")
        if !condition {
            failures += 1
        }
    }

    let validationJSON = Engine.validate(sampleTopology)
    let validation = decodeResult(ValidationResult.self, from: validationJSON)
    check("validate decodes", validation != nil)
    check("validate ok", validation?.ok == true)

    let invalid = decodeResult(ValidationResult.self, from: Engine.validate("services: ["))
    check("invalid topology rejected", invalid?.ok == false)
    check("invalid topology has diagnostics", !(invalid?.diagnostics ?? []).isEmpty)

    let runJSON = Engine.run(
        sampleTopology,
        seconds: 1,
        seed: 1,
        traces: true,
        metrics: true,
        logs: true
    )
    let run = decodeResult(RunResult.self, from: runJSON)
    check("run decodes", run != nil)
    check("run ok", run?.ok == true)
    check("run produced traces", (run?.stats?.traces ?? 0) > 0)
    check("run produced spans", (run?.stats?.spans ?? 0) > 0)
    check("run captured span records", !(run?.spans ?? []).isEmpty)
    check("run captured metric records", !(run?.metrics ?? []).isEmpty)
    check("run captured log records", !(run?.logs ?? []).isEmpty)
    check("run topology has graph nodes", !(run?.topology?.graph.nodes ?? []).isEmpty)
    check("run topology has graph edges", !(run?.topology?.graph.edges ?? []).isEmpty)
    let spanTraceIDs = Set((run?.spans ?? []).map(\.traceID))
    check("span records group into traces", spanTraceIDs.count == (run?.stats?.traces ?? 0))

    if let stats = run?.stats {
        print("stats: \(stats.traces) traces, \(stats.spans) spans, \(stats.errors) errors in \(stats.elapsedMs)ms")
    }

    return failures == 0 ? 0 : 1
}
