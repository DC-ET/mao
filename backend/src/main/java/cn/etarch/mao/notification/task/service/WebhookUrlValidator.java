package cn.etarch.mao.notification.task.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.notification.task.model.NotificationChannel;
import org.springframework.stereotype.Component;

import java.net.URI;

@Component
public class WebhookUrlValidator {

    public String validate(NotificationChannel channel, String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Webhook 地址不能为空");
        }
        try {
            URI uri = URI.create(rawUrl.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null || uri.getFragment() != null) {
                throw invalid();
            }
            if (channel == NotificationChannel.DINGTALK) {
                if (!"oapi.dingtalk.com".equalsIgnoreCase(uri.getHost())
                        || !"/robot/send".equals(uri.getPath())
                        || queryValue(uri.getRawQuery(), "access_token") == null) {
                    throw invalid();
                }
            } else if (!"open.feishu.cn".equalsIgnoreCase(uri.getHost())
                    || uri.getPath() == null
                    || !uri.getPath().matches("/open-apis/bot/v2/hook/[^/]+")
                    || uri.getRawQuery() != null) {
                throw invalid();
            }
            return uri.toASCIIString();
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw invalid();
        }
    }

    public String mask(String rawUrl) {
        try {
            URI uri = URI.create(rawUrl);
            String value = rawUrl;
            int keep = Math.min(4, Math.max(0, value.length() - value.lastIndexOf('/') - 1));
            String suffix = keep > 0 ? value.substring(value.length() - keep) : "";
            if ("oapi.dingtalk.com".equalsIgnoreCase(uri.getHost())) {
                return "https://oapi.dingtalk.com/robot/send?access_token=****" + suffix;
            }
            return "https://open.feishu.cn/open-apis/bot/v2/hook/****" + suffix;
        } catch (Exception e) {
            return "****";
        }
    }

    private String queryValue(String query, String key) {
        if (query == null) return null;
        for (String part : query.split("&")) {
            int separator = part.indexOf('=');
            if (separator > 0 && key.equals(part.substring(0, separator))
                    && separator < part.length() - 1) {
                return part.substring(separator + 1);
            }
        }
        return null;
    }

    private BusinessException invalid() {
        return new BusinessException(ErrorCode.PARAM_INVALID, "Webhook 地址与所选通知渠道不匹配");
    }
}
