package cn.etarch.mao.weixin.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class WeixinMediaServiceTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void decodeAesKey_raw16BytesBase64() {
        byte[] key = new byte[16];
        for (int i = 0; i < 16; i++) {
            key[i] = (byte) i;
        }
        String encoded = Base64.getEncoder().encodeToString(key);
        assertArrayEquals(key, WeixinMediaService.decodeAesKey(encoded));
    }

    @Test
    void decodeAesKey_base64OfHexAscii() {
        String hex = "00112233445566778899aabbccddeeff";
        String encoded = Base64.getEncoder().encodeToString(hex.getBytes(StandardCharsets.US_ASCII));
        byte[] decoded = WeixinMediaService.decodeAesKey(encoded);
        assertNotNull(decoded);
        assertEquals(16, decoded.length);
        assertEquals(0x00, decoded[0] & 0xFF);
        assertEquals(0xFF, decoded[15] & 0xFF);
    }

    @Test
    void decodeAesKey_directHex() {
        byte[] decoded = WeixinMediaService.decodeAesKey("00112233445566778899aabbccddeeff");
        assertNotNull(decoded);
        assertEquals(16, decoded.length);
        assertEquals(0xAA, decoded[10] & 0xFF);
    }

    @Test
    void resolveAesKey_prefersImageItemAeskey() {
        ObjectNode imageItem = objectMapper.createObjectNode();
        imageItem.put("aeskey", "00112233445566778899aabbccddeeff");
        ObjectNode media = objectMapper.createObjectNode();
        media.put("aes_key", Base64.getEncoder().encodeToString(new byte[16]));

        byte[] key = WeixinMediaService.resolveAesKey(imageItem, media);
        assertNotNull(key);
        assertEquals(0x11, key[1] & 0xFF);
    }

    @Test
    void decryptAes128Ecb_roundTrip() throws Exception {
        byte[] key = "0123456789abcdef".getBytes(StandardCharsets.US_ASCII);
        byte[] plain = "hello-weixin-img!".getBytes(StandardCharsets.UTF_8);

        Cipher cipher = Cipher.getInstance("AES/ECB/PKCS5Padding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"));
        byte[] ciphertext = cipher.doFinal(plain);

        byte[] decrypted = WeixinMediaService.decryptAes128Ecb(ciphertext, key);
        assertArrayEquals(plain, decrypted);
    }
}
