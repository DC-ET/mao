package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.tool.WeixinChannelTool;
import cn.etarch.mao.weixin.service.WeixinMediaToolSupport;
import cn.etarch.mao.weixin.service.WeixinMediaUploadService;
import cn.etarch.mao.weixin.service.WeixinSendService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SendWechatImageToolTest {

    @Mock
    private WeixinMediaToolSupport toolSupport;
    @Mock
    private WeixinMediaUploadService uploadService;
    @Mock
    private WeixinSendService sendService;

    private SendWechatImageTool tool;
    private final ObjectMapper objectMapper = new ObjectMapper();

    private static final byte[] PNG_BYTES = new byte[]{
            0x00, (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00
    };
    private static final byte[] JUNK_BYTES = new byte[]{
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B
    };

    @BeforeEach
    void setUp() {
        tool = new SendWechatImageTool(objectMapper, toolSupport, uploadService, sendService);
        when(toolSupport.errorJson(anyString())).thenAnswer(inv ->
                "{\"error\":\"" + inv.getArgument(0) + "\"}");
    }

    @Test
    void implementsWeixinChannelTool() {
        assertThat(tool).isInstanceOf(WeixinChannelTool.class);
    }

    @Test
    void missingImageParam() throws Exception {
        String result = tool.execute("{}", 1L, 100L, "/ws");
        assertThat(result).contains("\"error\"");
        assertThat(result).contains("image");
    }

    @Test
    void blankImageParam() throws Exception {
        String result = tool.execute("{\"image\":\"\"}", 1L, 100L, "/ws");
        assertThat(result).contains("\"error\"");
    }

    @Test
    void noResolvableTarget() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.empty());
        String result = tool.execute("{\"image\":\"/tmp/a.png\"}", 1L, 100L, "/ws");
        assertThat(result).contains("无法解析微信收件人");
    }

    @Test
    void loadBytesFailure() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.of(target()));
        when(toolSupport.loadBytes("/tmp/a.png", "/ws", SendWechatImageTool.MAX_IMAGE_BYTES))
                .thenThrow(new IllegalArgumentException("文件过大（1.5 MB），上限 20.0 MB"));

        String result = tool.execute("{\"image\":\"/tmp/a.png\"}", 1L, 100L, "/ws");
        assertThat(result).contains("读取图片失败");
        assertThat(result).contains("文件过大");
    }

    @Test
    void unsupportedImageFormat() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.of(target()));
        when(toolSupport.loadBytes("/tmp/a.bmp", "/ws", SendWechatImageTool.MAX_IMAGE_BYTES))
                .thenReturn(JUNK_BYTES);

        String result = tool.execute("{\"image\":\"/tmp/a.bmp\"}", 1L, 100L, "/ws");
        assertThat(result).contains("不支持的图片格式");
    }

    @Test
    void uploadFailure() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.of(target()));
        when(toolSupport.loadBytes("/tmp/a.png", "/ws", SendWechatImageTool.MAX_IMAGE_BYTES))
                .thenReturn(PNG_BYTES);
        when(uploadService.uploadImage(any(), anyString(), any(byte[].class)))
                .thenReturn(Optional.empty());

        String result = tool.execute("{\"image\":\"/tmp/a.png\"}", 1L, 100L, "/ws");
        assertThat(result).contains("上传微信 CDN 失败");
    }

    @Test
    void sendFailure() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.of(target()));
        when(toolSupport.loadBytes("/tmp/a.png", "/ws", SendWechatImageTool.MAX_IMAGE_BYTES))
                .thenReturn(PNG_BYTES);
        when(uploadService.uploadImage(any(), anyString(), any(byte[].class)))
                .thenReturn(Optional.of(media()));
        when(sendService.sendImage("acc-1", "wx-1", media())).thenReturn(false);

        String result = tool.execute("{\"image\":\"/tmp/a.png\"}", 1L, 100L, "/ws");
        assertThat(result).contains("context_token");
    }

    @Test
    void success() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.of(target()));
        when(toolSupport.loadBytes("/tmp/a.png", "/ws", SendWechatImageTool.MAX_IMAGE_BYTES))
                .thenReturn(PNG_BYTES);
        when(uploadService.uploadImage(any(), anyString(), any(byte[].class)))
                .thenReturn(Optional.of(media()));
        when(sendService.sendImage("acc-1", "wx-1", media())).thenReturn(true);

        String result = tool.execute("{\"image\":\"/tmp/a.png\"}", 1L, 100L, "/ws");
        assertThat(result).contains("\"success\":true");
        assertThat(result).contains("\"media_type\":\"image\"");
        assertThat(result).contains("\"sent_to\":\"wx-1\"");
    }

    @Test
    void errorJsonReturnedForParseErrors() throws Exception {
        when(toolSupport.errorJson(anyString())).thenReturn("{\"error\":\"mock\"}");
        String result = tool.execute("not-json", 1L, 100L, "/ws");
        assertThat(result).isEqualTo("{\"error\":\"mock\"}");
    }

    private WeixinMediaToolSupport.WechatTarget target() {
        cn.etarch.mao.weixin.entity.WeixinChannelAccount account =
                new cn.etarch.mao.weixin.entity.WeixinChannelAccount();
        account.setAccountId("acc-1");
        account.setUserId(100L);
        return new WeixinMediaToolSupport.WechatTarget("acc-1", "wx-1", account);
    }

    private WeixinMediaUploadService.CdnMedia media() {
        return new WeixinMediaUploadService.CdnMedia("eqp", "aes", 1, 12L, 12, "md5");
    }
}
