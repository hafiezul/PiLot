import AppKit
import Foundation
import XCTest
@testable import PiLot

final class PromptContextTests: XCTestCase {
    func testTextFilesAndImagesBecomeOnePiPromptPayload() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let text = root.appending(path: "notes.txt")
        let image = root.appending(path: "screen.png")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("hello from file".utf8).write(to: text)
        let imageData = try XCTUnwrap(testPNG())
        try imageData.write(to: image)
        defer { try? FileManager.default.removeItem(at: root) }

        let context = PromptContext(attachments: [
            PromptAttachment(file: text),
            PromptAttachment(file: image),
        ])
        let prompt = try context.prepare(message: "Review this")

        XCTAssertEqual(prompt.message, "Review this\n\n--- Context file: notes.txt ---\nhello from file")
        XCTAssertEqual(prompt.images, [PiPromptImage(data: imageData, mimeType: "image/png")])
        XCTAssertEqual(prompt.rpcFields["message"] as? String, prompt.message)
        XCTAssertEqual(
            (prompt.rpcFields["images"] as? [[String: String]])?.first,
            ["type": "image", "data": imageData.base64EncodedString(), "mimeType": "image/png"]
        )
    }

    func testPastedImageUsesTheSamePiImagePayloadAsAFile() throws {
        let imageData = try XCTUnwrap(testPNG())
        let context = PromptContext(attachments: [
            PromptAttachment(imageData: imageData, mimeType: "image/png", name: "Pasted image"),
        ])

        let prompt = try context.prepare(message: "Describe it")

        XCTAssertEqual(prompt.message, "Describe it")
        XCTAssertEqual(prompt.images, [PiPromptImage(data: imageData, mimeType: "image/png")])
    }

    func testInvalidImageFailsClearly() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "broken-\(UUID().uuidString).png")
        try Data([0x89, 0x50]).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }

        XCTAssertThrowsError(try PromptContext(attachments: [PromptAttachment(file: file)]).prepare(message: "Keep me")) { error in
            XCTAssertEqual(error.localizedDescription, "\(file.lastPathComponent) is not a valid image.")
        }
    }

    func testUnsupportedContextFailsWithAnActionableMessage() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "archive-\(UUID().uuidString).zip")
        try Data([0, 1, 2]).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }

        XCTAssertThrowsError(try PromptContext(attachments: [PromptAttachment(file: file)]).prepare(message: "Keep me")) { error in
            XCTAssertEqual(error.localizedDescription, "\(file.lastPathComponent) is not a supported text file or image.")
        }
    }

    func testMissingContextFailsClearlyWithoutChangingTheDraftOrAttachments() {
        let missing = URL(fileURLWithPath: "/tmp/does-not-exist.txt")
        let attachment = PromptAttachment(file: missing)
        let context = PromptContext(attachments: [attachment])
        let draft = "Keep this draft"

        XCTAssertThrowsError(try context.prepare(message: draft)) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "does-not-exist.txt is missing. Remove it or choose the file again."
            )
        }
        XCTAssertEqual(draft, "Keep this draft")
        XCTAssertEqual(context.attachments, [attachment])
    }

    private func testPNG() -> Data? {
        let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: 1,
            pixelsHigh: 1,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 4,
            bitsPerPixel: 32
        )
        return bitmap?.representation(using: .png, properties: [:])
    }
}
