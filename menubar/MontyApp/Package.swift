// swift-tools-version:5.9
// Monty's native menu bar app. Built with SwiftPM rather than an Xcode project so it
// stays a few plain files; `./build.sh` wraps the binary in an unsigned .app, which
// UserNotifications needs (it refuses a bare executable with no bundle id).
import PackageDescription

let package = Package(
    name: "MontyApp",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "MontyApp", path: "Sources/MontyApp"),
    ]
)
