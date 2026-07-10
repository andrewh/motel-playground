import AppKit
import SwiftUI

// Headless-ish visual check: runs the sample topology, hosts the full UI in
// an off-screen-agnostic window for each result tab, and writes one PNG per
// tab. Snapshots come from the app's own view tree, so no screen-recording
// permission is needed.
func runSnapshots(directory: String) -> Never {
    let url = URL(fileURLWithPath: directory, isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    } catch {
        print("FAIL cannot create \(directory): \(error.localizedDescription)")
        exit(1)
    }
    let app = NSApplication.shared
    let delegate = SnapshotDelegate(directory: url)
    app.delegate = delegate
    app.run()
    exit(1)
}

private final class SnapshotDelegate: NSObject, NSApplicationDelegate {
    private let directory: URL
    private var failures = 0

    init(directory: URL) {
        self.directory = directory
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        DispatchQueue.global(qos: .userInitiated).async {
            let json = Engine.run(sampleTopology, seconds: 1, seed: 1, traces: true, metrics: true, logs: true)
            guard let result = decodeResult(RunResult.self, from: json), result.ok else {
                print("FAIL snapshot run did not produce a decodable result")
                DispatchQueue.main.async { exit(1) }
                return
            }
            DispatchQueue.main.async {
                self.capture(result: result, rawJSON: json, tabs: ResultTab.allCases, index: 0)
            }
        }
    }

    private func capture(result: RunResult, rawJSON: String, tabs: [ResultTab], index: Int) {
        guard index < tabs.count else {
            exit(failures == 0 ? 0 : 1)
        }
        let tab = tabs[index]
        let hosting = NSHostingView(
            rootView: ContentView(runResult: result, rawJSON: rawJSON, tab: tab)
                .frame(width: 1280, height: 800)
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = hosting
        window.orderFrontRegardless()

        // One runloop beat so AppKit-backed children (List, Table) lay out.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            hosting.layoutSubtreeIfNeeded()
            let name = "\(tab.rawValue.lowercased()).png"
            // cacheDisplay misses SwiftUI-drawn chrome (headers, toggles,
            // the tab picker) but captures every AppKit-backed container,
            // which includes all six result views. Good enough to verify
            // the data rendering; check chrome by launching the app.
            if let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) {
                hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    do {
                        try png.write(to: self.directory.appendingPathComponent(name))
                        print("PASS wrote \(name)")
                    } catch {
                        print("FAIL writing \(name): \(error.localizedDescription)")
                        self.failures += 1
                    }
                } else {
                    print("FAIL encoding \(name)")
                    self.failures += 1
                }
            } else {
                print("FAIL capturing \(name)")
                self.failures += 1
            }
            window.orderOut(nil)
            self.capture(result: result, rawJSON: rawJSON, tabs: tabs, index: index + 1)
        }
    }
}
