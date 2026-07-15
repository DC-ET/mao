package cn.etarch.mao.weixin.model;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class QrcodeResponse {

    private String sessionKey;

    private String qrDataUrl;

    private String message;
}