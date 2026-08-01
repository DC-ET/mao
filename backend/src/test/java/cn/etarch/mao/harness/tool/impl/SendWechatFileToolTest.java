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
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SendWechatFileToolTest {

    @Mock
    private WeixinMediaToolSupport toolSupport;
    @Mock
    private WeixinMediaUploadService uploadService;
    @Mock
    private WeixinSendService sendService;

    private SendWechatFileTool tool;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        tool = new SendWechatFileTool(objectMapper, toolSupport, uploadService, sendService);
        when(toolSupport.errorJson(anyString())).thenAnswer(inv ->
                "{\"error\":\"" + inv.getArgument(0) + "\"}");
    }

    @Test
    void implementsWeixinChannelTool() {
        assertThat(tool).isInstanceOf(WeixinChannelTool.class);
    }

    @Test
    void missingFileParam() throws Exception {
        String result = tool.execute("{}", 1L, 100L, "/ws");
        assertThat(result).contains("\"error\"");
        assertThat(result).contains("file");
    }

    @Test
    void noResolvableTarget() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.empty());
        String result = tool.execute("{\"file\":\"/tmp/r.pdf\"}", 1L, 100L, "/ws");
        assertThat(result).contains("无法解析微信收件人");
    }

    @Test
    void loadBytesFailure() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.of(target()));
        when(toolSupport.loadBytes("/tmp/r.pdf", "/ws", SendWechatFileTool.MAX_FILE_BYTES))
                .thenThrow(new IllegalArgumentException("文件不存在或不是普通文件: /tmp/r.pdf"));

        String result = tool.execute("{\"file\":\"/tmp/r.pdf\"}", 1L, 100L, "/ws");
        assertThat(result).contains("读取文件失败");
    }

    @Test
    void uploadFailure() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.of(target()));
        when(toolSupport.loadBytes("/tmp/r.pdf", "/ws", SendWechatFileTool.MAX_FILE_BYTES))
                .thenReturn(new byte[]{1, 2, 3});
        when(uploadService.uploadFile(any(), anyString(), any(byte[].class)))
                .thenReturn(Optional.empty());

        String result = tool.execute("{\"file\":\"/tmp/r.pdf\"}", 1L, 100L, "/ws");
        assertThat(result).contains("上传微信 CDN 失败");
    }

    @Test
    void successWithDefaultFileNameFromPath() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.of(target()));
        when(toolSupport.loadBytes("/tmp/r.pdf", "/ws", SendWechatFileTool.MAX_FILE_BYTES))
                .thenReturn(new byte[]{1, 2, 3});
        when(uploadService.uploadFile(any(), anyString(), any(byte[].class)))
                .thenReturn(Optional.of(media()));
        when(sendService.sendFile(eq("acc-1"), eq("wx-1"), any(), eq("r.pdf"))).thenReturn(true);

        String result = tool.execute("{\"file\":\"/tmp/r.pdf\"}", 1L, 100L, "/ws");
        assertThat(result).contains("\"success\":true");
        assertThat(result).contains("\"file_name\":\"r.pdf\"");
    }

    @Test
    void successWithExplicitFileName() throws Exception {
        when(toolSupport.resolveTarget(100L)).thenReturn(Optional.of(target()));
        when(toolSupport.loadBytes("/tmp/r.pdf", "/ws", SendWechatFileTool.MAX_FILE_BYTES))
                .thenReturn(new byte[]{1, 2, 3});
        when(uploadService.uploadFile(any(), anyString(), any(byte[].class)))
                .thenReturn(Optional.of(media()));
        when(sendService.sendFile(eq("acc-1"), eq("wx-1"), any(), eq("报告.pdf"))).thenReturn(true);

        String result = tool.execute("{\"file\":\"/tmp/r.pdf\",\"file_name\":\"报告.pdf\"}", 1L, 100L, "/ws");
        assertThat(result).contains("\"file_name\":\"报告.pdf\"");
    }

    @Test
    void resolveFileName_prefersExplicit() {
        assertThat(SendWechatFileTool.resolveFileName("custom.bin", "https://a.com/x.pdf"))
                .isEqualTo("custom.bin");
    }

    @Test
    void resolveFileName_fallsBackToUrlTail() {
        assertThat(SendWechatFileTool.resolveFileName("", "https://a.com/files/report%20v2.pdf"))
                .isEqualTo("report v2.pdf");
    }

    @Test
    void resolveFileName_fallsBackToPathTail() {
        assertThat(SendWechatFileTool.resolveFileName("", "/tmp/data.xlsx"))
                .isEqualTo("data.xlsx");
    }

    @Test
    void resolveFileName_generatesWithExtension() {
        // URL 尾段为空时回退为 file-<时间戳><扩展名>
        String name = SendWechatFileTool.resolveFileName("", "https://a.com/");
        assertThat(name).matches("file-\\d{8}-\\d{6}");
    }

    @Test
    void tailSegment_stripsQuery() {
        assertThat(SendWechatFileTool.tailSegment("https://a.com/f.pdf?token=1")).isEqualTo("f.pdf");
    }

    @Test
    void tailSegment_handlesTrailingSlash() {
        assertThat(SendWechatFileTool.tailSegment("https://a.com/")).isNull();
    }

    @Test
    void extensionOf() {
        assertThat(SendWechatFileTool.extensionOf("/tmp/a.PDF")).isEqualTo(".pdf");
        assertThat(SendWechatFileTool.extensionOf("/tmp/noext")).isEmpty();
    }

    private WeixinMediaToolSupport.WechatTarget target() {
        cn.etarch.mao.weixin.entity.WeixinChannelAccount account =
                new cn.etarch.mao.weixin.entity.WeixinChannelAccount();
        account.setAccountId("acc-1");
        account.setUserId(100L);
        return new WeixinMediaToolSupport.WechatTarget("acc-1", "wx-1", account);
    }

    private WeixinMediaUploadService.CdnMedia media() {
        return new WeixinMediaUploadService.CdnMedia("eqp", "aes", 1, 3L, 3, "md5");
    }
}
