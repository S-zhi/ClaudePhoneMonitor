#!/usr/bin/env swift
import AppKit
import CoreImage.CIFilterBuiltins
import Foundation

let args = CommandLine.arguments
if args.count != 3 {
    fputs("Usage: render-qr.swift PAIRING_JSON OUTPUT_PNG\n", stderr)
    exit(2)
}

do {
    let inputURL = URL(fileURLWithPath: args[1])
    let outputURL = URL(fileURLWithPath: args[2])
    let raw = try Data(contentsOf: inputURL)
    guard
        let pairing = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
        let payload = pairing["qr_payload"] as? String,
        let payloadBytes = payload.data(using: .utf8)
    else { throw NSError(domain: "ClaudePhoneMonitor", code: 1, userInfo: [NSLocalizedDescriptionKey: "QR payload missing"]) }

    let filter = CIFilter.qrCodeGenerator()
    filter.message = payloadBytes
    filter.correctionLevel = "M"
    guard let image = filter.outputImage else { throw NSError(domain: "ClaudePhoneMonitor", code: 2) }
    let scaled = image.transformed(by: CGAffineTransform(scaleX: 9, y: 9))
    let context = CIContext(options: [.useSoftwareRenderer: true])
    guard let colorspace = CGColorSpace(name: CGColorSpace.sRGB),
          let data = context.pngRepresentation(of: scaled, format: .RGBA8, colorSpace: colorspace) else {
        throw NSError(domain: "ClaudePhoneMonitor", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not render QR PNG"])
    }
    try data.write(to: outputURL, options: .atomic)
    chmod(outputURL.path, 0o600)
} catch {
    fputs("QR rendering failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}
