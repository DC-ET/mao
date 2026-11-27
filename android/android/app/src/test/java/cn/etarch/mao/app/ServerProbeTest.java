package cn.etarch.mao.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerProbeTest {

    @Test
    public void healthBody() {
        assertTrue(ServerProbe.isHealthBody("{\"code\":0,\"data\":{\"status\":\"UP\"}}"));
        assertTrue(ServerProbe.isHealthBody("{\"status\":\"UP\"}"));
        assertTrue(ServerProbe.isHealthBody("{ \"status\" : \"UP\" }"));
        assertFalse(ServerProbe.isHealthBody("{\"code\":0}"));
        assertFalse(ServerProbe.isHealthBody("{\"status\":\"DOWN\"}"));
        assertFalse(ServerProbe.isHealthBody(""));
    }

    @Test
    public void describeError() {
        assertEquals("域名解析失败", ServerProbe.describeError("DNS"));
        assertEquals("连接超时", ServerProbe.describeError("TIMEOUT"));
        assertEquals("TLS 证书校验失败", ServerProbe.describeError("TLS"));
        assertEquals("该地址不是可识别的 Mao 站点", ServerProbe.describeError("NOT_MAO"));
        assertEquals("站点返回 HTTP 404", ServerProbe.describeError("HTTP_404"));
        assertEquals("CUSTOM", ServerProbe.describeError("CUSTOM"));
        assertEquals("未知错误", ServerProbe.describeError(null));
    }

    @Test
    public void versionBody() {
        assertTrue(ServerProbe.isVersionBody("{\"version\":\"0.0.1\",\"buildTime\":\"x\"}"));
        assertFalse(ServerProbe.isVersionBody("{\"version\":\"\"}"));
        assertFalse(ServerProbe.isVersionBody("not json"));
        assertFalse(ServerProbe.isVersionBody(null));
    }

    @Test
    public void maoHome() {
        assertTrue(ServerProbe.isMaoHome("<html><head><title>Mao</title></head></html>"));
        assertTrue(ServerProbe.isMaoHome("<div id=\"app\"></div>"));
        assertTrue(ServerProbe.isMaoHome("<div id='app'></div>"));
        assertFalse(ServerProbe.isMaoHome("<html><title>Other</title></html>"));
    }
}