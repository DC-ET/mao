package cn.etarch.mao.weixin.service;

import com.fasterxml.jackson.databind.JsonNode;
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

    @Test
    void detectFileMime_pdfByMagicNumber() {
        assertEquals("application/pdf",
                WeixinMediaService.detectFileMime("%PDF-1.7".getBytes(StandardCharsets.US_ASCII), "unknown.bin"));
    }

    @Test
    void detectFileMime_pdfByExtension() {
        assertEquals("application/pdf",
                WeixinMediaService.detectFileMime(new byte[0], "report.PDF"));
    }

    @Test
    void detectFileMime_docxByExtension() {
        assertEquals("application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                WeixinMediaService.detectFileMime(new byte[0], "doc.docx"));
    }

    @Test
    void detectFileMime_unknownFallsBackToOctetStream() {
        assertEquals("application/octet-stream",
                WeixinMediaService.detectFileMime(new byte[0], "archive.xyz"));
    }

    @Test
    void resolveEncryptQueryParam_mediaLevel() {
        ObjectNode fileItem = objectMapper.createObjectNode();
        fileItem.putObject("media").put("encrypt_query_param", "media-param");
        assertEquals("media-param", WeixinMediaService.resolveEncryptQueryParam(fileItem));
    }

    @Test
    void resolveEncryptQueryParam_fallsBackToItemLevel() {
        ObjectNode fileItem = objectMapper.createObjectNode();
        fileItem.putObject("media");
        fileItem.put("encrypt_query_param", "item-param");
        assertEquals("item-param", WeixinMediaService.resolveEncryptQueryParam(fileItem));
    }

    @Test
    void resolveEncryptQueryParam_fallsBackToThumbMedia() {
        ObjectNode fileItem = objectMapper.createObjectNode();
        fileItem.putObject("thumb_media").put("encrypt_query_param", "thumb-param");
        assertEquals("thumb-param", WeixinMediaService.resolveEncryptQueryParam(fileItem));
    }

    @Test
    void resolveEncryptQueryParam_missingReturnsNull() {
        ObjectNode fileItem = objectMapper.createObjectNode();
        fileItem.putObject("media");
        assertEquals(null, WeixinMediaService.resolveEncryptQueryParam(fileItem));
    }

    @Test
    void resolveMediaNode_prefersMediaWithParam() {
        ObjectNode fileItem = objectMapper.createObjectNode();
        fileItem.putObject("media").put("encrypt_query_param", "media-param");
        fileItem.putObject("thumb_media").put("encrypt_query_param", "thumb-param");
        assertEquals("media-param",
                WeixinMediaService.resolveMediaNode(fileItem).get("encrypt_query_param").asText());
    }

    @Test
    void resolveMediaNode_fallsBackToThumbMediaWhenMediaIncomplete() {
        // media 节点存在但字段不完整（无 encrypt_query_param），有效参数位于 thumb_media
        ObjectNode fileItem = objectMapper.createObjectNode();
        fileItem.putObject("media").put("file_name", "x.pdf");
        String validKey = Base64.getEncoder().encodeToString(new byte[16]);
        fileItem.putObject("thumb_media").put("encrypt_query_param", "thumb-param")
                .put("aes_key", validKey);
        JsonNode node = WeixinMediaService.resolveMediaNode(fileItem);
        assertNotNull(node);
        assertEquals("thumb-param", node.get("encrypt_query_param").asText());
        // 参数与 AES key 同源：均应从 thumb_media 解析
        byte[] key = WeixinMediaService.resolveAesKey(fileItem, node);
        assertNotNull(key);
    }

    @Test
    void resolveAesKey_fallsBackToItemLevelAesKey() {
        ObjectNode fileItem = objectMapper.createObjectNode();
        fileItem.put("aes_key", Base64.getEncoder().encodeToString(new byte[16]));
        ObjectNode media = objectMapper.createObjectNode();
        byte[] key = WeixinMediaService.resolveAesKey(fileItem, media);
        assertNotNull(key);
        assertEquals(16, key.length);
    }

    @Test
    void resolveAesKey_prefersItemAeskeyOverItemAesKey() {
        ObjectNode fileItem = objectMapper.createObjectNode();
        fileItem.put("aeskey", "00112233445566778899aabbccddeeff");
        fileItem.put("aes_key", Base64.getEncoder().encodeToString(new byte[16]));
        byte[] key = WeixinMediaService.resolveAesKey(fileItem, null);
        assertNotNull(key);
        assertEquals(0x11, key[1] & 0xFF);
    }
}
