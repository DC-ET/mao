package cn.etarch.mao.weixin.model;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class QrcodeStatusResponse {

    private String status;

    private String botToken;

    private String baseUrl;

    private String ilinkUserId;
}