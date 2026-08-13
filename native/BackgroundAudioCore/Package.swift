// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BackgroundAudioCore",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [
        .library(
            name: "BackgroundAudioCore",
            targets: ["BackgroundAudioCore"])
    ],
    targets: [
        // Pure, dependency-free scheduler/state core (LoaderState now; future
        // pure pieces — RampPlan, CrossfadeState, divergence decision — land
        // here). Deliberately its own SPM package: `swift test` runs it on the
        // macOS host without ever resolving the Capacitor-bound plugin, whose
        // XCFrameworks carry no macOS slices.
        .target(
            name: "BackgroundAudioCore",
            path: "Sources/Core"
        ),
        .testTarget(
            name: "BackgroundAudioTests",
            dependencies: ["BackgroundAudioCore"],
            path: "Tests/BackgroundAudioTests"
        )
    ]
)