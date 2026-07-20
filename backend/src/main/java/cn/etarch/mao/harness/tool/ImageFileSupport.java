package cn.etarch.mao.harness.tool;

import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Image file detection and validation for read_file.
 */
public final class ImageFileSupport {

    public static final long MAX_IMAGE_BYTES = 5L * 1024 * 1024;

    private static final Map<String, String> EXTENSION_TO_MIME = Map.of(
            ".png", "image/png",
            ".jpg", "image/jpeg",
            ".jpeg", "image/jpeg",
            ".gif", "image/gif",
            ".webp", "image/webp"
    );

    private ImageFileSupport() {
    }

    public static boolean isImagePath(String path) {
        return mimeFromPath(path).isPresent();
    }

    public static Optional<String> mimeFromPath(String path) {
        if (path == null || path.isBlank()) {
            return Optional.empty();
        }
        String lower = path.toLowerCase(Locale.ROOT);
        for (Map.Entry<String, String> entry : EXTENSION_TO_MIME.entrySet()) {
            if (lower.endsWith(entry.getKey())) {
                return Optional.of(entry.getValue());
            }
        }
        return Optional.empty();
    }

    public static Optional<String> mimeFromPath(Path path) {
        return path != null ? mimeFromPath(path.getFileName().toString()) : Optional.empty();
    }

    public static boolean isImageMime(String mime) {
        return normalizeMime(mime).map(m -> m.startsWith("image/")).orElse(false);
    }

    /**
     * Detect MIME from magic bytes. Returns empty if unknown.
     */
    public static Optional<String> detectMimeFromBytes(byte[] bytes) {
        if (bytes == null || bytes.length < 12) {
            return Optional.empty();
        }
        if (bytes[0] == (byte) 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) {
            return Optional.of("image/png");
        }
        if (bytes[0] == (byte) 0xFF && bytes[1] == (byte) 0xD8 && bytes[2] == (byte) 0xFF) {
            return Optional.of("image/jpeg");
        }
        if (bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46) {
            return Optional.of("image/gif");
        }
        if (bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46
                && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50) {
            return Optional.of("image/webp");
        }
        return Optional.empty();
    }

    /**
     * Resolve a usable image MIME for LLM/data-URI use.
     * Prefer magic bytes, then a declared image/* type, then path/URL extension.
     */
    public static Optional<String> resolveImageMime(byte[] bytes, String declaredMime, String pathOrUrl) {
        Optional<String> fromBytes = detectMimeFromBytes(bytes);
        if (fromBytes.isPresent()) {
            return fromBytes;
        }
        Optional<String> declared = normalizeMime(declaredMime).filter(m -> m.startsWith("image/"));
        if (declared.isPresent()) {
            return declared;
        }
        return mimeFromPath(pathOrUrl);
    }

    public static Optional<String> extensionForMime(String mime) {
        return normalizeMime(mime).flatMap(m -> switch (m) {
            case "image/png" -> Optional.of(".png");
            case "image/jpeg" -> Optional.of(".jpg");
            case "image/gif" -> Optional.of(".gif");
            case "image/webp" -> Optional.of(".webp");
            default -> Optional.empty();
        });
    }

    public static Optional<String> normalizeMime(String mime) {
        if (mime == null || mime.isBlank()) {
            return Optional.empty();
        }
        String normalized = mime.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return normalized.isEmpty() ? Optional.empty() : Optional.of(normalized);
    }

    public static String formatSize(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024) {
            return String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0);
        }
        return String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024.0));
    }
}
