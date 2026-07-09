import Foundation

if CommandLine.arguments.contains("--selftest") {
    exit(runSelfTest())
}

PlaygroundApp.main()
