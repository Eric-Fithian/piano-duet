import Foundation
import WebKit

struct NativeInferenceOrigin: Hashable, Sendable {
    let scheme: String
    let host: String
    let port: Int
}

@MainActor
final class NativeInferenceBridge: NSObject, WKScriptMessageHandlerWithReply {
    private let engine: any NativeInferenceEngine
    private let allowedOrigins: Set<NativeInferenceOrigin>
    private weak var webView: WKWebView?
    private var requests: [String: Task<Void, Never>] = [:]

    init(engine: any NativeInferenceEngine, webView: WKWebView, allowedOrigins: Set<NativeInferenceOrigin>) {
        self.engine = engine
        self.webView = webView
        self.allowedOrigins = allowedOrigins
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              allowedOrigins.contains(NativeInferenceOrigin(scheme: origin.protocol, host: origin.host, port: origin.port)) else {
            replyHandler(nil, NativeInferenceBridgeError.unauthorizedOrigin.localizedDescription)
            return
        }
        do {
            guard JSONSerialization.isValidJSONObject(message.body) else { throw NativeInferenceBridgeError.invalidRequest }
            let data = try JSONSerialization.data(withJSONObject: message.body)
            let envelope = try JSONDecoder().decode(NativeInferenceEnvelope.self, from: data)
            try envelope.validate()
            if envelope.action == .cancel {
                requests[envelope.target!]?.cancel()
                replyHandler(["cancelled": true], nil)
                return
            }
            let requestId = envelope.requestId!
            guard requests[requestId] == nil else { throw NativeInferenceBridgeError.duplicateRequest }
            requests[requestId] = Task {
                defer { requests.removeValue(forKey: requestId) }
                do {
                    let result = try await engine.handle(data) { progress in
                        try await self.sendProgress(progress, requestId: requestId)
                    }
                    try Task.checkCancellation()
                    let value = try JSONSerialization.jsonObject(with: result, options: [.fragmentsAllowed])
                    replyHandler(value, nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }
        } catch {
            replyHandler(nil, error.localizedDescription)
        }
    }

    private func sendProgress(_ data: Data, requestId: String) async throws {
        guard let webView else { throw NativeInferenceBridgeError.missingWebView }
        let progress = try JSONSerialization.jsonObject(with: data)
        guard progress is [String: Any] else { throw NativeInferenceBridgeError.invalidResponse }
        let detail = try JSONSerialization.data(withJSONObject: ["requestId": requestId, "progress": progress])
        guard let json = String(data: detail, encoding: .utf8) else { throw NativeInferenceBridgeError.invalidResponse }
        _ = try await webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('piano-inference-progress', {detail: \(json)}))")
    }
}
