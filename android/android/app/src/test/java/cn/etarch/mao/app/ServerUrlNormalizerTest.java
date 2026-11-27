package cn.etarch.mao.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerUrlNormalizerTest {

    private static String normalize(String input) {
        return normalize(input, false);
    }

    private static String normalize(String input, boolean allowHttp) {
        ServerUrlNormalizer.Result result = ServerUrlNormalizer.normalize(input, allowHttp);
        assertTrue("expected ok for " + input + " but got " + result.error, result.ok);
        return result.baseUrl;
    }

    private static String error(String input) {
        return error(input, false);
    }

    private static String error(String input, boolean allowHttp) {
        ServerUrlNormalizer.Result result = ServerUrlNormalizer.normalize(input, allowHttp);
        assertFalse("expected error for " + input, result.ok);
        return result.error;
    }

    @Test
    public void acceptsRootAndApiSuffixes() {
        assertEquals("https://mao.example.com", normalize("mao.example.com"));
        assertEquals("https://mao.example.com", normalize("https://mao.example.com/"));
        assertEquals("https://mao.example.com", normalize("https://mao.example.com/api"));
        assertEquals("https://mao.example.com", normalize("https://mao.example.com/api/v1"));
        assertEquals("https://mao.example.com", normalize("https://mao.example.com/api/v1/"));
    }

    @Test
    public void rejectsSubPaths() {
        assertTrue(error("https://mao.example.com/mao").contains("站点根"));
        assertTrue(error("https://mao.example.com/mao/api/v1").contains("站点根"));
    }

    @Test
    public void httpNeedsAllowFlag() {
        assertEquals("http://10.0.0.8:8080", normalize("http://10.0.0.8:8080/api", true));
        assertTrue(error("http://10.0.0.8:8080").contains("HTTPS"));
    }

    @Test
    public void rejectsUnsupportedProtocolsAndCredentials() {
        assertTrue(error("ftp://mao.example.com").contains("不支持"));
        assertTrue(error("javascript:alert(1)").contains("不支持"));
        assertTrue(error("file:///tmp/x").contains("不支持"));
        assertTrue(error("https://user:pass@mao.example.com").contains("账号密码"));
        assertTrue(error("https://mao.example.com/?token=1").contains("查询参数"));
        assertTrue(error("https://mao.example.com/#x").contains("查询参数"));
        assertTrue(error("").contains("请填写"));
    }

    @Test
    public void lowercasesSchemeAndHostAndKeepsPort() {
        assertEquals("https://mao.example.com", normalize("HTTPS://MAO.EXAMPLE.COM"));
        assertEquals("https://mao.example.com:8443", normalize("https://mao.example.com:8443"));
        assertEquals("https://localhost:9080", normalize("localhost:9080"));
    }

    @Test
    public void stripsDefaultPorts() {
        assertEquals("https://mao.example.com", normalize("https://mao.example.com:443"));
        assertEquals("http://10.0.0.8", normalize("http://10.0.0.8:80", true));
        assertEquals("https://mao.example.com:80", normalize("https://mao.example.com:80"));
    }

    @Test
    public void rejectsOutOfRangePort() {
        assertTrue(error("https://mao.example.com:99999").contains("端口"));
        assertTrue(error("https://mao.example.com:0").contains("端口"));
    }

    @Test
    public void suggestsSchemeForMissingSlashes() {
        assertTrue(error("https:mao.example.com").contains("https://"));
        assertTrue(error("http:mao.example.com").contains("http://"));
    }

    @Test
    public void handlesIpv6() {
        assertEquals("https://[::1]:8443", normalize("https://[::1]:8443"));
    }
}