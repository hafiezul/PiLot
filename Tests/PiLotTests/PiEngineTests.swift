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

    func testLongStreamingBatchesCoalesceTextWithoutReorderingActivity() throws {
        let deltas = (0..<10_000).map { index in
            ["type": "message_update", "assistantMessageEvent": ["type": "text_delta", "delta": "\(index),"]]
        }
        let tool: [String: Any] = ["type": "tool_execution_start", "toolCallId": "read", "toolName": "read", "args": [:]]
        let decoder = RPCRecordDecoder()
        var firstBatch = true
        for record in deltas + [tool] + deltas {
            let data = try JSONSerialization.data(withJSONObject: record) + Data([0x0A])
            XCTAssertEqual(try decoder.append(data), firstBatch)
            firstBatch = false
        }
        let records = decoder.drain()

        XCTAssertEqual(records.count, 3)
        var state = PiSessionState()
        try records.forEach { try state.apply($0) }
        XCTAssertEqual(state.assistantText, (0..<10_000).map { "\($0)," }.joined() + (0..<10_000).map { "\($0)," }.joined())
        XCTAssertEqual(state.timelineItems, [.tool("read")])
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

    func testDialogRequestsRemainChronologicalAndExposeOnlyProtocolChoices() throws {
        var state = PiSessionState()
        try state.apply([
            "type": "extension_ui_request", "id": "gate", "method": "select",
            "title": "Allow command?", "options": ["Allow once", "Block"], "timeout": 10_000,
        ])
        try state.apply([
            "type": "extension_ui_request", "id": "question", "method": "input",
            "title": "Why?", "placeholder": "Reason",
        ])

        try state.apply(["type": "tool_execution_start", "toolCallId": "after", "toolName": "read"])

        XCTAssertEqual(state.interruptions.map(\.id), ["gate", "question"])
        XCTAssertEqual(state.timelineItems.map(\.id), ["interruption:gate", "interruption:question", "tool:after"])
        XCTAssertEqual(state.activeInterruptions.map(\.id), ["gate", "question"])
        XCTAssertEqual(state.interruptions[0].options, ["Allow once", "Block"])
        XCTAssertEqual(state.interruptions[0].timeoutMilliseconds, 10_000)
        XCTAssertTrue(state.isWaitingForInput)
    }

    func testFireAndForgetExtensionUIIsNotWaitingAndUnknownMethodsFail() throws {
        var state = PiSessionState()
        try state.apply([
            "type": "extension_ui_request", "id": "notice", "method": "notify",
            "message": "Done", "notifyType": "info",
        ])

        XCTAssertFalse(state.isWaitingForInput)
        XCTAssertTrue(state.interruptions.isEmpty)
        XCTAssertThrowsError(try state.apply([
            "type": "extension_ui_request", "id": "future", "method": "customDialog",
        ]))
    }

    func testInterruptionResponsesUseExactRPCPayloadsAndResolveWaitingState() throws {
        var state = PiSessionState()
        try state.apply([
            "type": "extension_ui_request", "id": "gate", "method": "select",
            "title": "Allow command?", "options": ["Allow once", "Block"],
        ])

        XCTAssertThrowsError(try state.resolveInterruption(id: "gate", response: .value("Always allow")))
        let payload = try state.resolveInterruption(id: "gate", response: .value("Allow once"))

        XCTAssertEqual(payload["type"] as? String, "extension_ui_response")
        XCTAssertEqual(payload["id"] as? String, "gate")
        XCTAssertEqual(payload["value"] as? String, "Allow once")
        XCTAssertFalse(state.isWaitingForInput)
        XCTAssertEqual(state.interruptions[0].resolution, .answered)
    }

    func testInterruptionCancellationAndTimeoutEndWaitingWithoutInventingAnswers() throws {
        var state = PiSessionState()
        try state.apply([
            "type": "extension_ui_request", "id": "confirm", "method": "confirm",
            "title": "Continue?", "message": "Choose whether to continue.",
        ])
        try state.apply([
            "type": "extension_ui_request", "id": "input", "method": "input",
            "title": "Reason", "timeout": 100,
        ])

        let cancellation = try state.resolveInterruption(id: "confirm", response: .cancelled)
        XCTAssertEqual(cancellation["cancelled"] as? Bool, true)
        XCTAssertTrue(state.timeoutInterruption(id: "input"))
        XCTAssertEqual(state.interruptions.map(\.resolution), [.cancelled, .timedOut])
        XCTAssertFalse(state.isWaitingForInput)
    }

    func testQueuedWorkPreservesPiSubmissionOrderUntilDelivered() throws {
        var state = PiSessionState()
        try state.apply([
            "type": "queue_update",
            "steering": ["first steer", "second steer"],
            "followUp": ["first follow-up", "second follow-up"],
        ])

        XCTAssertEqual(state.steeringQueue, ["first steer", "second steer"])
        XCTAssertEqual(state.followUpQueue, ["first follow-up", "second follow-up"])

        try state.apply([
            "type": "queue_update",
            "steering": ["second steer"],
            "followUp": ["first follow-up", "second follow-up"],
        ])
        XCTAssertEqual(state.steeringQueue, ["second steer"])
    }

    func testRetryAndCompactionRemainRunningUntilAgentSettles() throws {
        var state = PiSessionState()
        try state.apply(["type": "agent_start"])
        try state.apply([
            "type": "auto_retry_start", "attempt": 1, "maxAttempts": 3,
            "delayMs": 500, "errorMessage": "Rate limited",
        ])
        XCTAssertTrue(state.isRunning)
        XCTAssertTrue(state.isRetrying)

        try state.apply(["type": "auto_retry_end", "success": true, "attempt": 1])
        try state.apply(["type": "compaction_start", "reason": "threshold"])
        XCTAssertTrue(state.isRunning)
        XCTAssertFalse(state.isRetrying)
        XCTAssertTrue(state.isCompacting)

        try state.apply([
            "type": "compaction_end", "reason": "threshold", "aborted": false,
            "willRetry": true, "result": ["summary": "shorter"],
        ])
        XCTAssertTrue(state.isRunning)
        XCTAssertFalse(state.isCompacting)
        XCTAssertFalse(state.isSettled)

        try state.apply(["type": "agent_settled"])
        XCTAssertFalse(state.isRunning)
        XCTAssertTrue(state.isSettled)
    }

    func testExistingPiCommandsKeepSemanticsAndIsolateMalformedResources() {
        var state = PiSessionState()
        state.loadCommands([
            [
                "name": "review", "description": "Review changes", "source": "prompt",
                "sourceInfo": ["path": "/project/.pi/prompts/review.md", "scope": "project", "source": "local", "origin": "top-level"],
            ],
            ["name": "broken", "source": "future"],
            [
                "name": "skill:check", "source": "skill",
                "sourceInfo": ["path": "/user/skills/check/SKILL.md", "scope": "user", "source": "local", "origin": "top-level"],
            ],
        ])

        XCTAssertEqual(state.commands.map(\.invocation), ["/review", "/skill:check"])
        XCTAssertEqual(state.commands.first?.scope, "project")
        XCTAssertEqual(state.resourceDiagnostics.filter { $0.state == .compatible }.count, 2)
        XCTAssertTrue(state.resourceDiagnostics.first { $0.state == .degraded }?.consequence.contains("skipped") == true)
    }

    func testRichToolDataUsesGenericPresentationAndOneDiagnosticPerSurface() throws {
        var state = PiSessionState()
        let start: [String: Any] = [
            "type": "tool_execution_start", "toolCallId": "rich-1", "toolName": "custom_tool",
            "args": ["query": "Pi resources"],
        ]
        try state.apply(start)
        try state.apply([
            "type": "tool_execution_update", "toolCallId": "rich-1", "toolName": "custom_tool",
            "partialResult": [
                "content": [["type": "text", "text": "Working"], ["type": "image", "mimeType": "image/png"]],
                "details": ["progress": 50],
            ],
        ])
        try state.apply([
            "type": "tool_execution_end", "toolCallId": "rich-1", "toolName": "custom_tool", "isError": false,
            "result": ["content": [["type": "text", "text": "Done"]], "details": ["items": 2]],
        ])

        XCTAssertTrue(state.tools["rich-1"]?.arguments.contains("Pi resources") == true)
        XCTAssertEqual(state.tools["rich-1"]?.output, "Done")
        XCTAssertTrue(state.tools["rich-1"]?.details.contains("items") == true)
        XCTAssertEqual(state.resourceDiagnostics.filter { $0.surface == "tool:custom_tool" }.count, 1)
    }

    func testExtensionFailuresAndRPCPresentationDegradeIndependently() throws {
        var state = PiSessionState()
        try state.apply([
            "type": "extension_error", "extensionPath": "/user/extensions/example.ts",
            "event": "tool_call", "error": "failed hook",
        ])
        try state.apply([
            "type": "extension_ui_request", "id": "widget", "method": "setWidget",
            "widgetKey": "example", "widgetLines": ["Count: 2"],
        ])

        XCTAssertEqual(state.resourceDiagnostics.count, 1)
        XCTAssertEqual(state.extensionPresentations.first?.title, "setWidget")
        XCTAssertTrue(state.extensionPresentations.first?.content.contains("Count: 2") == true)
    }

    func testMalformedOrUnknownProtocolDataFailsTheSession() {
        var decoder = LFJSONDecoder()
        XCTAssertThrowsError(try decoder.append(Data("not-json\n".utf8)))

        var state = PiSessionState()
        XCTAssertThrowsError(try state.apply(["type": "future_event"]))
    }

    func testBusyPromptDeliveryUsesPiStreamingSemantics() {
        let prompt = PiPrompt(message: "next", images: [])

        XCTAssertEqual(prompt.rpcFields(delivery: .steer)["streamingBehavior"] as? String, "steer")
        XCTAssertEqual(prompt.rpcFields(delivery: .followUp)["streamingBehavior"] as? String, "followUp")
    }

    func testModelsReportWhetherTheyAcceptImageContext() throws {
        let textOnly = try XCTUnwrap(PiModel([
            "id": "text", "provider": "test", "input": ["text"],
        ]))
        let vision = try XCTUnwrap(PiModel([
            "id": "vision", "provider": "test", "input": ["text", "image"],
        ]))

        XCTAssertFalse(textOnly.supportsImages)
        XCTAssertTrue(vision.supportsImages)
    }

    func testRuntimeLayoutUsesOnlyBundleRelativePaths() {
        let root = URL(fileURLWithPath: "/App/PiEngine")
        let layout = RuntimeLayout(root: root, architecture: "x64")
        XCTAssertEqual(layout.node.path, "/App/PiEngine/node-darwin-x64/bin/node")
        XCTAssertEqual(layout.cli.path, "/App/PiEngine/node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
    }
}
