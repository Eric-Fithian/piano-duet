import Foundation

enum NativeInferenceAction: String, Decodable, Sendable {
    case open, run, close, cancel
}

enum NativeInferenceModel: String, Decodable, Sendable {
    case aria
    case liveTranscription = "live-transcription"
    case phraseTranscription = "phrase-transcription"
    case recordingTranscription = "recording-transcription"
    case midiToScore = "midi-to-score"
}

struct NativeInferenceEnvelope: Decodable, Sendable {
    let action: NativeInferenceAction
    let requestId: String?
    let target: String?
    let model: NativeInferenceModel?
    let session: String?
    let hasInput: Bool

    enum CodingKeys: String, CodingKey { case action, requestId, target, model, session, input }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        action = try container.decode(NativeInferenceAction.self, forKey: .action)
        requestId = try container.decodeIfPresent(String.self, forKey: .requestId)
        target = try container.decodeIfPresent(String.self, forKey: .target)
        model = try container.decodeIfPresent(NativeInferenceModel.self, forKey: .model)
        session = try container.decodeIfPresent(String.self, forKey: .session)
        hasInput = try container.contains(.input) && !container.decodeNil(forKey: .input)
    }

    func validate() throws {
        switch action {
        case .cancel:
            guard let target, UUID(uuidString: target) != nil else {
                throw NativeInferenceBridgeError.invalidRequest
            }
        case .open:
            guard let requestId, UUID(uuidString: requestId) != nil else {
                throw NativeInferenceBridgeError.invalidRequest
            }
            guard model != nil else { throw NativeInferenceBridgeError.invalidRequest }
        case .run, .close:
            guard let requestId, UUID(uuidString: requestId) != nil, let session, !session.isEmpty, session.count <= 256 else {
                throw NativeInferenceBridgeError.invalidRequest
            }
            if action == .run && !hasInput { throw NativeInferenceBridgeError.invalidRequest }
        }
    }
}

enum NativeInferenceBridgeError: LocalizedError {
    case invalidRequest
    case duplicateRequest
    case unauthorizedOrigin
    case invalidResponse
    case missingWebView

    var errorDescription: String? {
        switch self {
        case .invalidRequest: "Invalid native inference request"
        case .duplicateRequest: "A native inference request with that ID is already running"
        case .unauthorizedOrigin: "Native inference is unavailable to this page"
        case .invalidResponse: "Native inference returned invalid JSON"
        case .missingWebView: "The inference page is no longer available"
        }
    }
}

protocol NativeInferenceEngine: Sendable {
    func handle(_ request: Data, progress: @escaping @Sendable (Data) async throws -> Void) async throws -> Data
}
