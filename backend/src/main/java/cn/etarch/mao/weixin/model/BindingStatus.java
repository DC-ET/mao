package cn.etarch.mao.weixin.model;

import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@Builder
public class BindingStatus {

    private boolean bound;

    private String accountId;

    private LocalDateTime boundAt;
}