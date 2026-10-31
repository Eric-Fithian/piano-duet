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
        let buffer = try JSONDecoder().decode(NativeFloat32Buffer.self, from: Data(#"{"$type":"float32-le","data":"AACAPwAAAL8AAACA"}"#.utf8))
        precondition(buffer.values.map(\.bitPattern) == ([1.0, -0.5, -0.0] as [Float]).map(\.bitPattern))
        let encoded = try JSONEncoder().encode(buffer)
        let decoded = try JSONDecoder().decode(NativeFloat32Buffer.self, from: encoded)
        precondition(decoded.values.map(\.bitPattern) == buffer.values.map(\.bitPattern))
        for body in [
            #"{"$type":"float32-le","data":"AA=="}"#,
            #"{"$type":"float32-le","data":"not base64"}"#,
            #"{"$type":"float32-be","data":"AACAPw=="}"#,
            #"{"$type":"float32-le","data":"AADAfw=="}"#,
        ] {
            do {
                _ = try JSONDecoder().decode(NativeFloat32Buffer.self, from: Data(body.utf8))
                fatalError("An invalid native float buffer was accepted: \(body)")
            } catch {
                continue
            }
        }
        do {
            _ = try JSONEncoder().encode(NativeFloat32Buffer(values: [.infinity]))
            fatalError("A non-finite native float buffer was encoded")
        } catch {
            precondition(error is EncodingError)
        }
        print("Native inference request validation passed")
    }
}
