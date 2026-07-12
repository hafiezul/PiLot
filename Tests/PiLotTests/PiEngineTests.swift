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

    func testInterleavedToolsStayCorrelatedByCallID() throws {
        var state = PiSessionState()
        try state.apply(["type": "tool_execution_start", "toolCallId": "a", "toolName": "read", "args": [:]])
        try state.apply(["type": "tool_execution_start", "toolCallId": "b", "toolName": "bash", "args": [:]])
        try state.apply([
            "type": "tool_execution_update", "toolCallId": "a", "toolName": "read", "args": [:],
            "partialResult": ["content": [["type": "text", "text": "A output"]]],
        ])
        try state.apply([
            "type": "tool_execution_end", "toolCallId": "b", "toolName": "bash", "isError": false,
            "result": ["content": [["type": "text", "text": "B output"]]],
        ])

        XCTAssertEqual(state.tools["a"]?.output, "A output")
        XCTAssertEqual(state.tools["a"]?.status, .running)
        XCTAssertEqual(state.tools["b"]?.output, "B output")
        XCTAssertEqual(state.tools["b"]?.status, .succeeded)
    }

    func testOnlyAgentSettledCompletesRun() throws {
        var state = PiSessionState()
        try state.apply(["type": "agent_start"])
        try state.apply(["type": "agent_end", "messages": [], "willRetry": false])
        XCTAssertTrue(state.isRunning)
        XCTAssertFalse(state.isSettled)

        try state.apply(["type": "agent_settled"])
        XCTAssertFalse(state.isRunning)
        XCTAssertTrue(state.isSettled)
    }

    func testMalformedOrUnknownProtocolDataFailsTheSession() {
        var decoder = LFJSONDecoder()
        XCTAssertThrowsError(try decoder.append(Data("not-json\n".utf8)))

        var state = PiSessionState()
        XCTAssertThrowsError(try state.apply(["type": "future_event"]))
    }

    func testRuntimeLayoutUsesOnlyBundleRelativePaths() {
        let root = URL(fileURLWithPath: "/App/PiEngine")
        let layout = RuntimeLayout(root: root, architecture: "x64")
        XCTAssertEqual(layout.node.path, "/App/PiEngine/node-darwin-x64/bin/node")
        XCTAssertEqual(layout.cli.path, "/App/PiEngine/node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
    }
}
