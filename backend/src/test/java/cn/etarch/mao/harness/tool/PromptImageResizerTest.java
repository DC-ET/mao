package cn.etarch.mao.harness.tool;

import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;

import static org.assertj.core.api.Assertions.assertThat;

class PromptImageResizerTest {

    @Test
    void computeTargetSizeShrinks2048SquareTo1600ForPatchBudget() {
        PromptImageResizer.Size size = PromptImageResizer.computeTargetSize(2048, 2048);
        assertThat(size.width()).isEqualTo(1600);
        assertThat(size.height()).isEqualTo(1600);
        assertThat(PromptImageResizer.fitsPromptLimits(1600, 1600)).isTrue();
    }

    @Test
    void computeTargetSizeLeavesSmallImagesUnchanged() {
        PromptImageResizer.Size size = PromptImageResizer.computeTargetSize(32, 24);
        assertThat(size.width()).isEqualTo(32);
        assertThat(size.height()).isEqualTo(24);
        assertThat(PromptImageResizer.fitsPromptLimits(32, 24)).isTrue();
    }

    @Test
    void computeTargetSizeFirstCapsLongestEdgeThenPatches() {
        // 4096×2048 → longest edge to 2048 → 2048×1024 (patches 64×32=2048 ≤ 2500)
        PromptImageResizer.Size size = PromptImageResizer.computeTargetSize(4096, 2048);
        assertThat(size.width()).isEqualTo(2048);
        assertThat(size.height()).isEqualTo(1024);
        assertThat(PromptImageResizer.fitsPromptLimits(size.width(), size.height())).isTrue();
    }

    @Test
    void computeTargetSizeCapsOversizedSquareViaDimensionThenPatches() {
        // 4000×4000 → first to 2048×2048 → then patch budget to 1600×1600
        PromptImageResizer.Size size = PromptImageResizer.computeTargetSize(4000, 4000);
        assertThat(size.width()).isEqualTo(1600);
        assertThat(size.height()).isEqualTo(1600);
    }

    @Test
    void resizeForPromptIsNoOpForSmallPng() throws Exception {
        byte[] png = writePng(64, 48);
        PromptImageResizer.Result result = PromptImageResizer.resizeForPrompt(png, "image/png");
        assertThat(result.resized()).isFalse();
        assertThat(result.width()).isEqualTo(64);
        assertThat(result.height()).isEqualTo(48);
        assertThat(result.bytes()).isEqualTo(png);
        assertThat(result.mime()).isEqualTo("image/png");
    }

    @Test
    void resizeForPromptShrinksLargePng() throws Exception {
        byte[] png = writePng(2048, 2048);
        PromptImageResizer.Result result = PromptImageResizer.resizeForPrompt(png, "image/png");
        assertThat(result.resized()).isTrue();
        assertThat(result.width()).isEqualTo(1600);
        assertThat(result.height()).isEqualTo(1600);
        assertThat(result.mime()).isEqualTo("image/png");
        assertThat(result.bytes().length).isLessThan(png.length);
        assertThat(result.toDataUri()).startsWith("data:image/png;base64,");
    }

    @Test
    void resizeForPromptReencodesJpegAtQuality85WhenResized() throws Exception {
        byte[] jpeg = writeJpeg(3000, 2000);
        PromptImageResizer.Result result = PromptImageResizer.resizeForPrompt(jpeg, "image/jpeg");
        assertThat(result.resized()).isTrue();
        assertThat(result.mime()).isEqualTo("image/jpeg");
        assertThat(result.width()).isLessThanOrEqualTo(PromptImageResizer.MAX_DIMENSION);
        assertThat(result.height()).isLessThanOrEqualTo(PromptImageResizer.MAX_DIMENSION);
        assertThat(PromptImageResizer.fitsPromptLimits(result.width(), result.height())).isTrue();
        assertThat(ImageFileSupport.detectMimeFromBytes(result.bytes())).contains("image/jpeg");
    }

    private static byte[] writePng(int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        g.setColor(Color.BLUE);
        g.fillRect(0, 0, width, height);
        g.dispose();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static byte[] writeJpeg(int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        g.setColor(Color.GREEN);
        g.fillRect(0, 0, width, height);
        g.dispose();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "jpg", out);
        return out.toByteArray();
    }
}
