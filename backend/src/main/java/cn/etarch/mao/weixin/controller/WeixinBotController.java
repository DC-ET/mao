package cn.etarch.mao.weixin.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.weixin.model.BindingStatus;
import cn.etarch.mao.weixin.model.QrcodeResponse;
import cn.etarch.mao.weixin.model.QrcodeStatusResponse;
import cn.etarch.mao.weixin.service.QrLoginService;
import cn.etarch.mao.weixin.service.WeixinAccountRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/v1/weixin")
@RequiredArgsConstructor
public class WeixinBotController {

    private final QrLoginService qrLoginService;
    private final WeixinAccountRepository accountRepository;

    /**
     * 获取微信Bot绑定二维码
     */
    @GetMapping("/qrcode")
    public Result<QrcodeResponse> getQrcode(@AuthenticationPrincipal Long userId) {
        QrcodeResponse response = qrLoginService.getQrcode(userId);
        return Result.ok(response);
    }

    /**
     * 查询扫码状态
     */
    @GetMapping("/qrcode/status")
    public Result<QrcodeStatusResponse> getQrcodeStatus(@RequestParam String sessionKey) {
        QrcodeStatusResponse response = qrLoginService.getQrcodeStatus(sessionKey);
        return Result.ok(response);
    }

    /**
     * 确认绑定
     */
    @PostMapping("/binding/confirm")
    public Result<Void> confirmBinding(@AuthenticationPrincipal Long userId,
                                        @RequestParam String sessionKey,
                                        @RequestParam String botToken,
                                        @RequestParam String baseUrl,
                                        @RequestParam String ilinkUserId) {
        qrLoginService.saveBindingCredentials(userId, botToken, baseUrl, ilinkUserId);
        qrLoginService.clearQrcodeSession(sessionKey);
        return Result.ok();
    }

    /**
     * 获取绑定状态
     */
    @GetMapping("/binding/status")
    public Result<BindingStatus> getBindingStatus(@AuthenticationPrincipal Long userId) {
        BindingStatus status = accountRepository.getBindingStatus(userId);
        return Result.ok(status);
    }

    /**
     * 解绑微信Bot
     */
    @DeleteMapping("/binding")
    public Result<Void> unbind(@AuthenticationPrincipal Long userId) {
        accountRepository.unbind(userId);
        return Result.ok();
    }
}