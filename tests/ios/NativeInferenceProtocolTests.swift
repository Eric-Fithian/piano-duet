import Foundation

@main
struct NativeInferenceProtocolTests {
    static func main() throws {
        let id = "9cfb60dc-a9f7-4e10-9b04-033934f96d9b"
        for body in [
            "{\"action\":\"open\",\"requestId\":\"\(id)\",\"model\":\"aria\"}",
            "{\"action\":\"run\",\"requestId\":\"\(id)\",\"session\":\"one\",\"input\":{}}",
            "{\"action\":\"close\",\"requestId\":\"\(id)\",\"session\":\"one\"}",
            "{\"action\":\"cancel\",\"target\":\"\(id)\"}",
        ] {
            try JSONDecoder().decode(NativeInferenceEnvelope.self, from: Data(body.utf8)).validate()
        }
        for body in [
            "{\"action\":\"open\",\"requestId\":\"\(id)\"}",
            "{\"action\":\"open\",\"requestId\":\"bad\",\"model\":\"aria\"}",
            "{\"action\":\"open\",\"requestId\":\"\(id)\",\"model\":\"unknown\"}",
            "{\"action\":\"run\",\"requestId\":\"\(id)\",\"session\":\"one\"}",
            "{\"action\":\"close\",\"requestId\":\"\(id)\",\"session\":\"\"}",
            "{\"action\":\"cancel\",\"target\":\"bad\"}",
        ] {
            do {
                try JSONDecoder().decode(NativeInferenceEnvelope.self, from: Data(body.utf8)).validate()
                fatalError("An invalid native request was accepted: \(body)")
            } catch {
                continue
            }
        }
        print("Native inference request validation passed")
    }
}
