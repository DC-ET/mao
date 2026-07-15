package cn.etarch.mao.weixin.model;

import lombok.Data;

@Data
public class WeixinReply {

    private String text;

    private String mediaUrlOrLocalPath;
}