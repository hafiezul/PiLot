import AppKit
import Foundation
import UniformTypeIdentifiers

struct PromptAttachment: Identifiable, Equatable {
    enum Source: Equatable {
        case file(URL)
        case image(Data, mimeType: String)
    }

    let id = UUID()
    let source: Source
    let name: String

    init(file: URL) {
        source = .file(file)
        name = file.lastPathComponent
    }

    init(imageData: Data, mimeType: String, name: String) {
        source = .image(imageData, mimeType: mimeType)
        self.name = name
    }

    var symbol: String {
        switch source {
        case .image: "photo"
        case .file(let file): UTType(filenameExtension: file.pathExtension)?.conforms(to: .image) == true ? "photo" : "doc.text"
        }
    }
}

struct PiPromptImage: Equatable {
    let data: Data
    let mimeType: String

    var rpcValue: [String: String] {
        ["type": "image", "data": data.base64EncodedString(), "mimeType": mimeType]
    }
}

struct PiPrompt {
    let message: String
    let images: [PiPromptImage]
    let displayMessage: String

    init(message: String, images: [PiPromptImage], displayMessage: String? = nil) {
        self.message = message
        self.images = images
        self.displayMessage = displayMessage ?? message
    }

    var rpcFields: [String: Any] {
        var fields: [String: Any] = ["message": message]
        if !images.isEmpty { fields["images"] = images.map(\.rpcValue) }
        return fields
    }
}

enum PromptContextError: LocalizedError {
    case missing(String)
    case unsupported(String)
    case invalidImage(String)
    case inaccessible(String)

    var errorDescription: String? {
        switch self {
        case .missing(let name): "\(name) is missing. Remove it or choose the file again."
        case .unsupported(let name): "\(name) is not a supported text file or image."
        case .invalidImage(let name): "\(name) is not a valid image."
        case .inaccessible(let name):
            "PiLot could not read \(name). Choose it again or allow access in System Settings > Privacy & Security > Files and Folders."
        }
    }
}

struct PromptContext {
    let attachments: [PromptAttachment]

    func prepare(message: String) throws -> PiPrompt {
        let displayMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        var message = displayMessage
        var images: [PiPromptImage] = []
        for attachment in attachments {
            switch attachment.source {
            case .image(let data, let mimeType):
                images.append(try image(data, mimeType: mimeType, name: attachment.name))
            case .file(let file):
                let type = UTType(filenameExtension: file.pathExtension)
                guard type?.conforms(to: .image) == true || type?.conforms(to: .text) == true || type == nil else {
                    throw PromptContextError.unsupported(attachment.name)
                }
                let data: Data
                do { data = try Data(contentsOf: file) }
                catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                    throw PromptContextError.missing(attachment.name)
                } catch {
                    throw PromptContextError.inaccessible(attachment.name)
                }
                if type?.conforms(to: .image) == true {
                    images.append(try image(data, mimeType: type?.preferredMIMEType ?? "application/octet-stream", name: attachment.name))
                } else if let text = String(data: data, encoding: .utf8) {
                    message += "\n\n--- Context file: \(attachment.name) ---\n\(text)"
                } else {
                    throw PromptContextError.unsupported(attachment.name)
                }
            }
        }
        return PiPrompt(message: message, images: images, displayMessage: displayMessage)
    }

    private func image(_ data: Data, mimeType: String, name: String) throws -> PiPromptImage {
        let supported = ["image/png", "image/jpeg", "image/gif", "image/webp"]
        guard supported.contains(mimeType), NSImage(data: data) != nil else {
            throw PromptContextError.invalidImage(name)
        }
        return PiPromptImage(data: data, mimeType: mimeType)
    }
}
