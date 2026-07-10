import Foundation

if CommandLine.arguments.contains("--selftest") {
    exit(runSelfTest())
}

if let flagIndex = CommandLine.arguments.firstIndex(of: "--snapshot") {
    guard flagIndex + 1 < CommandLine.arguments.count else {
        print("usage: MotelPlayground --snapshot <output-directory>")
        exit(2)
    }
    runSnapshots(directory: CommandLine.arguments[flagIndex + 1])
}

PlaygroundApp.main()
