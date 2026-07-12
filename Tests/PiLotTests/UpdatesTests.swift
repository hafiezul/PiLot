import XCTest
@testable import PiLot

final class UpdatesTests: XCTestCase {
    func testReleaseMetadataDecodesAndReportsANewerVersion() throws {
        let metadata = try JSONDecoder().decode(
            UpdateRelease.self,
            from: Data(#"{"version":"0.2.0","releaseNotes":"Manual update available."}"#.utf8)
        )

        XCTAssertEqual(metadata.version, "0.2.0")
        XCTAssertEqual(metadata.releaseNotes, "Manual update available.")
        XCTAssertTrue(metadata.isNewer(than: "0.1.9"))
        XCTAssertFalse(metadata.isNewer(than: "0.2.0"))
        XCTAssertFalse(metadata.isNewer(than: "0.3.0"))
    }

    func testVersionComparisonHandlesDifferentComponentCounts() {
        XCTAssertTrue(UpdateRelease(version: "1.0.1", releaseNotes: "").isNewer(than: "1.0"))
        XCTAssertFalse(UpdateRelease(version: "1.0", releaseNotes: "").isNewer(than: "1.0.0"))
        XCTAssertFalse(UpdateRelease(version: "not-a-version", releaseNotes: "").isNewer(than: "1.0"))
        XCTAssertFalse(UpdateRelease(version: String(repeating: "9", count: 100), releaseNotes: "").isNewer(than: "1.0"))
    }
}
