import Foundation
import XCTest
@testable import PiLot

final class PiEngineTests: XCTestCase {
    func testLFDecoderRetainsIncompleteBytesAndOnlySplitsOnLF() throws {
        var decoder = LFJSONDecoder()
        XCTAssertTrue(try decoder.append(Data(#"{"text":"a"#.utf8)).isEmpty)

        let records = try decoder.append(Data("b\u{2028}c\"}\n".utf8))
        XCTAssertEqual(records.first?["text"] as? String, "ab\u{2028}c")
        XCTAssertTrue(decoder.buffer.isEmpty)
    }

    func testRuntimeLayoutUsesOnlyBundleRelativePaths() {
        let root = URL(fileURLWithPath: "/App/PiEngine")
        let layout = RuntimeLayout(root: root, architecture: "x64")
        XCTAssertEqual(layout.node.path, "/App/PiEngine/node-darwin-x64/bin/node")
        XCTAssertEqual(layout.cli.path, "/App/PiEngine/node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
    }
}
