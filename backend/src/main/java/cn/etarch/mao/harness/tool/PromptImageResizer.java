package cn.etarch.mao.harness.tool;

import lombok.extern.slf4j.Slf4j;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.Iterator;
import java.util.Optional;

/**
 * Codex-aligned prompt image resize (high/auto limits).
 * Longest edge ≤ 2048 and ceil(w/32)*ceil(h/32) ≤ 2500.
 */
@Slf4j
public final class PromptImageResizer {

    public static final int PATCH_SIZE = 32;
    public static final int MAX_DIMENSION = 2048;
    public static final int MAX_PATCHES = 2500;
    public static final float JPEG_QUALITY = 0.85f;

    private PromptImageResizer() {
    }

    public record Size(int width, int height) {
    }

    public record Result(byte[] bytes, String mime, int width, int height, boolean resized) {
        public String toDataUri() {
            return "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(bytes);
        }
    }

    /**
     * Compute target pixel size under high/auto prompt limits.
     */
    public static Size computeTargetSize(int width, int height) {
        if (width <= 0 || height <= 0) {
            return new Size(Math.max(1, width), Math.max(1, height));
        }

        double w = width;
        double h = height;

        double maxSide = Math.max(w, h);
        if (maxSide > MAX_DIMENSION) {
            double scale = MAX_DIMENSION / maxSide;
            w = Math.floor(w * scale);
            h = Math.floor(h * scale);
            w = Math.max(1, w);
            h = Math.max(1, h);
        }

        int patchW = (int) Math.ceil(w / PATCH_SIZE);
        int patchH = (int) Math.ceil(h / PATCH_SIZE);
        if ((long) patchW * patchH > MAX_PATCHES) {
            double scale = Math.sqrt((double) MAX_PATCHES / ((long) patchW * patchH));
            int newPatchW = Math.max(1, (int) Math.floor(patchW * scale));
            int newPatchH = Math.max(1, (int) Math.floor(patchH * scale));
            while ((long) newPatchW * newPatchH > MAX_PATCHES) {
                if (newPatchW >= newPatchH && newPatchW > 1) {
                    newPatchW--;
                } else if (newPatchH > 1) {
                    newPatchH--;
                } else {
                    break;
                }
            }
            return new Size(newPatchW * PATCH_SIZE, newPatchH * PATCH_SIZE);
        }

        return new Size((int) Math.round(w), (int) Math.round(h));
    }

    public static boolean fitsPromptLimits(int width, int height) {
        if (width <= 0 || height <= 0) {
            return false;
        }
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
            return false;
        }
        long patches = (long) Math.ceil(width / (double) PATCH_SIZE)
                * (long) Math.ceil(height / (double) PATCH_SIZE);
        return patches <= MAX_PATCHES;
    }

    /**
     * Decode, optionally resize, and re-encode for LLM prompt use.
     * When already within limits, returns original bytes (no re-encode).
     */
    public static Result resizeForPrompt(byte[] input, String mimeHint) throws IOException {
        if (input == null || input.length == 0) {
            throw new IOException("Empty image bytes");
        }

        String detected = ImageFileSupport.detectMimeFromBytes(input)
                .or(() -> ImageFileSupport.normalizeMime(mimeHint).filter(m -> m.startsWith("image/")))
                .orElseThrow(() -> new IOException("Unsupported or invalid image content"));

        BufferedImage image = ImageIO.read(new ByteArrayInputStream(input));
        if (image == null) {
            throw new IOException("Failed to decode image (mime=" + detected + ")");
        }

        int srcW = image.getWidth();
        int srcH = image.getHeight();
        Size target = computeTargetSize(srcW, srcH);

        if (target.width() == srcW && target.height() == srcH && fitsPromptLimits(srcW, srcH)) {
            return new Result(input, detected, srcW, srcH, false);
        }

        BufferedImage resized = scaleImage(image, target.width(), target.height());
        EncodeSpec encode = encodeSpecFor(detected);
        byte[] outBytes = encodeImage(resized, encode);
        String outMime = encode.mime();

        // WebP write may be unavailable — fall back to PNG.
        if (outBytes == null && "image/webp".equals(encode.mime())) {
            outBytes = encodeImage(resized, EncodeSpec.forPng());
            outMime = "image/png";
        }
        if (outBytes == null) {
            throw new IOException("Failed to encode resized image as " + encode.mime());
        }

        return new Result(outBytes, outMime, target.width(), target.height(), true);
    }

    /**
     * Best-effort resize for data URIs / downloaded bytes. On failure returns empty.
     */
    public static Optional<Result> tryResizeForPrompt(byte[] input, String mimeHint) {
        try {
            return Optional.of(resizeForPrompt(input, mimeHint));
        } catch (Exception e) {
            log.warn("Prompt image resize failed: {}", e.getMessage());
            return Optional.empty();
        }
    }

    private static BufferedImage scaleImage(BufferedImage src, int width, int height) {
        int type = src.getColorModel().hasAlpha()
                ? BufferedImage.TYPE_INT_ARGB
                : BufferedImage.TYPE_INT_RGB;
        BufferedImage dst = new BufferedImage(width, height, type);
        Graphics2D g = dst.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.drawImage(src, 0, 0, width, height, null);
        } finally {
            g.dispose();
        }
        return dst;
    }

    private record EncodeSpec(String mime, String formatName, boolean useJpegQuality) {
        static EncodeSpec forJpeg() {
            return new EncodeSpec("image/jpeg", "jpg", true);
        }

        static EncodeSpec forPng() {
            return new EncodeSpec("image/png", "png", false);
        }

        static EncodeSpec forWebp() {
            return new EncodeSpec("image/webp", "webp", false);
        }
    }

    private static EncodeSpec encodeSpecFor(String mime) {
        return switch (ImageFileSupport.normalizeMime(mime).orElse("")) {
            case "image/jpeg" -> EncodeSpec.forJpeg();
            case "image/webp" -> EncodeSpec.forWebp();
            // GIF (and anything else): re-encode as PNG after flatten/resize
            default -> EncodeSpec.forPng();
        };
    }

    private static byte[] encodeImage(BufferedImage image, EncodeSpec spec) {
        try {
            if (spec.useJpegQuality()) {
                BufferedImage rgb = image;
                if (image.getColorModel().hasAlpha() || image.getType() != BufferedImage.TYPE_INT_RGB) {
                    rgb = new BufferedImage(image.getWidth(), image.getHeight(), BufferedImage.TYPE_INT_RGB);
                    Graphics2D g = rgb.createGraphics();
                    try {
                        g.drawImage(image, 0, 0, null);
                    } finally {
                        g.dispose();
                    }
                }
                return writeJpeg(rgb, JPEG_QUALITY);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (!ImageIO.write(image, spec.formatName(), out)) {
                return null;
            }
            return out.toByteArray();
        } catch (IOException e) {
            log.debug("Encode failed for {}", spec.mime(), e);
            return null;
        }
    }

    private static byte[] writeJpeg(BufferedImage image, float quality) throws IOException {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpg");
        if (!writers.hasNext()) {
            writers = ImageIO.getImageWritersByFormatName("jpeg");
        }
        if (!writers.hasNext()) {
            throw new IOException("No JPEG ImageWriter available");
        }
        ImageWriter writer = writers.next();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(out)) {
            writer.setOutput(ios);
            ImageWriteParam param = writer.getDefaultWriteParam();
            if (param.canWriteCompressed()) {
                param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                param.setCompressionQuality(quality);
            }
            writer.write(null, new IIOImage(image, null, null), param);
        } finally {
            writer.dispose();
        }
        return out.toByteArray();
    }
}
