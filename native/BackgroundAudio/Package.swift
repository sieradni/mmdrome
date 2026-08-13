// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BackgroundAudio",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [
        .library(
            name: "BackgroundAudio",
            targets: ["BackgroundAudio"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0")
    ],
    targets: [
        // Pure, dependency-free core (LoaderState now; future pure scheduler/
        // state pieces land here). Kept separable from the Capacitor-bound iOS
        // target so `swift test` can run it on the macOS host — Capacitor is
        // iOS-only and would never compile for the test host.
        .target(
            name: "BackgroundAudioCore",
            path: "Sources/Core"
        ),
        .target(
            name: "BackgroundAudio",
            dependencies: [
                .target(name: "BackgroundAudioCore"),
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios"
        ),
        .testTarget(
            name: "BackgroundAudioTests",
            dependencies: ["BackgroundAudioCore"],
            path: "Tests/BackgroundAudioTests"
        )
    ]
)