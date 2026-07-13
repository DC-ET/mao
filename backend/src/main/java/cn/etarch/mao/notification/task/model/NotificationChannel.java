package cn.etarch.mao.notification.task.model;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;

public enum NotificationChannel {
    DINGTALK,
    FEISHU;

    public static NotificationChannel parse(String value) {
        if (value == null || value.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "请选择通知渠道");
        }
        try {
            return valueOf(value.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "通知渠道只支持 DINGTALK 或 FEISHU");
        }
    }
}
