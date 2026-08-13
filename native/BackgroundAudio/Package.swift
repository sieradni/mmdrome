// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BackgroundAudio",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "BackgroundAudio",
            targets: ["BackgroundAudio"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0"),
        .package(name: "BackgroundAudioCore", path: "../BackgroundAudioCore")
    ],
    targets: [
        // Capacitor-bound iOS plugin. The pure core lives in the sibling
        // BackgroundAudioCore package (its own SPM root) so `swift test` on
        // the macOS host never builds this target — Capacitor's XCFrameworks
        // carry no macOS slices, so `import Capacitor` cannot resolve there.
        .target(
            name: "BackgroundAudio",
            dependencies: [
                .product(name: "BackgroundAudioCore", package: "BackgroundAudioCore"),
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios"
        )
    ]
)