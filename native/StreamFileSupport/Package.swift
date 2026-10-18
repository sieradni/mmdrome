// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "StreamFileSupport",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "StreamFileSupport", targets: ["StreamFileSupport"])],
    dependencies: [.package(name: "BackgroundAudioCore", path: "../BackgroundAudioCore")],
    targets: [
        .target(name: "StreamFileSupport"),
        .testTarget(name: "StreamFileSupportTests", dependencies: ["StreamFileSupport", "BackgroundAudioCore"], resources: [.copy("Fixtures")])
    ])
