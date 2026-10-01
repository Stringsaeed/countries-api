import CryptoKit
import DeviceCheck
import Foundation

/// Uses a separate instance and key for each API environment.
actor CountriesAPIClient {
    enum ClientError: Error {
        case unsupportedDevice
        case invalidRequest
        case httpStatus(Int)
    }

    enum Language: String { case en, ar }

    private struct Challenge: Decodable { let challenge: String }
    private let baseURL: URL
    private let session: URLSession
    private let defaults: UserDefaults
    private let keyStorageName: String
    private var tail: Task<Void, Never>?

    init(baseURL: URL, defaults: UserDefaults = .standard) throws {
        guard baseURL.scheme == "https", baseURL.host != nil else {
            throw ClientError.invalidRequest
        }
        self.baseURL = baseURL
        self.defaults = defaults
        self.session = URLSession(configuration: .ephemeral)
        self.keyStorageName = "countries-api.app-attest.\(baseURL.absoluteString)"
    }

    /// Queue requests so App Attest counters reach the server in order.
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let previous = tail
        let task = Task {
            await previous?.value
            return try await self.send(request)
        }
        tail = Task { _ = await task.result }
        return try await task.value
    }

    func request(path: String, language: Language) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              url.scheme == baseURL.scheme, url.host == baseURL.host,
              url.port == baseURL.port else { throw ClientError.invalidRequest }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(language.rawValue, forHTTPHeaderField: "Accept-Language")
        return request
    }

    private func post<T: Encodable, R: Decodable>(_ path: String, body: T, response: R.Type) async throws -> R {
        let data = try await post(path, body: body)
        return try JSONDecoder().decode(R.self, from: data)
    }

    private func post<T: Encodable>(_ path: String, body: T) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidRequest }
        guard (200..<300).contains(response.statusCode) else { throw ClientError.httpStatus(response.statusCode) }
        return data
    }

    private func challenge(keyID: String, purpose: String) async throws -> String {
        try await post("v1/auth/challenge", body: ["keyId": keyID, "purpose": purpose], response: Challenge.self).challenge
    }

    private func enrolledKey() async throws -> String {
        let service = DCAppAttestService.shared
        guard service.isSupported else { throw ClientError.unsupportedDevice }
        if let keyID = defaults.string(forKey: keyStorageName) { return keyID }
        let keyID = try await service.generateKey()
        let challenge = try await challenge(keyID: keyID, purpose: "attestation")
        let hash = Data(SHA256.hash(data: Data(challenge.utf8)))
        let attestation = try await service.attestKey(keyID, clientDataHash: hash)
        _ = try await post("v1/auth/attest", body: ["keyId": keyID, "challenge": challenge, "attestation": attestation.base64EncodedString()])
        defaults.set(keyID, forKey: keyStorageName)
        return keyID
    }

    private func send(_ original: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard let url = original.url, url.scheme == baseURL.scheme,
              url.host == baseURL.host, url.port == baseURL.port,
              original.httpMethod == "GET", original.httpBody == nil else {
            throw ClientError.invalidRequest
        }
        let keyID = try await enrolledKey()
        for attempt in 0..<2 {
            let challenge = try await challenge(keyID: keyID, purpose: "assertion")
            var request = original
            // Keep an explicit application-level offline cache. Avoid issuing challenges for URLCache hits.
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let payload = [
                "countries-api:v1", "GET", url.absoluteString,
                request.value(forHTTPHeaderField: "Accept-Language") ?? "",
                request.value(forHTTPHeaderField: "If-None-Match") ?? "",
                challenge
            ].joined(separator: "\n")
            let hash = Data(SHA256.hash(data: Data(payload.utf8)))
            let assertion: Data
            do {
                assertion = try await DCAppAttestService.shared.generateAssertion(keyID, clientDataHash: hash)
            } catch {
                // Re-enroll only if Apple reports an invalid key. Do not create new keys for transient errors.
                let nsError = error as NSError
                if nsError.domain == DCError.errorDomain && nsError.code == DCError.invalidKey.rawValue {
                    defaults.removeObject(forKey: keyStorageName)
                }
                throw error
            }
            request.setValue(keyID, forHTTPHeaderField: "X-App-Attest-Key-Id")
            request.setValue(challenge, forHTTPHeaderField: "X-App-Attest-Challenge")
            request.setValue(assertion.base64EncodedString(), forHTTPHeaderField: "X-App-Attest-Assertion")
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse else { throw ClientError.invalidRequest }
            if response.statusCode == 401 && attempt == 0 { continue }
            guard (200..<300).contains(response.statusCode) || response.statusCode == 304 else {
                throw ClientError.httpStatus(response.statusCode)
            }
            return (data, response)
        }
        throw ClientError.httpStatus(401)
    }
}
