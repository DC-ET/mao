package cn.etarch.mao.harness.mcp.crypto;

import cn.etarch.mao.common.exception.BusinessException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class McpSecretCipherTest {

    private final McpSecretCipher cipher = new McpSecretCipher("unit-test-secret");

    @Test
    void encryptThenDecryptRoundTrips() {
        String plaintext = "{\"API_KEY\":\"sk-test-123\",\"REGION\":\"cn-north-1\"}";
        String encrypted = cipher.encrypt(plaintext);
        assertNotEquals(plaintext, encrypted);
        assertEquals(plaintext, cipher.decrypt(encrypted));
    }

    @Test
    void encryptsWithRandomNonceSoCiphertextsDiffer() {
        String first = cipher.encrypt("same-value");
        String second = cipher.encrypt("same-value");
        assertNotEquals(first, second);
        assertEquals("same-value", cipher.decrypt(first));
        assertEquals("same-value", cipher.decrypt(second));
    }

    @Test
    void detectsTamperedCiphertext() {
        String encrypted = cipher.encrypt("sk-live-abc");
        // 篡改密文尾部（GCM tag 校验失败）
        String tampered = encrypted.substring(0, encrypted.length() - 4) + "AAAA";
        assertThrows(BusinessException.class, () -> cipher.decrypt(tampered));
    }

    @Test
    void decryptThrowsOnMalformedFormat() {
        assertThrows(BusinessException.class, () -> cipher.decrypt("no-colon-separator"));
        assertThrows(BusinessException.class, () -> cipher.decrypt(":"));
        assertThrows(BusinessException.class, () -> cipher.decrypt("not-base64:also-not-base64"));
    }

    @Test
    void nullAndEmptyValuesPassThroughUntouched() {
        assertNull(cipher.encrypt(null));
        assertNull(cipher.decrypt(null));
        assertEquals("", cipher.encrypt(""));
        assertEquals("", cipher.decrypt(""));
    }
}
