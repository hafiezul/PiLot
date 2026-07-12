// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "PiLot",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "PiLot", targets: ["PiLot"])],
    targets: [
        .executableTarget(name: "PiLot"),
        .testTarget(name: "PiLotTests", dependencies: ["PiLot"]),
    ]
)
