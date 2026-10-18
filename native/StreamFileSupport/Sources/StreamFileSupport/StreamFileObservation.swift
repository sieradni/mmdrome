import AVFoundation

/// Each observation owns a NEW reader, so AVAudioFile's cached EOF cannot
/// freeze the growth decision. The engine schedules from this same reader.
public enum StreamFileObservation {
    public static func open(_ url: URL) -> AVAudioFile? {
        guard let file = try? AVAudioFile(forReading: url), file.length > 0,
              file.processingFormat.sampleRate > 0 else { return nil }
        return file
    }
}
