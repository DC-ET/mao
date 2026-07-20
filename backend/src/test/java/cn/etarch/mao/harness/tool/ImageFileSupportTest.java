package cn.etarch.mao.harness.tool;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ImageFileSupportTest {

    @Test
    void resolveImageMimePrefersMagicBytesOverOctetStream() {
        byte[] jpeg = new byte[] {
                (byte) 0xFF, (byte) 0xD8, (byte) 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0
        };

        assertThat(ImageFileSupport.resolveImageMime(
                jpeg, "application/octet-stream", "/uploads/no-ext"))
                .contains("image/jpeg");
    }

    @Test
    void extensionForMimeAndNormalizeMime() {
        assertThat(ImageFileSupport.extensionForMime("image/png")).contains(".png");
        assertThat(ImageFileSupport.normalizeMime("image/jpeg; charset=binary"))
                .contains("image/jpeg");
        assertThat(ImageFileSupport.isImageMime("application/octet-stream")).isFalse();
    }
}
